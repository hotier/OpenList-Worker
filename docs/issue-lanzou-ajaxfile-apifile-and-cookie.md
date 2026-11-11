## 问题现象

使用 **蓝奏云（Lanzou）** 存储驱动时：

- **文件列表可以正常读取**（能进入目录、看到文件）
- **打开/下载文件时报错**：

```
[Lanzou] 获取下载直链失败 (xxx.txt): [Lanzou] ajaxfile.php 响应格式错误:
```

错误信息里 `响应格式错误:` 后面是**空内容**（ajaxfile.php 返回了空/非 JSON 响应）。

另外，使用**账号密码模式**（`type: account`）时，登录后立刻报：

```
[Lanzou] Cookie 已过期或失效，请在管理后台重新填写 Cookie（有效期约 15 天）
```

## 复现环境

- OpenList-Worker（TypeScript / Cloudflare Workers 版）
- 蓝奏云驱动，`type: cookie` 或 `type: account`
- 同配置、同账号在浏览器访问蓝奏官网可正常下载，说明**不是账号被封/IP 被封**

## 根因分析

定位到两个独立问题，均在 `src/backend/drivers/lanzou/` 下。

### 问题一：取直链接口域名迁移（ajaxfile.php 403/空响应）

蓝奏云已把取直链接口 **`ajaxfile.php` 从分享域名迁移到独立的 `apifile.*` 域名**。

分享页 iframe 里的 JS 明确给出新域名：

```js
var domain1 = 'https://apifile.woozooo.com/ajaxfile.php?file=xxxx';
var domain2 = 'https://apifile.lanzouw.com/ajaxfile.php?file=xxxx';
```

但原驱动固定用**分享域名**（如 `wwop.lanzoul.com`）拼 `ajaxfile.php`：

```js
const resStr = await this.request(
  `${shareBaseDomain}/ajaxfile.php?file=${fileId}`,  // ❌ 分享域名已失效，返回 403/空
  "POST", param, sharePageUrl)
```

旧域名上的 `ajaxfile.php` 返回 403 或空内容 → `JSON.parse` 失败 → `响应格式错误`。

> 说明：列表接口走的是另一条路径，所以"列表能读、下载失败"并不矛盾。
> 该现象与"IP 被封"无关——本地普通网络同样复现，浏览器能下载说明接口本身可用，只是域名变了。

### 问题二：账号模式抓 cookie 失败

**2a. WAF 挑战页判断错误**

蓝奏登录接口 `mlogin.php` 在触发 WAF 时返回的是挑战页：

```html
<script>var arg1='0E5EC6A7...';...</script>
```

`acw_sc__v2` 需由 `arg1` 计算得出，页面里**并不含字面量 `"acw_sc__v2"`**。但原代码这样判断：

```js
if (bodyStr.includes("acw_sc__v2")) {          // ❌ 永远不成立
  this.acwMap.set("up.woozooo.com", calcAcwScV2(bodyStr))
  continue
}
```

导致挑战页被当作登录响应去 `JSON.parse` → 失败 → 抓不到有效 cookie。

**2b. 多个 Set-Cookie 解析时只取到第一个**

登录成功时服务端返回多个 `Set-Cookie`（用 `, ` 连接）：

```
acw_tc=...; ..., PHPSESSID=...; ..., phpdisk_info=...; expires=Thu, 12-Nov-2026 ...; path=/, uag=...
```

原 `updateCookie` 的分割正则：

```js
const entries = setCookie.split(/,(?=[a-zA-Z0-9_\-]+=[^;]+)/)  // ❌ 断言里 [^;]+ 被 ;path=/ 的分号打断
```

由于断言语义问题，整串被当成 1 条，只解析出第一个 `acw_tc`，丢失了 `phpdisk_info` / `PHPSESSID` / `uag`，进而被判 `Cookie 已过期或失效`。

## 解决方案

已提交修复（`src/backend/drivers/lanzou/util.ts`）。

### 修复一：ajaxfile 域名改为从页面解析 apifile 域名

新增 `extractAjaxDomain()`，从分享页 `domain1/domain2` 解析 `apifile.*` 域名，两处 `ajaxfile.php` 请求改用它：

```ts
private extractAjaxDomain(pageData: string): string {
  const candidates: string[] = []
  const varMatch = pageData.match(
    /domain\d*\s*=\s*['"](https?:\/\/[^'"]*?ajax(?:file|m)\.php[^'"]*)['"]/gi,
  )
  if (varMatch) for (const raw of varMatch) {
    const u = raw.match(/https?:\/\/[^'"]+/)
    if (u) candidates.push(u[0])
  }
  const apiMatch = pageData.match(/https?:\/\/apifile\.[a-z0-9.-]+\/ajax(?:file|m)\.php/gi)
  if (apiMatch) candidates.push(...apiMatch)
  for (const raw of candidates) {
    try { const u = new URL(raw); return `${u.protocol}//${u.host}` } catch {}
  }
  return "https://apifile.lanzouw.com" // 兜底
}
```

请求改为：

```ts
const ajaxBaseDomain = this.extractAjaxDomain(pageData)
// ...
const resStr = await this.request(
  `${ajaxBaseDomain}/ajaxfile.php?file=${fileId}`,  // ✅ 走 apifile 域名
  "POST", param, sharePageUrl)
```

### 修复二：WAF 挑战识别

由检测 `"acw_sc__v2"` 改为同时检测 `arg1=`：

```ts
if (bodyStr.includes("arg1=") || bodyStr.includes("acw_sc__v2")) {
  this.acwMap.set("up.woozooo.com", calcAcwScV2(bodyStr))
  continue
}
```

`requestOnce` 中的 WAF 挑战判断同步修正。

### 修复三：多 Set-Cookie 正确切分

先保护 `expires=Thu, ...` 里的日期逗号，再切分：

```ts
const placeholder = "\u0000"
const protectedStr = setCookie.replace(/(expires=[A-Za-z]{3},)/gi, (m) => m.replace(",", placeholder))
const entries = protectedStr.split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/)
// 处理时把 placeholder 还原为 ","
```

这样 `phpdisk_info` / `PHPSESSID` / `uag` 都能正确并入 cookie。

## 验证结果

- **账号密码模式**：登录成功 → 拿到 447 字节完整 cookie（含 phpdisk_info）→ 目录列表正常
- **取直链**：`产品密匙.txt` 直链解析成功、下载 **HTTP 200**、内容正确
- `pnpm run lint`（tsc --noEmit）通过

## 影响范围

仅 `src/backend/drivers/lanzou/util.ts`，不影响其他驱动。

## 补充

- 若你仍遇到蓝奏取直链失败，可先确认 `ajaxfile.php` 是否又换了域名（抓分享页里 `domain1/domain2` 即可）。
- 蓝奏前端改版较频繁，若字段再次变化，`extractAjaxDomain` 的兜底与正则可能需要同步更新。
