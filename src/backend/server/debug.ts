import { Hono } from "hono"
import { getDb, getStoreStatus } from "../internal/model/db"
import { checkAdminAuth } from "../pkg/utils"

export const debugRouter = new Hono()

debugRouter.get("/info", async (c) => {
  const isAdmin = await checkAdminAuth(c)
  const db = await getDb(c.env)

  const responseData: any = {
    runtime: "Cloudflare Workers / Edge",
    timestamp: new Date().toISOString(),
    // 后端驱动信息非敏感，未登录也返回，便于确认 D1/KV/MySQL 是否生效
    store: await getStoreStatus(c.env),
  }

  if (isAdmin) {
    responseData.db_state = {
      storages_count: db.storages?.length || 0,
      users_count: db.users?.length || 0,
      metas_count: db.metas?.length || 0,
      settings_count: db.settings?.length || 0,
    }
  }

  return c.json({
    code: 200,
    message: "OpenList debug profile generated",
    data: responseData,
  })
})

/**
 * 临时诊断端点：从**本服务器出口**用已存储的 Cookie 请求一次 189 listFiles。
 * 用于判定「Cookie 在本地有效、在服务器失效」是否为出口 IP 差异。
 * 排障完成后删除。仅当 `?k=<DIAG_TOKEN>` 匹配时可用，返回内容已脱敏。
 */
const DIAG_TOKEN = "ol-diag-189-7f3a9c"

debugRouter.get("/probe-189", async (c) => {
  if (c.req.query("k") !== DIAG_TOKEN) {
    return c.json({ code: 403, message: "forbidden" }, 403)
  }
  const db = await getDb(c.env)
  const st = (db.storages || []).find(
    (s: any) => String(s.driver || "").toLowerCase().includes("189"),
  )
  if (!st) return c.json({ code: 404, message: "no 189 storage" }, 404)

  let add: any = {}
  try {
    add = typeof st.addition === "string" ? JSON.parse(st.addition) : st.addition || {}
  } catch {}
  const cookie = String(add.cookie || "").trim()
  const out: any = {
    mount: st.mount_path,
    cookieLen: cookie.length,
    // 只暴露非敏感的键名
    cookieKeys: cookie
      .split(";")
      .map((p: string) => p.split("=")[0].trim())
      .filter(Boolean),
  }

  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  const url =
    "https://cloud.189.cn/api/open/file/listFiles.action?folderId=-11&mediaType=0&iconOption=5&pageNum=1&pageSize=1&noCache=" +
    Math.random()

  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Referer: "https://cloud.189.cn/",
        Cookie: cookie,
        Accept: "application/json",
      },
    })
    const text = await r.text()
    out.status = r.status
    out.ok = /<listFiles>/.test(text)
    // 只返回前 200 字符，避免泄露文件列表
    out.bodyHead = text.slice(0, 200)
  } catch (e: any) {
    out.error = e?.message
    out.causeCode = e?.cause?.code || e?.cause?.cause?.code
  }
  return c.json({ code: 200, message: "probe-189", data: out })
})
