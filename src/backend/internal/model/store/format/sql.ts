/**
 * SQL 格式适配器（列式表，与 Go 后端完全一致）。
 *
 * 每个字段对应一列，表结构由 schema.ts 的 TABLES 定义。字段名对齐 Go 的
 * json tag，表名通过 TABLE_SQL_NAMES 映射为 Go 的复数名并加上固定前缀 "x_"
 * 前缀（默认 x_），因此 D1 / MySQL / PostgreSQL 中的表结构与 Go 的 GORM
 * 建表结果一致。
 *
 * 方言差异全部集中在下面几个小函数里（引号 / 占位符 / UPSERT），其余逻辑
 * 三方共用：
 *
 *   |          | sqlite        | mysql                  | postgres              |
 *   |----------|---------------|------------------------|-----------------------|
 *   | 标识符   | `name`        | `name`                 | "name"                |
 *   | 占位符   | ?             | ?                      | $1, $2, …             |
 *   | UPSERT   | INSERT OR     | INSERT … ON DUPLICATE  | INSERT … ON CONFLICT  |
 *   |          | REPLACE       | KEY UPDATE             | (pk) DO UPDATE        |
 */
import type { FormatAdapter, Driver, SqlDialect } from "../types"
import {
  TABLE_NAMES,
  TABLE_KEY,
  TABLES,
  TableName,
  tableSqlName,
  rowToEntity,
  entityToRow,
} from "../schema"

const INIT_MARK = "openlist_config"

/**
 * 单条 SQL 语句允许的绑定参数上限（默认值）。
 *
 * Cloudflare D1 的「Maximum bound parameters per query」为 100（DO 的 SQLite
 * 同一限制），超过即报 `D1_ERROR: too many SQL variables`。
 *
 * 批量 UPSERT 每行一条语句（参数数 = 列数，最多 22），不会触发；真正会超限的
 * 只有本文件底部「删除本端已移除的行」用的 `NOT IN (?...)`：它必须把该表全部
 * 保留键塞进同一条语句，而默认配置里 settings 就有 114 条，首次初始化直接 500
 * （issue #180）。
 *
 * 各驱动可通过 `Driver.maxBindParams` 覆盖：Postgres 协议上限 65535，
 * MySQL 也没有 100 这个限制，用 100 会让它们多做几次无谓的分片查询。
 */
const DEFAULT_MAX_BIND_PARAMS = 100

/**
 * 读取驱动的 SQL 方言。
 *
 * 未声明 dialect 的关系型驱动（理论上不该存在）按 sqlite 处理：d1/do 是
 * 历史最久的两个 SQL 驱动，默认值保持与改造前一致，避免静默改变行为。
 */
function dialectOf(driver: Driver): SqlDialect {
  return driver.dialect ?? "sqlite"
}

/** 标识符引用（按方言选反引号或双引号）。 */
function quote(name: string, dialect: SqlDialect = "sqlite"): string {
  if (dialect === "postgres") return '"' + name + '"'
  return "`" + name + "`"
}

/**
 * 生成 n 个占位符。
 *
 * Postgres 用 $1…$n（按顺序编号），SQLite/MySQL 用 ?。
 * 注意：`$n` 的编号是**语句内**从 1 开始计数的，因此分片删除时每片都要
 * 重新从 $1 编号 —— 调用方必须为每片单独调用本函数。
 */
function placeholders(count: number, dialect: SqlDialect): string {
  if (dialect === "postgres") {
    return Array.from({ length: count }, (_, i) => `$${i + 1}`).join(", ")
  }
  return Array.from({ length: count }, () => "?").join(", ")
}

/**
 * 生成 UPSERT 语句。
 *
 * 三种方言语法互不兼容，必须分支：
 *   - SQLite:   INSERT OR REPLACE INTO ...
 *   - MySQL:    INSERT INTO ... ON DUPLICATE KEY UPDATE col = VALUES(col)
 *   - Postgres: INSERT INTO ... ON CONFLICT (pk) DO UPDATE SET col = EXCLUDED.col
 *
 * Postgres 的 ON CONFLICT 必须显式给出冲突目标（主键列），否则报
 * `ON CONFLICT DO UPDATE requires inference specification`。
 *
 * @param pkColumn 主键列名（仅 Postgres 需要）。不传时退化为 DO NOTHING，
 *   用于 schema_info 这类「k/v 两列、k 为主键」的表——调用方都会传。
 */
function upsertSql(
  table: string,
  columns: string[],
  params: any[],
  driver: Driver,
  pkColumn?: string,
): { sql: string; params: any[] } {
  const dialect = dialectOf(driver)
  const cols = columns.map((c) => quote(c, dialect)).join(", ")
  const values = placeholders(columns.length, dialect)

  if (dialect === "mysql") {
    // MySQL 无 INSERT OR REPLACE；用 ON DUPLICATE KEY UPDATE 覆盖全部非主键列。
    // 主键列不参与 UPDATE（写回自身无意义），其余列以 VALUES(col) 覆盖。
    const updates = columns
      .slice(1)
      .map((c) => `${quote(c, dialect)} = VALUES(${quote(c, dialect)})`)
      .join(", ")
    const sql = updates
      ? `INSERT INTO ${table} (${cols}) VALUES (${values}) ON DUPLICATE KEY UPDATE ${updates}`
      : `INSERT INTO ${table} (${cols}) VALUES (${values})`
    return { sql, params }
  }

  if (dialect === "postgres") {
    // Postgres：冲突目标必须显式声明。pkColumn 缺省时用 DO NOTHING（幂等即可）。
    const updates = columns
      .slice(1)
      .map(
        (c) =>
          `${quote(c, dialect)} = EXCLUDED.${quote(c, dialect)}`,
      )
      .join(", ")
    if (!pkColumn || !updates) {
      const conflict = pkColumn
        ? ` ON CONFLICT (${quote(pkColumn, dialect)}) DO NOTHING`
        : " ON CONFLICT DO NOTHING"
      return {
        sql: `INSERT INTO ${table} (${cols}) VALUES (${values})${conflict}`,
        params,
      }
    }
    return {
      sql:
        `INSERT INTO ${table} (${cols}) VALUES (${values}) ` +
        `ON CONFLICT (${quote(pkColumn, dialect)}) DO UPDATE SET ${updates}`,
      params,
    }
  }

  return {
    sql: `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${values})`,
    params,
  }
}

/** 带前缀+复数的完整表名（含方言引号）。 */
function qn(table: TableName, env?: any, dialect: SqlDialect = "sqlite"): string {
  return quote(tableSqlName(table, env), dialect)
}

/** 列名列表（含方言引号）。 */
function cols(table: TableName, dialect: SqlDialect = "sqlite"): string {
  return TABLES[table].columns.map((c) => quote(c.name, dialect)).join(", ")
}

/**
 * 读取某表当前的主键集合（统一字符串化，避免数字/字符串主键比较失真）。
 *
 * 只在大表删除已移除行时使用：`NOT IN` 的分片在语义上不可行（把保留键拆成
 * 多片后，每片都会把其余片的保留行当成"已移除"删掉），因此改为先取现有主键、
 * 在内存里求差集，再按 `IN` 分片删除。
 */
async function listKeys(
  driver: Driver,
  table: TableName,
  keyCol: string,
  env?: any,
): Promise<string[]> {
  if (!driver.query) return []
  const dialect = dialectOf(driver)
  const rows = await driver.query(
    `SELECT ${quote(keyCol, dialect)} AS k FROM ${qn(table, env, dialect)}`,
    [],
    env,
  )
  return (rows || [])
    .map((r: any) => (r?.k === undefined || r?.k === null ? "" : String(r.k)))
    .filter((k: string) => k !== "")
}

export const sqlFormat: FormatAdapter = {
  name: "sql",

  async load(driver: Driver, env?: any): Promise<any | null> {
    if (!driver.query) {
      throw new Error(`Driver ${driver.name} does not support SQL queries`)
    }
    const dialect = dialectOf(driver)

    // 检查是否已初始化（schema_info 为 TS 内部标记表，不加前缀）
    const marks = await driver.query(
      `SELECT ${quote("v", dialect)} FROM ${quote("schema_info", dialect)} WHERE ${quote("k", dialect)} = ${dialect === "postgres" ? "$1" : "?"}`,
      [INIT_MARK],
      env,
    )
    if (!marks || marks.length === 0) return null

    const out: Record<string, any> = {}

    for (const table of TABLE_NAMES) {
      const rows = await driver.query(
        `SELECT * FROM ${qn(table, env, dialect)}`,
        [],
        env,
      )
      out[table] = rows.map((r: any) => rowToEntity(table, r))
    }

    return out
  },

  async save(data: any, driver: Driver, env?: any): Promise<boolean> {
    if (!driver.batch) {
      throw new Error(`Driver ${driver.name} does not support batch operations`)
    }
    const dialect = dialectOf(driver)
    const maxBindParams = driver.maxBindParams ?? DEFAULT_MAX_BIND_PARAMS

    const statements: Array<{ sql: string; params: any[] }> = []

    // 策略：**UPSERT 每行 + 删除已不存在的行**，而非「先清空再插入」。
    //
    // 为什么不用 DELETE 全表：DELETE 与 INSERT 之间存在「表为空」的窗口，
    // 若批量执行中途失败，数据会整体丢失；与 Go 后端共享同一物理库时，
    // DELETE 还会清掉 Go 侧并发写入的行。
    //
    // UPSERT 保证既有行先被覆盖（不丢数据），再删除本端不再持有的键。
    // 注意：仍需按主键比对以删除"本端删除了的记录"，且该删除是必要的，
    // 否则历史残留行不会被清理。
    for (const table of TABLE_NAMES) {
      const keyCol = TABLE_KEY[table]
      const entities: any[] = data?.[table] || []
      const keepKeys: string[] = []

      for (const entity of entities) {
        const { columns, values } = entityToRow(table, entity, dialect)
        const upsert = upsertSql(
          qn(table, env, dialect),
          columns,
          values,
          driver,
          keyCol,
        )
        statements.push({ sql: upsert.sql, params: upsert.params })

        const pk = entity?.[keyCol]
        if (pk !== undefined && pk !== null) keepKeys.push(String(pk))
      }

      // 删除本端已移除的行（keys 为空则整表清空，与原语义一致）
      if (keepKeys.length === 0) {
        statements.push({
          sql: `DELETE FROM ${qn(table, env, dialect)}`,
          params: [],
        })
      } else if (keepKeys.length <= maxBindParams || !driver.query) {
        statements.push({
          sql: `DELETE FROM ${qn(table, env, dialect)} WHERE ${quote(keyCol, dialect)} NOT IN (${placeholders(keepKeys.length, dialect)})`,
          params: keepKeys,
        })
      } else {
        // 保留键超过单语句参数上限（默认配置的 settings 就有 114 条）：
        // 直接 NOT IN 会撞 D1 的 100 个绑定参数上限，必须换成差集 + 分片 IN。
        const keep = new Set(keepKeys)
        const stale = (await listKeys(driver, table, keyCol, env)).filter(
          (k) => !keep.has(k),
        )
        for (let i = 0; i < stale.length; i += maxBindParams) {
          const group = stale.slice(i, i + maxBindParams)
          statements.push({
            sql: `DELETE FROM ${qn(table, env, dialect)} WHERE ${quote(keyCol, dialect)} IN (${placeholders(group.length, dialect)})`,
            params: group,
          })
        }
      }
    }

    // 标记已初始化（方言兼容的 UPSERT）
    statements.push(
      upsertSql(
        quote("schema_info", dialect),
        ["k", "v"],
        [INIT_MARK, String(Date.now())],
        driver,
        "k",
      ),
    )

    await driver.batch(statements, env)
    return true
  },

  async getTable(table: string, driver: Driver, env?: any): Promise<any[]> {
    if (!driver.query) {
      throw new Error(`Driver ${driver.name} does not support SQL queries`)
    }
    const t = table as TableName
    const dialect = dialectOf(driver)
    const rows = await driver.query(
      `SELECT * FROM ${qn(t, env, dialect)}`,
      [],
      env,
    )
    return rows.map((r: any) => rowToEntity(t, r))
  },

  async saveTable(
    table: string,
    records: any[],
    driver: Driver,
    env?: any,
  ): Promise<void> {
    if (!driver.batch) {
      throw new Error(`Driver ${driver.name} does not support batch operations`)
    }
    const t = table as TableName
    const dialect = dialectOf(driver)

    const statements: Array<{ sql: string; params: any[] }> = [
      { sql: `DELETE FROM ${qn(t, env, dialect)}`, params: [] },
    ]

    for (const entity of records) {
      const { columns, values } = entityToRow(t, entity, dialect)
      const sql = `INSERT INTO ${qn(t, env, dialect)} (${cols(t, dialect)}) VALUES (${placeholders(columns.length, dialect)})`
      statements.push({ sql, params: values })
    }

    await driver.batch(statements, env)
  },

  async getRecord(
    table: string,
    key: string,
    driver: Driver,
    env?: any,
  ): Promise<any | null> {
    if (!driver.query) {
      throw new Error(`Driver ${driver.name} does not support SQL queries`)
    }
    const t = table as TableName
    const keyCol = TABLE_KEY[t]
    const dialect = dialectOf(driver)
    const rows = await driver.query(
      `SELECT * FROM ${qn(t, env, dialect)} WHERE ${quote(keyCol, dialect)} = ${dialect === "postgres" ? "$1" : "?"}`,
      [key],
      env,
    )
    return rows.length > 0 ? rowToEntity(t, rows[0]) : null
  },

  async saveRecord(
    table: string,
    key: string,
    record: any,
    driver: Driver,
    env?: any,
  ): Promise<void> {
    if (!driver.execute) {
      throw new Error(`Driver ${driver.name} does not support SQL execution`)
    }
    const t = table as TableName
    void key
    const dialect = dialectOf(driver)

    const { columns, values } = entityToRow(t, record, dialect)
    // 方言兼容的 UPSERT（SQLite: INSERT OR REPLACE / MySQL: ON DUPLICATE KEY
    // UPDATE / Postgres: ON CONFLICT (pk) DO UPDATE）
    const { sql } = upsertSql(
      qn(t, env, dialect),
      columns,
      values,
      driver,
      TABLE_KEY[t],
    )

    await driver.execute(sql, values, env)
  },

  async deleteRecord(
    table: string,
    key: string,
    driver: Driver,
    env?: any,
  ): Promise<void> {
    if (!driver.execute) {
      throw new Error(`Driver ${driver.name} does not support SQL execution`)
    }
    const t = table as TableName
    const keyCol = TABLE_KEY[t]
    const dialect = dialectOf(driver)
    await driver.execute(
      `DELETE FROM ${qn(t, env, dialect)} WHERE ${quote(keyCol, dialect)} = ${dialect === "postgres" ? "$1" : "?"}`,
      [key],
      env,
    )
  },
}
