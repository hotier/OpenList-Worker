# 环境变量（存储配置）

> 本文仿照官方文档 [Environment Variables](https://doc.oplist.org/ecosystem/official_worker/guide_env)
> 的结构编写，覆盖本仓库全部存储相关变量。

## 配置变量

### 必选变量

必须配置这些参数：

| 参数名 | 可选值 | 说明 |
| --- | --- | --- |
| `DB_FORMAT` | `map`（默认）、`key`、`sql` | 数据持久化格式 |
| `DB_DRIVER` | `auto`（默认）、`blob`、`cfkv`、`kv`、`d1`、`do`、`mysql`、`postgres`、`turso` | 数据库存储位置 |

### 安全变量

除 `DB_FORMAT` 和 `DB_DRIVER` 外，强烈建议配置以下安全相关变量：

| 变量 | 必要 | 说明 |
| --- | --- | --- |
| `JWT_SECRET` | 推荐 | JWT 签名密钥（≥16 字符），同时用于数据加密与定时任务鉴权；未配置时自动生成并持久化到存储 |
| `ADMIN_PASS` | 可选 | 跳过安装向导，以该密码自动初始化 admin |
| `ALLOW_URLS` | 可选 | CORS 允许白名单（逗号分隔） |

### 其他可选变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MAX_UPLOAD` | `26214400` | 单次整体上传（`/put`、`/form`）大小上限（字节） |
| `MAX_UPPART` | `16777216` | 分片上传单片大小上限（字节） |
| `ASSET_URLS` | — | 前端静态资源 CDN 地址，支持 `$version` 占位符 |
| `ALLOW_SEED` | — | 允许作为种子数据来源的主机白名单 |
| `DB_CIPHER` | `none` | 敏感字段（网盘凭据 / 2FA / 密码哈希）落盘算法：`none` / `aes-256-gcm` / `aes-256-gcm-pbkdf2` / `aes-256-cbc-hmac` / `chacha20-poly1305` / `des-cbc-hmac` / `3des-cbc-hmac` |
| `OPENLIST_FORCE_IPV4_EGRESS` | — | 自托管 Node 遇到 250ms 量级 `ETIMEDOUT` 时设为 `1`（仅 EdgeOne 云函数自动生效，其它平台默认不改变行为） |

## 不同存储格式差异

| `DB_FORMAT` 类型 | 描述 |
| --- | --- |
| `map` | 所有数据存储为一个 JSON，每次访问都需要全部读取，性能较差，但兼容性好 |
| `key` | 单条数据存储为 Key-Value，按需读取，兼容性和性能还行，但不支持索引 |
| `sql` | 数据存储为 SQL-Table，与 Go 后端完全一致，支持索引，功能齐全，但多次读取耗时长 |

## 不同存储驱动差异

| `DB_DRIVER` 类型 | 支持平台 | 说明 |
| --- | --- | --- |
| `auto` | 通用 | 自动检测，优先级：mysql → postgres → turso（需配置连接信息）→ d1 → kv → cfkv → blob → do → memory |
| `blob` | EdgeOne / ESA | EdgeOne 或阿里云 ESA Blob 提供的持久化工具，免费 |
| `cfkv` | 通用 | Cloudflare KV REST API，适用于没有持久化的平台远程调用 |
| `kv` | CF、EO、ESA | KV 数据库，速度快，免费 |
| `d1` | CF | D1 数据库，仅支持 Cloudflare |
| `do` | CF | DO 持久化对象，仅支持 Cloudflare |
| `mysql` | Node | 连接到自己的 MySQL 数据库（Workers 无法直连 TCP） |
| `postgres` | Node | 连接到自己的 PostgreSQL 数据库（Workers 无法直连 TCP） |
| `turso` | 通用 | Turso / libSQL，走 HTTP API，全平台可用（含 Workers） |

## 可选有效组合变量

| `DB_FORMAT` | `DB_DRIVER` | 说明 |
| --- | --- | --- |
| `map` | `auto` | 数据存储为 JSON，自动根据部署环境选择 blob、kv、d1 |
| `map` | `blob` | 数据存储为 JSON，使用 EdgeOne / ESA Blob 持久化存储（推荐） |
| `map` | `cfkv` | 数据存储为 JSON，在非 CF Worker 环境使用远程 CF KV 存储 |
| `map` | `kv` | 数据存储为 JSON，在 CF Worker 环境使用 KV 存储（推荐） |
| `map` | `d1` | 数据存储为 JSON，在 CF Worker 环境使用 D1 存储（不推荐） |
| `map` | `do` | 数据存储为 JSON，在 CF Worker 环境使用 DO 存储（不推荐，可能付费） |
| `key` | `kv` | 数据存储为 Key-Value，在 CF Worker 环境使用 KV 存储（推荐） |
| `key` | `d1` | 数据存储为 Key-Value，在 CF Worker 环境使用 D1 存储（推荐） |
| `key` | `mysql` | 数据存储为 Key-Value，使用 MySQL 存储（不推荐） |
| `sql` | `d1` | 数据存储为 SQL-Table，在 CF Worker 环境使用 D1 存储（推荐） |
| `sql` | `mysql` | 数据存储为 SQL-Table，使用 MySQL 存储 |
| `sql` | `postgres` | 数据存储为 SQL-Table，使用 PostgreSQL 存储 |
| `sql` | `turso` | 数据存储为 SQL-Table，使用 Turso / libSQL 存储 |
| `map` | `postgres` | 数据存储为 JSON，使用 PostgreSQL 存储 |
| `map` | `turso` | 数据存储为 JSON，使用 Turso / libSQL 存储 |
| `key` | `postgres` | 数据存储为 Key-Value，使用 PostgreSQL 存储 |
| `key` | `turso` | 数据存储为 Key-Value，使用 Turso / libSQL 存储 |

## 远程数据库配置项

如果您绑定了 `cfkv`，则需要设置相关变量：

| 变量 | 说明 |
| --- | --- |
| `CF_ACCOUNT` | Cloudflare 账号 ID |
| `CF_KV_UUID` | Cloudflare 绑定的 KV ID |
| `CF_API_KEY` | Cloudflare 具有 KV 权限的 Token |

如果您绑定了 MySQL，则需要设置相关变量：

| 变量 | 说明 |
| --- | --- |
| `MYSQL_URLS` | 地址串，例如：`mysql://user:pass@host:3306/db`，配置后则不需要配置下方变量 |
| `MYSQL_HOST` | 数据库地址 |
| `MYSQL_PORT` | 数据库端口（3306） |
| `MYSQL_USER` | 数据库用户 |
| `MYSQL_PASS` | 数据库密码 |
| `MYSQL_NAME` | 数据库名称 |

如果您绑定了 Turso，则需要设置相关变量：

| 变量 | 说明 |
| --- | --- |
| `TURSO_DATABASE_URL` | 数据库地址，例如：`https://my-db-myorg.turso.io`（也接受 `libsql://…`） |
| `TURSO_AUTH_TOKEN` | 数据库访问令牌（`turso db tokens create <db>`） |

如果您绑定了 PostgreSQL，则需要设置相关变量：

| 变量 | 说明 |
| --- | --- |
| `PG_URL` | 地址串，例如：`postgresql://user:pass@host:5432/db?sslmode=require`，配置后则不需要配置下方变量 |
| `PG_HOST` | 数据库地址 |
| `PG_PORT` | 数据库端口（5432） |
| `PG_USER` | 数据库用户 |
| `PG_PASSWORD` | 数据库密码 |
| `PG_DATABASE` | 数据库名称 |
| `PG_SSL` | 托管库设为 `true`（加密但不校验证书链）；本地 / 内网默认关闭 |

> `DATABASE_URL` 同样可作为 PostgreSQL 连接串，但仅在显式 `DB_DRIVER=postgres`
> 时生效 —— `auto` 探测不读取它，避免误连 PaaS 注入的无关数据库。

## 与 Go 后端共享数据库

`sql` 格式的表名与结构（`x_` 前缀）与 Go 后端完全一致，可共用同一物理库。
字段加密（`DB_CIPHER`）建议保持 `none`，否则 Go 侧读到的敏感字段为密文。
