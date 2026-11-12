# 存储后端配置指南（环境变量全集）

> 适用版本：DB_DRIVER 新增 `turso` / `postgres` 之后（commit `37a38ef`）。
> 本文是**存储维度**的环境变量全集与配置条件；站点级变量（站点名、CDN、种子等）
> 见 [.env.example](../.env.example)。

## 一、三分钟速查

### 1. 选驱动（DB_DRIVER）

| 平台 | 推荐驱动 | 可用驱动 | 不可用驱动 |
|---|---|---|---|
| **Cloudflare Workers** | `d1` | `d1` `kv` `cfkv` `do` `turso` | `blob` `mysql` `postgres` `memory` |
| **EdgeOne Node 云函数** | `blob` | `blob` `kv`(代理) `cfkv` `turso` | `d1` `do` `mysql` `postgres` `memory` |
| **EdgeOne Edge Functions** | — | 只承载 KV 代理（`functions/kv-*`），不跑主应用 | — |
| **阿里云 ESA** | `blob` | `blob` `turso` | `d1` `kv` `cfkv` `do` `mysql` `postgres` `memory` |
| **自托管 Node**（`npm start` / Docker / Vercel Node） | `postgres` | `postgres` `turso` `cfkv` `kv`(若可用) `memory`(仅本地) | `d1` `do` `blob` `mysql`¹ |

¹ MySQL 依赖的 `mysql2` 在 esbuild 构建时被打桩替换（`scripts/build-edge.mjs`
的 `emptyNodeDriverPlugin`，因为它带原生二进制），因此 **esbuild 产物里 MySQL
驱动不可用**。PostgreSQL 使用的 `pg` 是纯 JS，已改为 **external** 而非打桩，
所以自托管（node_modules 存在）可用。

> 边缘环境想用 SQLite 语义的数据库 → 选 `turso`（HTTP API，纯 fetch，
> 零依赖零 wasm）；Cloudflare 上想用 SQLite 语义 → 选 `d1`。

### 2. 三层正交变量

```
DB_DRIVER   →  存到哪里（驱动层）
DB_FORMAT   →  怎么组织数据（格式层）
DB_CIPHER   →  敏感字段如何落盘（加密层，与上面两维正交）
```

| 变量 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `DB_DRIVER` | `auto` `blob` `cfkv` `kv` `d1` `do` `mysql` `postgres` `turso` `memory` | `auto` | `auto` 自动探测；`memory` 仅本地 Node |
| `DB_FORMAT` | `map` `key` `sql` | `map` | 与驱动正交，缺省一律 map（详见下文「格式」） |
| `DB_CIPHER` | `none` `aes-256-gcm` `aes-256-gcm-pbkdf2` `aes-256-cbc-hmac` `chacha20-poly1305` `des-cbc-hmac` `3des-cbc-hmac` | `none` | 只影响敏感字段（网盘凭据、2FA、密码哈希）的落盘形态 |

---

## 二、每个驱动的配置条件

### auto（默认）

无需任何变量。按下方「自动探测顺序」依次探测，全部不可用时：

- **Serverless 环境**：直接报 `NO_STORAGE`，**绝不静默回退内存**（内存写入会随实例销毁而丢失，却返回成功）
- **本地/容器**：回退 `memory`（便于开发调试，数据不持久）

### blob（EdgeOne / ESA 平台存储）

| 变量 | 必填条件 | 说明 |
|---|---|---|
| （无环境变量） | 需要 EdgeOne Blob SDK 存在于运行时，或 ESA 的 `ESA_BLOB` 绑定 | 平台自动注入，配置 `DB_DRIVER=blob` 即可 |

- 仅支持 `DB_FORMAT=map`（Blob 是单文档存储，key 格式摊平后无法落盘）
- 平台矩阵：EdgeOne Node 云函数 ✅ / ESA ✅ / Cloudflare ❌

### kv（KV 语义，含 Cloudflare 绑定与 EdgeOne 代理两种形态）

| 变量 | 必填条件 | 说明 |
|---|---|---|
| KV 绑定 `KV` | Cloudflare Workers：wrangler.jsonc 里 `"kv_namespaces": [{"binding":"KV"}]` | 本地绑定优先，速度最快 |
| `EO_KV_URLS` | EdgeOne Node 云函数：**KV 绑定不会注入 Node 函数**，必须经同部署的 Edge Functions 代理 | 留空自动用当前请求 origin（同部署自调用）；跨域/本地调试才需显式设置 |
| `JWT_SECRET` | EdgeOne 代理形态下必填，且必须与 Edge Function 侧**完全一致** | 不一致时表现为 HTTP 401 |

- 支持 `DB_FORMAT=map` / `key`
- 平台矩阵：Cloudflare ✅（绑定）/ EdgeOne ✅（代理）/ ESA ❌

### cfkv（Cloudflare KV REST API，跨平台）

| 变量 | 必填条件 | 说明 |
|---|---|---|
| `CF_ACCOUNT`（或 `CLOUDFLARE_ACCOUNT_ID`） | 三项均必填 | 账户 ID |
| `CF_KV_UUID`（或 `CLOUDFLARE_KV_NAMESPACE_ID`） | 三项均必填 | KV namespace ID |
| `CF_API_KEY`（或 `CLOUDFLARE_API_TOKEN`） | 三项均必填 | 需 KV 读写权限 |

- 走 REST API，**任何有外网 fetch 的运行时都能用**（EdgeOne / ESA / 自托管）
- 支持 `DB_FORMAT=map` / `key`

### d1（Cloudflare D1，SQLite）

| 变量/绑定 | 必填条件 | 说明 |
|---|---|---|
| D1 绑定 `DB`（或 `OPENLIST_DB`） | wrangler.jsonc：`"d1_databases": [{"binding":"DB", ...}]` | 绑定缺失即 `DRIVER_UNAVAILABLE` |

- 支持 `map` / `key` / `sql`
- 仅 Cloudflare Workers 可用；EdgeOne / ESA 无 D1
- 单条语句绑定参数上限 100，超限会在构建期被 `format/sql.ts` 的分片逻辑规避

### do（Cloudflare Durable Objects，SQLite）

| 变量/绑定 | 必填条件 | 说明 |
|---|---|---|
| DO 绑定 `DO` | wrangler.jsonc：`"durable_objects": {"bindings":[{"name":"DO","class_name":"..."}]}` + 迁移 | 需平台迁移声明 |

- 支持 `map` / `key` / `sql`；仅 Cloudflare

### mysql（MySQL / MariaDB）

| 变量 | 必填条件 | 说明 |
|---|---|---|
| `MYSQL_URLS` | 二选一必填 | 连接串：`mysql://user:pass@host:3306/db` |
| `MYSQL_HOST` + `MYSQL_PORT` + `MYSQL_USER` + `MYSQL_PASS` + `MYSQL_NAME` | 二选一必填 | 分项配置（`MYSQL_PORT` 默认 3306） |

- ⚠️ **esbuild 产物里不可用**：`mysql2` 带原生二进制依赖，构建时被 `emptyNodeDriverPlugin` 打桩替换。只有直接以源码运行（`tsx src/…`）才可用
- 仅 Node 运行时；Workers 无法对 MySQL 开 TCP
- 支持 `map` / `key` / `sql`

### postgres（通用 PostgreSQL，Node 运行时）

| 变量 | 必填条件 | 说明 |
|---|---|---|
| `PG_URL` | 与 `DATABASE_URL` 二选一必填 | 连接串：`postgresql://user:pass@host:5432/dbname?sslmode=require`；**优先级最高**（托管库的 sslmode 等参数分项表达不了） |
| `DATABASE_URL` | 与 `PG_URL` 二选一 | Neon / Supabase / Railway / Heroku 等平台的通用变量名，同样认 |
| `PG_HOST` + `PG_PORT` + `PG_USER` + `PG_PASSWORD` + `PG_DATABASE` | 连接串未设置时必填 | 分项配置（`PG_PORT` 默认 5432） |
| `PG_SSL` | 分项模式 + 托管库时建议 `true` | 以 `rejectUnauthorized:false` 连接（等同 `sslmode=require`：加密但不校验证书链，兼容自签/中间证书）。默认关闭——本地/内网 PG 通常无证书，强制 TLS 会连不上 |

- 仅 **Node 运行时**可用（`pg` 需 TCP；Workers 无法直连 PG 端口）
- ⚠️ **EdgeOne 云函数不可用**：产物不含 node_modules，运行时会得到可读的「pg 未安装」错误。边缘环境请改 `turso`
- 自托管 / Docker / Vercel Node 可用（`pg` 已声明为依赖且保持 external，运行时从 node_modules 解析）
- 支持 `map` / `key` / `sql`

### turso（libSQL，SQLite 方言，HTTP API）

| 变量 | 必填条件 | 说明 |
|---|---|---|
| `TURSO_DATABASE_URL` | 两项均必填 | 数据库 HTTPS 端点：`https://<db>-<org>.turso.io`；也接受 `libsql://…`（自动改写为 https） |
| `TURSO_AUTH_TOKEN` | 两项均必填 | 数据库访问令牌（`turso db tokens create <db>`） |

- **零依赖**：走 HTTP Pipeline API（`POST /v2/pipeline`），纯 fetch，无 wasm 无原生模块
- **全平台可用**：Cloudflare Workers ✅ / EdgeOne 云函数 ✅ / ESA ✅ / 自托管 ✅
- SQLite 方言（`INSERT OR REPLACE`、反引号标识符），与 D1/DO 共用同一套格式层
- 支持 `map` / `key` / `sql`
- 单语句绑定参数上限按 999 处理（SQLite 编译期默认值）
- `batch()` 用显式 `BEGIN/COMMIT` 包在同一个 pipeline 里，保证原子性

### memory（仅本地）

`DB_DRIVER=memory` 是合法驱动名，但**只在本地 Node 运行时有效**：

- 本地：可用，数据随进程结束丢失（开发调试用）
- Serverless：直接抛 `NO_STORAGE`（内存写入会静默丢失却返回成功，属于最危险的假象）

---

## 三、自动探测顺序（DB_DRIVER=auto）

只有**显式配置了连接信息**的网络型驱动才参与探测（无配置时探测只会产生
无谓的 TCP/HTTP 超时开销）：

```
1. mysql    （需 MYSQL_URLS 或 MYSQL_HOST）
2. postgres （需 PG_URL / DATABASE_URL / PG_HOST）
3. turso    （需 TURSO_DATABASE_URL + TURSO_AUTH_TOKEN）
4. d1       （本地绑定探测，代价极低）
5. kv       （本地绑定探测）
6. cfkv     （本地绑定探测）
7. blob     （本地绑定探测）
8. do       （本地绑定探测）
```

- 命中第一个可用驱动即停止（日志：`[DB] Auto-detected driver: …`）
- 全部不可用：Serverless 报 `NO_STORAGE`；本地回退 `memory`
- **显式指定 `DB_DRIVER` 永不回退**：指定了但不可用时直接报错，并把
  「auto 会选中谁」写进错误信息，绝不把数据写到别的后端（避免网络抖动
  引发数据分裂）

---

## 四、数据格式（DB_FORMAT）

| 格式 | 存储形态 | 适用驱动 | 说明 |
|---|---|---|---|
| `map` | 整个配置对象序列化为一个 JSON 值 | 全部 | 默认。读写最简单，每次保存全量写回 |
| `key` | 按表拆成多条记录（每实体一 key） | KV 语义 + SQL 语义驱动 | 减小单值体积；注意 `DB_FORMAT=kv 且无 DB_FORMAT → key` 的旧兼容映射**已移除**，分表请显式设置 |
| `sql` | 列式表（与 Go 后端 GORM 表结构一致） | 仅 `d1` `do` `mysql` `postgres` `turso` | 表名：`x_setting_items` / `x_storages` / `x_users` / `x_sharing_dbs` / `x_metas` / `x_plugins`（前缀固定 `x_`） |

**驱动 × 格式白名单**（非法组合在解析期即拒绝，不会等到运行时才炸）：

| 驱动 | 支持格式 |
|---|---|
| `blob` | `map` |
| `kv` `cfkv` `memory` | `map` `key` |
| `d1` `do` `mysql` `postgres` `turso` | `map` `key` `sql` |

---

## 五、字段加密（DB_CIPHER）

只影响敏感字段落盘形态，与存储位置无关。历史密文带 `enc:vN:` 前缀，
读取时按前缀自动识别，**从加密切回 `none` 不会导致旧数据不可读**，只是
下次写入转为明文（自动迁移）。

| 值 | 算法 | 说明 |
|---|---|---|
| `none`（默认） | 不加密 | 静态可读；与 Go 共享库 / 直接 SQL 查询无障碍 |
| `aes-256-gcm` | HKDF-SHA256 派生 AES-256-GCM（`enc:v2:`） | 推荐 |
| `aes-256-gcm-pbkdf2` | PBKDF2-SHA256（10 万次）（`enc:v1:`） | 兼容旧数据，慢 |
| `aes-256-cbc-hmac` | AES-256-CBC + HMAC（`enc:v3:`） | Encrypt-then-MAC |
| `chacha20-poly1305` | ChaCha20-Poly1305 纯 JS（`enc:v4:`） | 无 AES 硬件加速的运行时 |
| `des-cbc-hmac` | 单 DES 56-bit（`enc:v5:`） | **仅兼容，不安全** |
| `3des-cbc-hmac` | 3DES（`enc:v6:`） | **仅兼容，已弃用** |

---

## 六、JWT_SECRET（共享密钥）

| 形态 | 必填条件 |
|---|---|
| Cloudflare Workers | 建议在 wrangler.jsonc / 面板中设置；未设置时安装向导会自动生成并持久化到存储 |
| EdgeOne（Node 云函数 + Edge Functions 代理 KV） | **必须两端一致**，否则 KV 代理返回 401 |
| 任意多实例部署 | 强烈建议显式设置，避免各实例/冷启动各生成一把导致令牌随机失效 |

生成方式：`openssl rand -hex 32`

> 注意：`DB_CIPHER=none` 只表示「数据库字段不加密」；JWT 签名仍然需要
> 这把密钥。加密密钥与签名密钥由同一变量派生（见 `pkg/crypto.ts`）。

---

## 七、与 Go 后端共享物理库

`sql` 格式的表结构、表名（`x_` 前缀 + GORM 复数名）、列名（对齐 Go 的
json tag）与 Go 后端完全一致，因此 D1 / MySQL / PostgreSQL / Turso 的库
可以与 Go 版 OpenList 共用：

- TS 侧**只读写** `TABLE_NAMES`（settings/storages/users/shares/metas/plugins）
- `sshkeys` 表**只建表不读写**：TS 把公钥存在 `users.ssh_keys` 内；纳入
  往返会在 save 时 `DELETE` 后写空数组，清空 Go 侧写入的公钥（已刻意排除）
- 加密建议 `DB_CIPHER=none`，否则 Go 侧读到的敏感字段是密文

---

## 八、诊断与常见错误码

`/api/public/env_check` 返回 `storage.error_code`，配合 `summary` /
`suggestion` 使用：

| 错误码 | 含义 | 典型原因 |
|---|---|---|
| `NO_STORAGE` | 没有任何可用后端 | serverless 下什么都没配；auto 探测全部失败 |
| `DRIVER_UNAVAILABLE` | 显式指定的驱动不可用 | 绑定缺失 / 凭据没配 / 运行时限制（如 Workers 上配 postgres） |
| `INVALID_COMBINATION` | 驱动 × 格式非法 | 如 `DB_FORMAT=sql` + `DB_DRIVER=kv`；blob 只支持 map |
| `UNKNOWN_DRIVER` | DB_DRIVER 拼错 | 不在合法取值列表里 |
| `PROXY_CONFIG` | EdgeOne KV 代理配置错误 | `EO_KV_URLS` 缺失/不对 |
| `HEALTH_ERROR` | 驱动自检失败 | 连接不通 / 鉴权失败（健康检查会带原始错误） |

> 显式指定驱动不可用时，错误信息里会带一行
> `Auto-detection would pick: DB_DRIVER=xxx`，直接抄成配置即可修复；
> 诊断字段 `storage.suggestion` 也会单独给一句话建议（前端显眼展示）。

---

## 九、完整配置示例

### Cloudflare Workers（D1 + sql 格式）

```jsonc
// wrangler.jsonc
{
  "vars": {
    "ENVIRONMENT": "production",
    "DB_FORMAT": "sql",
    "DB_DRIVER": "d1",
    "DB_CIPHER": "none",
    "JWT_SECRET": "<openssl rand -hex 32>"
  },
  "d1_databases": [{ "binding": "DB", "database_name": "opnelist", "database_id": "…" }],
  "kv_namespaces": [{ "binding": "KV", "id": "…" }]
}
```

### EdgeOne Node 云函数（Blob）

```
DB_DRIVER=blob
DB_FORMAT=map
DB_CIPHER=none
JWT_SECRET=<openssl rand -hex 32>
```

### Turso（全平台通用）

```
DB_DRIVER=turso
DB_FORMAT=sql
DB_CIPHER=none
JWT_SECRET=<openssl rand -hex 32>
TURSO_DATABASE_URL=https://my-db-myorg.turso.io
TURSO_AUTH_TOKEN=eyJ…
```

### 自托管 Node / Docker（PostgreSQL）

```
DB_DRIVER=postgres
DB_FORMAT=sql
DB_CIPHER=none
JWT_SECRET=<openssl rand -hex 32>
PG_URL=postgresql://user:pass@db.internal:5432/openlist?sslmode=require
```

分项写法：

```
DB_DRIVER=postgres
DB_FORMAT=map
PG_HOST=db.internal
PG_PORT=5432
PG_USER=openlist
PG_PASSWORD=…
PG_DATABASE=openlist
PG_SSL=true
```

---

## 十、变更记录

| 版本 | 变更 |
|---|---|
| `37a38ef` | 新增 `turso`（libSQL HTTP API，零依赖全平台）与 `postgres`（pg，Node）驱动；`Driver` 接口增加 `dialect` / `maxBindParams`；`format/sql.ts` 支持三方言（引号/占位符/UPSERT）；PG bool 列用原生 BOOLEAN；驱动 × 格式白名单与诊断文案同步更新 |
