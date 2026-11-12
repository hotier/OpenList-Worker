/**
 * Turso 驱动（libSQL / SQLite 方言，走 HTTP Pipeline API）。
 *
 * ## 为什么用 HTTP API 而不是 @libsql/client
 *
 * Turso 提供两条接入路径：
 *   1. `@libsql/client` —— 依赖 libsql 原生/WebAssembly 实现，体积大，
 *      在 Cloudflare Workers / EdgeOne 云函数这类边缘运行时里需要额外的
 *      wasm 加载配置，且 `@libsql/client/web` 与 node 版本行为有差异。
 *   2. **HTTP Pipeline API** —— 纯 `fetch`，零依赖、零 wasm，所有支持
 *      `fetch` 的运行时都能跑。
 *
 * 本项目要同时支持 Cloudflare Workers、EdgeOne Node 云函数、ESA 与自托管
 * Node，因此选 2。代价是需要自己拼协议报文（见下方 `pipeline()`）。
 *
 * ## 环境变量
 *
 *   TURSO_DATABASE_URL   必填，libSQL 的 HTTPS 端点，形如
 *                        `https://<db>-<org>.turso.io`
 *                        （也接受 `libsql://…`，会自动改写成 https）
 *   TURSO_AUTH_TOKEN     必填，数据库访问令牌
 *
 * ## 协议
 *
 * `POST {url}/v2/pipeline`，请求体：
 *   {
 *     requests: [
 *       { type: "execute", stmt: { sql, args: [{type, value}], want_rows: true } },
 *       { type: "close" }
 *     ]
 *   }
 *
 * 参数必须带类型标签（`text` / `integer` / `float` / `null` / `blob`），
 * 裸 JSON 值会被服务端拒绝。返回值同理，需要按 `type` 解包。
 *
 * 详见 https://docs.turso.tech/sdk/http/reference
 */
import type { Driver } from "../types"
import { buildDdl, KV_SCHEMA_SQLITE } from "../schema"

/** libSQL HTTP API 的单个绑定参数。 */
type TursoArg =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "float"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; base64: string }

/** libSQL 返回的列值。 */
interface TursoValue {
  type: "null" | "integer" | "float" | "text" | "blob"
  value?: string | number
  base64?: string
}

interface TursoExecuteResult {
  type: "ok"
  response: {
    type: "execute"
    result: {
      cols: Array<{ name: string; decltype: string | null }>
      rows: TursoValue[][]
      affected_row_count: number
      last_insert_rowid: string | null
    }
  }
}

interface TursoErrorResult {
  type: "error"
  error: { message: string; code?: string }
}

type TursoResult = TursoExecuteResult | TursoErrorResult

/** 读取 Turso 配置；缺任一必填项返回 null（表示未配置）。 */
function getTursoConfig(env: any): {
  url: string
  token: string
} | null {
  const e = env || (typeof process !== "undefined" ? process.env : {}) || {}
  const rawUrl = String(e?.TURSO_DATABASE_URL || "").trim()
  const token = String(e?.TURSO_AUTH_TOKEN || "").trim()
  if (!rawUrl || !token) return null

  // libsql:// 与 https:// 等价；统一改写成 https 以便 fetch 直接使用。
  // 也接受带尾部斜杠的形式，避免拼出 `//v2/pipeline`。
  let url = rawUrl
    .replace(/^libsql:\/\//i, "https://")
    .replace(/^wss:\/\//i, "https://")
    .replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(url)) return null

  return { url, token }
}

/**
 * JS 值 → libSQL 绑定参数。
 *
 * 整数与浮点必须分开：libSQL 的 `integer` 接受字符串形态的 64 位整数，
 * 而 `float` 只接受 JSON number。把 1.5 标成 integer 会被服务端拒绝，
 * 把大整数标成 float 会丢精度。
 */
function toArg(v: any): TursoArg {
  if (v === null || v === undefined) return { type: "null" }
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" }
  if (typeof v === "number") {
    if (Number.isInteger(v)) return { type: "integer", value: String(v) }
    return { type: "float", value: v }
  }
  if (typeof v === "bigint") return { type: "integer", value: v.toString() }
  if (v instanceof Uint8Array) {
    // Buffer 也是 Uint8Array，统一走 blob
    return { type: "blob", base64: Buffer.from(v).toString("base64") }
  }
  return { type: "text", value: String(v) }
}

/** libSQL 列值 → JS 值。 */
function fromValue(v: TursoValue): any {
  switch (v.type) {
    case "null":
      return null
    case "integer":
      // 用 Number 而非 BigInt：本项目所有整型列（id/role/order…）都在
      // Number 的安全整数范围内，转成 BigInt 会让下游 JSON 序列化失败。
      return Number(v.value)
    case "float":
      return Number(v.value)
    case "text":
      return String(v.value ?? "")
    case "blob":
      return v.base64 ?? ""
    default:
      return null
  }
}

/** 行数组 + 列名 → 对象数组（与其它驱动的 query 返回值形态一致）。 */
function rowsToObjects(
  cols: Array<{ name: string }>,
  rows: TursoValue[][],
): any[] {
  return (rows || []).map((row) => {
    const obj: any = {}
    for (let i = 0; i < cols.length; i++) {
      obj[cols[i].name] = fromValue(row[i])
    }
    return obj
  })
}

/**
 * 执行一批语句（HTTP Pipeline）。
 *
 * 语义说明：pipeline 里的语句**按顺序执行**，但**不构成事务**——某条失败后
 * 前面的语句已经生效。这与 `batch()` 需要的「整体成功或整体失败」不符，
 * 因此真正的批量写入走 `transaction()`（BEGIN/COMMIT 包在同一个 pipeline 里，
 * 由服务端保证原子性）。
 *
 * @returns 每条语句的结果（顺序与入参一致）
 */
async function pipeline(
  cfg: { url: string; token: string },
  statements: Array<{ sql: string; params: any[] }>,
): Promise<TursoResult[]> {
  const requests: any[] = statements.map((s) => ({
    type: "execute",
    stmt: {
      sql: s.sql,
      args: (s.params || []).map(toArg),
      want_rows: true,
    },
  }))
  // 显式 close，避免服务端保持连接导致响应延迟（官方推荐）
  requests.push({ type: "close" })

  let res: Response
  try {
    res = await fetch(`${cfg.url}/v2/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    })
  } catch (e: any) {
    const causeCode = e?.cause?.code || e?.cause?.cause?.code
    throw new Error(
      `[turso] request failed${causeCode ? ` (${causeCode})` : ""}: ${e?.message || e}`,
    )
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(
      `[turso] HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
    )
  }

  const body: any = await res.json().catch(() => null)
  const results: TursoResult[] = body?.results || []

  // 逐条检查错误：pipeline 的 HTTP 状态码恒为 200，错误藏在 results 里
  for (const r of results) {
    if (r?.type === "error") {
      const msg = r.error?.message || "unknown error"
      const code = r.error?.code ? ` [${r.error.code}]` : ""
      throw new Error(`[turso] ${msg}${code}`)
    }
  }

  return results
}

let _schemaInited = false

async function ensureSchema(cfg: { url: string; token: string }, env?: any) {
  if (_schemaInited) return
  // KV 表（map/key 格式）+ 列式表（sql 格式）一并创建
  const ddls = [...KV_SCHEMA_SQLITE, ...buildDdl("sqlite", env)]
  await pipeline(
    cfg,
    ddls.map((sql) => ({ sql, params: [] })),
  )
  _schemaInited = true
}

export const tursoDriver: Driver = {
  name: "turso",
  // libSQL 与 SQLite 语法兼容（INSERT OR REPLACE 等）
  dialect: "sqlite",
  // libSQL 单条语句的绑定参数上限远高于 D1 的 100，但官方未给出精确数字；
  // 保守取 SQLite 编译期默认的 999，既不会误触发 D1 那套激进分片，
  // 也不会撞到真实上限。
  maxBindParams: 999,

  async isAvailable(env?: any): Promise<boolean> {
    return getTursoConfig(env) != null
  },

  async init(env?: any): Promise<void> {
    const cfg = getTursoConfig(env)
    if (!cfg) return
    await ensureSchema(cfg, env)
  },

  async get(key: string, env?: any): Promise<string | null> {
    const cfg = getTursoConfig(env)
    if (!cfg) throw new Error("Turso is not configured")
    await ensureSchema(cfg, env)

    const results = await pipeline(cfg, [
      { sql: "SELECT value FROM kv WHERE key = ?", params: [key] },
    ])
    const r = results[0] as TursoExecuteResult
    const rows = r?.response?.result?.rows || []
    if (rows.length === 0) return null
    return fromValue(rows[0][0])
  },

  async put(key: string, value: string, env?: any): Promise<void> {
    const cfg = getTursoConfig(env)
    if (!cfg) throw new Error("Turso is not configured")
    await ensureSchema(cfg, env)

    await pipeline(cfg, [
      {
        sql: "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
        params: [key, value],
      },
    ])
  },

  async delete(key: string, env?: any): Promise<void> {
    const cfg = getTursoConfig(env)
    if (!cfg) throw new Error("Turso is not configured")
    await ensureSchema(cfg, env)

    await pipeline(cfg, [{ sql: "DELETE FROM kv WHERE key = ?", params: [key] }])
  },

  async list(prefix: string, env?: any): Promise<string[]> {
    const cfg = getTursoConfig(env)
    if (!cfg) throw new Error("Turso is not configured")
    await ensureSchema(cfg, env)

    // LIKE 的通配符转义：前缀里的 % 与 _ 是 LIKE 元字符，必须转义，
    // 否则 prefix="a_b" 会误匹配 "axb"。ESCAPE 子句声明转义符。
    const escaped = String(prefix).replace(/([%_\\])/g, "\\$1")
    const results = await pipeline(cfg, [
      {
        sql: "SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key",
        params: [`${escaped}%`],
      },
    ])
    const r = results[0] as TursoExecuteResult
    const rows = r?.response?.result?.rows || []
    return rows.map((row) => String(fromValue(row[0])))
  },

  async query(sql: string, params: any[], env?: any): Promise<any[]> {
    const cfg = getTursoConfig(env)
    if (!cfg) throw new Error("Turso is not configured")
    await ensureSchema(cfg, env)

    const results = await pipeline(cfg, [{ sql, params }])
    const r = results[0] as TursoExecuteResult
    const result = r?.response?.result
    if (!result) return []
    return rowsToObjects(result.cols || [], result.rows || [])
  },

  async execute(sql: string, params: any[], env?: any): Promise<void> {
    const cfg = getTursoConfig(env)
    if (!cfg) throw new Error("Turso is not configured")
    await ensureSchema(cfg, env)

    await pipeline(cfg, [{ sql, params }])
  },

  async batch(
    statements: Array<{ sql: string; params: any[] }>,
    env?: any,
  ): Promise<void> {
    const cfg = getTursoConfig(env)
    if (!cfg) throw new Error("Turso is not configured")
    await ensureSchema(cfg, env)

    // 用显式事务保证「整体成功或整体失败」。
    //
    // 不能直接依赖 pipeline 的顺序执行：它不构成事务，中途失败会留下
    // 半成品（而 sqlFormat.save 的语义要求可整体重跑收敛，半成品虽然
    // 幂等可恢复，但会产生「读到的配置缺了几张表」的中间态）。
    //
    // 把 BEGIN/COMMIT 与业务语句放进**同一个** pipeline，libSQL 会在
    // 服务端按顺序执行，任一语句报错则整个连接的事务回滚。
    const inTx = [
      { sql: "BEGIN", params: [] as any[] },
      ...statements,
      { sql: "COMMIT", params: [] as any[] },
    ]

    try {
      await pipeline(cfg, inTx)
    } catch (err: any) {
      // 事务已由服务端回滚（连接 close 时未提交的事务自动回滚），
      // 这里只补充上下文，不再尝试显式 ROLLBACK（连接已关闭）。
      throw new Error(
        `[turso] batch failed and was rolled back: ${err?.message || err}`,
      )
    }
  },

  async health(env?: any): Promise<any> {
    const cfg = getTursoConfig(env)
    if (!cfg) {
      return {
        configured: false,
        connected: false,
        platform: "Turso (libSQL HTTP API)",
        mode: "turso",
        error:
          "Turso config not found (expected TURSO_DATABASE_URL and TURSO_AUTH_TOKEN)",
      }
    }

    try {
      await pipeline(cfg, [{ sql: "SELECT 1", params: [] }])
      return {
        configured: true,
        connected: true,
        platform: "Turso (libSQL HTTP API)",
        mode: "turso",
      }
    } catch (err: any) {
      return {
        configured: true,
        connected: false,
        platform: "Turso (libSQL HTTP API)",
        mode: "turso",
        error: err?.message || String(err),
      }
    }
  },
}
