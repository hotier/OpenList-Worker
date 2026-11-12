/**
 * PostgreSQL 驱动（通用，Node.js 运行时）。
 *
 * 通过 `pg` 动态加载，仅在 Node.js 运行时可用（Cloudflare Workers 无法直接
 * 打开到 PG 的 TCP 连接；边缘环境请用 Turso 或平台自有 KV）。
 *
 * ## 环境变量
 *
 *   PG_URL / DATABASE_URL   连接串（优先），形如
 *                           `postgresql://user:pass@host:5432/dbname?sslmode=require`
 *   PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE, PG_SSL
 *                           分项配置（PG_URL 未设置时使用）
 *   PG_SSL=true             分项模式下启用 TLS（托管库几乎都需要）
 *
 * ## 为什么 `PG_URL` 优先
 *
 * 托管 PG（Neon / Supabase / RDS / 自建）都会给出完整连接串，其中包含
 * SSL 模式、连接参数等分项无法表达的信息。只有连接串缺失时才回退分项，
 * 避免「用户配了 URL 却被分项默认值覆盖」。
 */
import type { Driver } from "../types"
import { buildDdl, KV_SCHEMA_POSTGRES } from "../schema"

function isNode(): boolean {
  return typeof process !== "undefined" && process.release?.name === "node"
}

/**
 * 解析 PG 连接配置。
 *
 * 返回 `string`（连接串）或 `object`（分项）；未配置返回 null。
 */
function getPgConfig(env: any): string | Record<string, any> | null {
  const e = env || (typeof process !== "undefined" ? process.env : {}) || {}

  // 连接串优先（含 sslmode 等分项无法表达的语义）
  const url = String(e?.PG_URL || e?.DATABASE_URL || "").trim()
  if (url) return url

  const host = String(e?.PG_HOST || "").trim()
  if (!host) return null

  const sslRaw = String(e?.PG_SSL ?? "").trim().toLowerCase()
  // sslmode=require 是最常见的托管库要求；分项模式下用 PG_SSL=true 开启。
  // 不默认开启：本地/内网 PG 通常没有证书，强制 TLS 会直接连不上。
  const ssl = sslRaw === "true" || sslRaw === "1" || sslRaw === "require"

  return {
    host,
    port: Number(e?.PG_PORT || 5432),
    user: String(e?.PG_USER || ""),
    password: String(e?.PG_PASSWORD || ""),
    database: String(e?.PG_DATABASE || ""),
    // rejectUnauthorized:false —— 托管 PG 常用自签/中间证书，严格校验会失败。
    // 这与 `sslmode=require`（加密但不验证证书）的语义一致。
    ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  }
}

let _pool: any = null
let _poolKey: string | null = null

/**
 * 获取连接池（按配置指纹缓存）。
 *
 * 动态 import：`pg` 只在 Node 可用，且不应被打包进 Workers/Edge 产物。
 * 与 mysql.ts 保持同一模式。
 */
async function getPool(env: any): Promise<any | null> {
  const config = getPgConfig(env)
  if (!config) return null

  const key = typeof config === "string" ? config : JSON.stringify(config)
  if (_pool && _poolKey === key) return _pool

  const specifier = "pg"
  const mod: any = await import(specifier)
  // pg 的 ESM/CJS 互操作：`import("pg")` 在 Node 下返回 { default: { Pool } }
  const Pool = mod?.Pool || mod?.default?.Pool
  if (typeof Pool !== "function") {
    throw new Error("[postgres] the 'pg' package does not expose a Pool constructor")
  }

  _pool = new Pool(config)
  _poolKey = key
  return _pool
}

let _schemaInitedPrefix: string | null = null

async function ensureSchema(pool: any, env?: any): Promise<void> {
  const mark = "postgres"
  if (_schemaInitedPrefix === mark) return
  // KV 表（map/key 格式）+ 列式表（sql 格式）一并创建
  for (const ddl of [...KV_SCHEMA_POSTGRES, ...buildDdl("postgres", env)]) {
    await pool.query(ddl)
  }
  _schemaInitedPrefix = mark
}

export const postgresDriver: Driver = {
  name: "postgres",
  dialect: "postgres",
  // Postgres 扩展查询协议的参数上限是 65535（int16）。
  // 取 1000 与 SQLite 侧保持同一量级，既避免拼出超大语句，
  // 也远低于协议硬上限。
  maxBindParams: 1000,

  async isAvailable(env?: any): Promise<boolean> {
    if (!isNode()) return false
    return getPgConfig(env) != null
  },

  async init(env?: any): Promise<void> {
    const pool = await getPool(env)
    if (pool) await ensureSchema(pool, env)
  },

  async get(key: string, env?: any): Promise<string | null> {
    const pool = await getPool(env)
    if (!pool) throw new Error("PostgreSQL pool not available")

    await ensureSchema(pool, env)
    // PG 用 $1 占位符（不是 ?）
    const res = await pool.query('SELECT "value" FROM "kv" WHERE "key" = $1', [
      key,
    ])
    return res.rows?.[0]?.value ?? null
  },

  async put(key: string, value: string, env?: any): Promise<void> {
    const pool = await getPool(env)
    if (!pool) throw new Error("PostgreSQL pool not available")

    await ensureSchema(pool, env)
    await pool.query(
      'INSERT INTO "kv" ("key", "value") VALUES ($1, $2) ' +
        'ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"',
      [key, value],
    )
  },

  async delete(key: string, env?: any): Promise<void> {
    const pool = await getPool(env)
    if (!pool) throw new Error("PostgreSQL pool not available")

    await ensureSchema(pool, env)
    await pool.query('DELETE FROM "kv" WHERE "key" = $1', [key])
  },

  async list(prefix: string, env?: any): Promise<string[]> {
    const pool = await getPool(env)
    if (!pool) throw new Error("PostgreSQL pool not available")

    await ensureSchema(pool, env)
    // 转义 LIKE 元字符：前缀里的 % 与 _ 必须当字面量处理
    const escaped = String(prefix).replace(/([%_\\])/g, "\\$1")
    const res = await pool.query(
      `SELECT "key" FROM "kv" WHERE "key" LIKE $1 ESCAPE '\\' ORDER BY "key"`,
      [`${escaped}%`],
    )
    return (res.rows || []).map((r: any) => r.key)
  },

  async query(sql: string, params: any[], env?: any): Promise<any[]> {
    const pool = await getPool(env)
    if (!pool) throw new Error("PostgreSQL pool not available")

    await ensureSchema(pool, env)
    const res = await pool.query(sql, params)
    return res.rows || []
  },

  async execute(sql: string, params: any[], env?: any): Promise<void> {
    const pool = await getPool(env)
    if (!pool) throw new Error("PostgreSQL pool not available")

    await ensureSchema(pool, env)
    await pool.query(sql, params)
  },

  async batch(
    statements: Array<{ sql: string; params: any[] }>,
    env?: any,
  ): Promise<void> {
    const pool = await getPool(env)
    if (!pool) throw new Error("PostgreSQL pool not available")

    await ensureSchema(pool, env)

    // 显式事务：整体成功或整体失败。
    // 必须从同一连接取 client（pool.query 每次可能换连接，事务会失效）。
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      for (const stmt of statements) {
        await client.query(stmt.sql, stmt.params)
      }
      await client.query("COMMIT")
    } catch (err) {
      try {
        await client.query("ROLLBACK")
      } catch {
        // 回滚失败（连接已断）时忽略：事务随连接关闭自动回滚
      }
      throw err
    } finally {
      // release(true) 会销毁连接；仅在连接状态可疑时才需要。
      // 正常路径用普通 release 归还连接池，避免频繁重建连接。
      client.release()
    }
  },

  async health(env?: any): Promise<any> {
    if (!isNode()) {
      return {
        configured: false,
        connected: false,
        platform: "PostgreSQL (pg)",
        mode: "postgres",
        error: "PostgreSQL backend requires Node.js runtime",
      }
    }

    const config = getPgConfig(env)
    if (!config) {
      return {
        configured: false,
        connected: false,
        platform: "PostgreSQL (pg)",
        mode: "postgres",
        error:
          "PostgreSQL config not found (expected PG_URL / DATABASE_URL, or PG_HOST)",
      }
    }

    try {
      const pool = await getPool(env)
      await pool.query("SELECT 1")
      return {
        configured: true,
        connected: true,
        platform: "PostgreSQL (pg)",
        mode: "postgres",
      }
    } catch (err: any) {
      return {
        configured: true,
        connected: false,
        platform: "PostgreSQL (pg)",
        mode: "postgres",
        error: err?.message || String(err),
      }
    }
  },
}
