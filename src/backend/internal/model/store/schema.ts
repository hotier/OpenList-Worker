/**
 * 关系型后端（D1 / MySQL / PostgreSQL / Turso）的表结构定义。
 *
 * 与 Go 后端（OpenList-Backends）完全一致的**列式表**结构：每个字段对应一列，
 * 而非「主键 + data JSON」的键值宽表。字段名对齐 Go 的 `json` tag（snake_case），
 * 因此 D1 / MySQL 中的表结构与 Go 的 GORM 建表结果一致。
 *
 * 类型映射（TS 对象字段 → SQL 列）：
 *   - string → TEXT
 *   - number → INTEGER（id/role/permission/order 等整型）
 *   - bool   → INTEGER（0/1）
 *   - json   → TEXT（数组/对象，序列化为 JSON 字符串）
 *   - date   → TEXT（ISO 8601 时间字符串）
 *
 * 注意：`key` / `order` / `group` / `index` / `write` 等在 SQL 方言中可能是保留字，
 * 所有列名统一按方言加引号（SQLite/MySQL 用反引号，PostgreSQL 用双引号）。
 */
import type { SqlDialect } from "./types"

/**
 * 参与数据往返（load/save）的表。
 *
 * 这些表的内容由 `db.ts` 的配置对象持有，全量读写是有意义的。
 *
 * 注意：**不包含 sshkeys**。TS 侧 SSH 公钥存在 `user.ssh_keys` 内，
 * 从不读写顶层的 `db.sshkeys`；而 Go 后端把公钥存于独立的
 * `x_ssh_public_keys` 表。若把 sshkeys 纳入往返，`sqlFormat.save()` 会执行
 * `DELETE FROM x_ssh_public_keys` 再写入空数组，**清空 Go 写入的 SSH 公钥**。
 * 因此这里刻意排除，只保留其 DDL（见 TABLES），与 Go 共享同一物理库时
 * 既不破坏也不接管该表。
 */
export const TABLE_NAMES = [
  "settings",
  "storages",
  "users",
  "shares",
  "metas",
  "plugins",
] as const

export type TableName = (typeof TABLE_NAMES)[number]

/**
 * 需要建表（DDL）的全部表，含不参与往返的 sshkeys。
 *
 * 与 TABLE_NAMES 分离：建表仍覆盖 sshkeys，便于与 Go 后端共享物理库时
 * 表结构一致；但读写（load/save/batch）只针对 TABLE_NAMES。
 */
export const DDL_TABLE_NAMES = [...TABLE_NAMES, "sshkeys"] as const
export type DdlTableName = (typeof DDL_TABLE_NAMES)[number]

/** 字段类型（决定序列化与 SQL 列类型）。 */
export type FieldType = "string" | "number" | "bool" | "json" | "date"

/** 列定义。 */
export interface ColumnDef {
  /** SQL 列名（snake_case，对齐 Go json tag）。 */
  name: string
  /** 对象字段名（默认与 name 相同）。 */
  key?: string
  /** 字段类型。 */
  type: FieldType
  /** 是否主键。 */
  pk?: boolean
  /** 是否唯一索引。 */
  unique?: boolean
  /** 是否可空（主键默认为不可空）。 */
  nullable?: boolean
}

/** 表定义。 */
export interface TableDef {
  name: DdlTableName
  columns: ColumnDef[]
}

/**
 * 每张表的主键对应的「对象字段名」（用于从实体对象提取主键值）。
 * 供 key 格式（分 key 存储）与 SQL 格式共用。
 *
 * 覆盖全部 DDL 表（含 sshkeys），以便建表与反射逻辑完整；
 * 参与往返的表由 TABLE_NAMES 决定。
 */
export const TABLE_KEY: Record<DdlTableName, string> = {
  settings: "key",
  storages: "id",
  users: "id",
  shares: "id",
  metas: "id",
  plugins: "id",
  sshkeys: "id",
}

/** 主键值统一序列化为字符串，避免数字/字符串 id 混用导致的主键类型漂移。 */
export function keyOf(table: TableName, entity: any): string {
  return String(entity?.[TABLE_KEY[table]] ?? "")
}

/**
 * 完整列式表定义。
 *
 * 字段与 Go 后端模型一一对应（json tag）：
 *   - settings ← model.SettingItem
 *   - storages ← model.Storage
 *   - users    ← model.User（含 TS 特有的 pwd_update_at）
 *   - shares   ← model.SharingDB（Files 序列化自 []string）
 *   - metas    ← model.Meta
 *   - plugins  ← TS 独有（Go 无插件表）
 */
export const TABLES: Record<DdlTableName, TableDef> = {
  settings: {
    name: "settings",
    columns: [
      { name: "key", type: "string", pk: true },
      { name: "value", type: "string", nullable: true },
      { name: "help", type: "string", nullable: true },
      { name: "type", type: "string", nullable: true },
      { name: "options", type: "string", nullable: true },
      { name: "group", type: "number", nullable: true },
      { name: "flag", type: "number", nullable: true },
      { name: "index", type: "number", nullable: true },
    ],
  },

  storages: {
    name: "storages",
    columns: [
      { name: "id", type: "number", pk: true },
      { name: "mount_path", type: "string", unique: true },
      { name: "order", type: "number", nullable: true },
      { name: "driver", type: "string", nullable: true },
      { name: "cache_expiration", type: "number", nullable: true },
      { name: "custom_cache_policies", type: "string", nullable: true },
      { name: "status", type: "string", nullable: true },
      { name: "addition", type: "string", nullable: true },
      { name: "remark", type: "string", nullable: true },
      { name: "modified", type: "date", nullable: true },
      { name: "disabled", type: "bool", nullable: true },
      { name: "disable_index", type: "bool", nullable: true },
      { name: "enable_sign", type: "bool", nullable: true },
      { name: "seed_policy", type: "string", nullable: true },
      { name: "order_by", type: "string", nullable: true },
      { name: "order_direction", type: "string", nullable: true },
      { name: "extract_folder", type: "string", nullable: true },
      { name: "web_proxy", type: "bool", nullable: true },
      { name: "webdav_policy", type: "string", nullable: true },
      { name: "proxy_range", type: "bool", nullable: true },
      { name: "down_proxy_url", type: "string", nullable: true },
      { name: "disable_proxy_sign", type: "bool", nullable: true },
    ],
  },

  users: {
    name: "users",
    columns: [
      { name: "id", type: "number", pk: true },
      { name: "username", type: "string", unique: true },
      { name: "password", type: "string", nullable: true },
      { name: "base_path", type: "string", nullable: true },
      { name: "role", type: "number", nullable: true },
      { name: "disabled", type: "bool", nullable: true },
      { name: "permission", type: "number", nullable: true },
      { name: "salt", type: "string", nullable: true },
      { name: "otp_secret", type: "string", nullable: true },
      { name: "sso_id", type: "string", nullable: true },
      { name: "authn", type: "string", nullable: true },  // WebAuthn credentials JSON
      { name: "allow_ldap", type: "bool", nullable: true },
      // TS 特有：密码更新时间（Go 用 pwd_ts/pwd_hash/salt 内部字段，json:"-" 不落 API）
      { name: "pwd_update_at", type: "date", nullable: true },
    ],
  },

  shares: {
    name: "shares",
    columns: [
      { name: "id", type: "string", pk: true },
      // Go 的 SharingDB.FilesRaw（json:"-" 但落库，列名 files_raw）存 []string 的 JSON；
      // TS 业务对象字段名为 files，通过 key 字段解耦列名与对象字段名。
      { name: "files_raw", key: "files", type: "json", nullable: true },
      { name: "expires", type: "date", nullable: true },
      { name: "pwd", type: "string", nullable: true },
      { name: "accessed", type: "number", nullable: true },
      { name: "max_accessed", type: "number", nullable: true },
      { name: "creator_id", type: "number", nullable: true },
      { name: "disabled", type: "bool", nullable: true },
      { name: "remark", type: "string", nullable: true },
      { name: "readme", type: "string", nullable: true },
      { name: "header", type: "string", nullable: true },
      { name: "order_by", type: "string", nullable: true },
      { name: "order_direction", type: "string", nullable: true },
      { name: "extract_folder", type: "string", nullable: true },
    ],
  },

  metas: {
    name: "metas",
    columns: [
      { name: "id", type: "number", pk: true },
      { name: "path", type: "string", unique: true },
      { name: "read_users", type: "json", nullable: true },
      { name: "read_users_sub", type: "bool", nullable: true },
      { name: "write_users", type: "json", nullable: true },
      { name: "write_users_sub", type: "bool", nullable: true },
      { name: "password", type: "string", nullable: true },
      { name: "p_sub", type: "bool", nullable: true },
      { name: "write", type: "bool", nullable: true },
      { name: "w_sub", type: "bool", nullable: true },
      { name: "hide", type: "string", nullable: true },
      { name: "h_sub", type: "bool", nullable: true },
      { name: "readme", type: "string", nullable: true },
      { name: "r_sub", type: "bool", nullable: true },
      { name: "header", type: "string", nullable: true },
      { name: "header_sub", type: "bool", nullable: true },
    ],
  },

  sshkeys: {
    name: "sshkeys",
    columns: [
      { name: "id", type: "number", pk: true },
      { name: "user_id", type: "number", nullable: true },   // json:"-" 不走 API 但落库
      { name: "title", type: "string", nullable: true },
      { name: "fingerprint", type: "string", nullable: true },
      { name: "key_str", type: "string", nullable: true },   // gorm:"type:text" json:"-"
      { name: "added_time", type: "date", nullable: true },
      { name: "last_used_time", type: "date", nullable: true },
    ],
  },

  plugins: {
    name: "plugins",
    columns: [
      { name: "id", type: "string", pk: true },
      { name: "name", type: "string", nullable: true },
      { name: "version", type: "string", nullable: true },
      { name: "description", type: "string", nullable: true },
      { name: "author", type: "string", nullable: true },
      { name: "homepage", type: "string", nullable: true },
      { name: "repository", type: "string", nullable: true },
      { name: "icon", type: "string", nullable: true },
      { name: "type", type: "string", nullable: true },
      { name: "enabled", type: "bool", nullable: true },
      { name: "high_privilege", type: "bool", nullable: true },
      { name: "permissions", type: "json", nullable: true },
      { name: "entry_url", type: "string", nullable: true },
      { name: "script_content", type: "string", nullable: true },
      { name: "style_content", type: "string", nullable: true },
      { name: "config_schema", type: "json", nullable: true },
      { name: "config_values", type: "json", nullable: true },
      { name: "target_hooks", type: "json", nullable: true },
      { name: "is_builtin", type: "bool", nullable: true },
      { name: "tags", type: "json", nullable: true },
      { name: "created_at", type: "date", nullable: true },
      { name: "updated_at", type: "date", nullable: true },
    ],
  },
}

/**
 * SQL 表名映射：TS 分组名 → Go 的 GORM 复数表名（不含前缀）。
 *
 * Go 用 GORM 默认命名策略：结构体名 snake_case + 复数，例如：
 *   - SettingItem → setting_items
 *   - SharingDB   → sharing_dbs
 *   - Storage → storages / User → users / Meta → metas
 *
 * TS 内部对象分组仍用 settings/shares（对齐 db.ts 的对象字段名），落库时
 * 通过本映射转换为 Go 的复数表名，实现与 Go 后端共享同一数据库。
 *
 * plugins 为 TS 独有（Go 无插件表），沿用复数名 plugins。
 */
export const TABLE_SQL_NAMES: Record<DdlTableName, string> = {
  settings: "setting_items",
  storages: "storages",
  users: "users",
  shares: "sharing_dbs",
  metas: "metas",
  plugins: "plugins",
  sshkeys: "ssh_public_keys",
}

/**
 * 表前缀，固定为 "x_"（对齐 Go 后端的默认值）。
 */
export function getTablePrefix(_env?: any): string {
  return "x_"
}

/**
 * 返回某张表在 SQL 中的完整表名（前缀 + 复数名）。
 */
export function tableSqlName(table: DdlTableName, env?: any): string {
  return getTablePrefix(env) + TABLE_SQL_NAMES[table]
}

/**
 * 对象字段值 → SQL 列值。
 *
 * @param dialect 目标方言。bool 列在 PostgreSQL 里是原生 BOOLEAN，写入 0/1
 *   虽然能靠 PG 的输入函数隐式接受，但 pg 驱动会把 JS number 当文本发送，
 *   遇到严格模式或未来 PG 版本收紧时会失败；这里直接给 true/false 最稳。
 */
export function serializeColumn(
  col: ColumnDef,
  value: any,
  dialect: SqlDialect = "sqlite",
): any {
  if (value === undefined || value === null) {
    // 主键不能为 null，直接返回 null 让调用方处理
    if (col.pk) return null
    // 可空列（nullable: true）直接存 null
    if (col.nullable) return null
    // 其余列（旧表可能有 NOT NULL 约束）按类型返回无害默认值
    switch (col.type) {
      case "string": return ""
      case "number": return 0
      case "bool":   return dialect === "postgres" ? false : 0
      case "json":   return "null"
      case "date":   return ""
      default:       return ""
    }
  }
  switch (col.type) {
    case "string":
      return String(value)
    case "number":
      return typeof value === "number" ? value : Number(value)
    case "bool":
      return dialect === "postgres" ? Boolean(value) : value ? 1 : 0
    case "json":
      return typeof value === "string" ? value : JSON.stringify(value)
    case "date": {
      if (value instanceof Date) return value.toISOString()
      if (typeof value === "number") return new Date(value).toISOString()
      return String(value)
    }
    default:
      return value
  }
}

/**
 * SQL 列值 → 对象字段值。
 *
 * bool 反序列化必须同时接受布尔与 0/1：SQLite/MySQL 存整数，PostgreSQL 存
 * 原生 boolean，pg 驱动会直接返回 JS boolean。
 */
export function deserializeColumn(col: ColumnDef, value: any): any {
  if (value === undefined || value === null) {
    if (col.type === "json") return null
    return null
  }
  switch (col.type) {
    case "string": {
      const s = String(value)
      // 空字符串视为 null，避免 "" 被当作有效密码/哈希值
      return s === "" ? null : s
    }
    case "number":
      return Number(value)
    case "bool":
      return value === 1 || value === "1" || value === true || value === "true"
    case "json": {
      if (typeof value !== "string") return value
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    }
    case "date":
      // PostgreSQL 的 TEXT 列返回字符串；若将来把 date 改成 TIMESTAMPTZ，
      // pg 会返回 Date 对象，统一转成 ISO 字符串以保持与其它方言一致。
      if (value instanceof Date) return value.toISOString()
      return value
    default:
      return value
  }
}

/**
 * 将一行 SQL 记录（SELECT * 结果）转换回对象。
 *
 * 跳过 null/undefined 列：列式表的「缺失字段」以 NULL 存储，反序列化时不
 * 输出这些字段，避免 roundtrip 后对象被注入大量 null 键（与 map/key 格式
 * 的对象形态保持一致）。
 */
export function rowToEntity(table: DdlTableName, row: any): any {
  const def = TABLES[table]
  const out: any = {}
  for (const col of def.columns) {
    const key = col.key ?? col.name
    const value = deserializeColumn(col, row[col.name])
    if (value !== null && value !== undefined) {
      out[key] = value
    }
  }
  return out
}

/**
 * 将对象转换为 INSERT 的列与参数。
 *
 * @param dialect 决定 bool 列的编码形态（见 serializeColumn）。
 */
export function entityToRow(
  table: DdlTableName,
  entity: any,
  dialect: SqlDialect = "sqlite",
): {
  columns: string[]
  values: any[]
} {
  const def = TABLES[table]
  const columns: string[] = []
  const values: any[] = []
  for (const col of def.columns) {
    const key = col.key ?? col.name
    columns.push(col.name)
    values.push(serializeColumn(col, entity?.[key], dialect))
  }
  return { columns, values }
}

/** SQL 列类型 → 方言类型。 */
function sqlType(col: ColumnDef, dialect: SqlDialect): string {
  switch (col.type) {
    case "number":
      // Postgres 的 INTEGER 是 32 位；id 与 role 等用 BIGINT 更安全，
      // 与 MySQL 分支保持一致（避免大 id 溢出后静默截断）。
      return dialect === "sqlite" ? "INTEGER" : "BIGINT"
    case "bool":
      // Postgres 有原生 BOOLEAN；SQLite/MySQL 用整数 0/1。
      return dialect === "postgres"
        ? "BOOLEAN"
        : dialect === "mysql"
          ? "TINYINT(1)"
          : "INTEGER"
    case "string":
    case "json":
    case "date":
      return "TEXT"
    default:
      return "TEXT"
  }
}

/**
 * 标识符引用。
 *
 * - SQLite / MySQL：反引号（SQLite 同时接受反引号与双引号，MySQL 只接受反引号）
 * - PostgreSQL：双引号（反引号在 PG 里是语法错误）
 */
function quote(name: string, dialect: SqlDialect = "sqlite"): string {
  if (dialect === "postgres") return '"' + name + '"'
  return "`" + name + "`"
}

/**
 * 生成单张表的建表语句（含主键与唯一索引）。
 */
function buildTableDdl(
  def: TableDef,
  dialect: SqlDialect,
  tableName: string,
): string {
  const parts: string[] = []
  for (const col of def.columns) {
    let line = `${quote(col.name, dialect)} ${sqlType(col, dialect)}`
    if (col.pk) {
      line += " PRIMARY KEY"
    } else if (!col.nullable) {
      line += " NOT NULL"
    }
    if (col.unique) {
      line += " UNIQUE"
    }
    parts.push(line)
  }
  return `CREATE TABLE IF NOT EXISTS ${quote(tableName, dialect)} (${parts.join(", ")})`
}

/**
 * 生成 schema_info 表（标记 SQL 格式是否已初始化）。
 */
function buildSchemaInfoDdl(dialect: SqlDialect): string {
  // 主键列类型：MySQL 需要长度上限的 VARCHAR，SQLite/PG 用 TEXT 即可。
  const k = dialect === "mysql" ? "VARCHAR(255)" : "TEXT"
  const v = "TEXT"
  return `CREATE TABLE IF NOT EXISTS ${quote("schema_info", dialect)} (${quote("k", dialect)} ${k} PRIMARY KEY, ${quote("v", dialect)} ${v})`
}

/**
 * 生成完整的建表语句数组（幂等）。表名固定为 "x_" 前缀（对齐 Go），
 * 复数表名对齐 Go 的 GORM 命名策略。
 */
export function buildDdl(dialect: SqlDialect, env?: any): string[] {
  const out: string[] = [buildSchemaInfoDdl(dialect)]
  // 建表覆盖全部 DDL 表（含不参与往返的 sshkeys），保证与 Go 共享库时结构一致
  for (const name of DDL_TABLE_NAMES) {
    out.push(buildTableDdl(TABLES[name], dialect, tableSqlName(name, env)))
  }
  return out
}

/** 兼容旧导出：SQLite（Cloudflare D1）方言建表语句。 */
export const D1_SCHEMA: string[] = buildDdl("sqlite")

/** 兼容旧导出：MySQL 方言建表语句。 */
export const MYSQL_SCHEMA: string[] = buildDdl("mysql")

/** PostgreSQL 方言建表语句。 */
export const POSTGRES_SCHEMA: string[] = buildDdl("postgres")

/**
 * KV 表（供 map/key 格式做键值存储）的建表语句。
 *
 * 与「列式表」分离：map/key 格式仍然以键值对方式落盘，sql 格式才用上面的
 * 列式表。驱动层需同时创建这两类表。
 */
export const KV_SCHEMA_SQLITE: string[] = [
  `CREATE TABLE IF NOT EXISTS ${quote("kv")} (${quote("key")} TEXT PRIMARY KEY, ${quote("value")} TEXT NOT NULL)`,
]

export const KV_SCHEMA_MYSQL: string[] = [
  "CREATE TABLE IF NOT EXISTS `kv` (`key` VARCHAR(512) PRIMARY KEY, `value` LONGTEXT NOT NULL)",
]

/**
 * PostgreSQL 的 KV 表。
 *
 * 注意：`key` 与 `value` 都是 PG 的非保留关键字（可作为列名），但仍统一加
 * 双引号以与其余表保持一致，并避免用户设置了 search_path/大小写折叠时踩坑。
 */
export const KV_SCHEMA_POSTGRES: string[] = [
  `CREATE TABLE IF NOT EXISTS "kv" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`,
]
