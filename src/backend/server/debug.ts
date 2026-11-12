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
      cache_count: db.metas?.length || 0,
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
 * 临时网络诊断端点（问题定位后删除）。
 *
 * 用于在 EdgeOne Node 云函数内部直接测量 drive-m.quark.cn 的连接链路：
 *   - dns.getDefaultResultOrder()：确认 ipv4first 是否真的生效
 *   - resolve4 / resolve6：两种地址族的解析结果与耗时
 *   - TCP connect 到每个 IP：区分「DNS 慢」「连接超时」「TLS 失败」
 *   - 完整 fetch：与驱动实际行为对齐
 */
debugRouter.get("/net-probe", async (c) => {
  const out: any = {
    node: typeof process !== "undefined" ? process.versions?.node : null,
    defaultResultOrder: null,
    lookup: null,
    resolve4: null,
    resolve6: null,
    tcpConnect: [],
    fetch: null,
  }

  if (typeof process === "undefined" || !process.versions?.node) {
    return c.json({ code: 200, message: "not node runtime", data: out })
  }

  const HOST = c.req.query("host") || "drive-m.quark.cn"
  const PORT = Number(c.req.query("port") || 443)

  try {
    const dns: any = await import("node:dns")
    const dnsP: any = dns.promises
    out.defaultResultOrder = typeof dns.getDefaultResultOrder === "function"
      ? dns.getDefaultResultOrder()
      : "n/a"

    // 1) lookup（驱动实际走的路径）
    const t0 = Date.now()
    try {
      const r = await new Promise<any>((resolve, reject) => {
        dns.lookup(HOST, { all: true }, (err: any, addresses: any) =>
          err ? reject(err) : resolve(addresses),
        )
      })
      out.lookup = { ms: Date.now() - t0, addresses: r }
    } catch (e: any) {
      out.lookup = { ms: Date.now() - t0, error: e?.message, code: e?.code }
    }

    // 2) resolve4 / resolve6（绕过系统解析器，直查 DNS）
    for (const fam of ["resolve4", "resolve6"] as const) {
      const s = Date.now()
      try {
        const r = await dnsP[fam](HOST)
        out[fam] = { ms: Date.now() - s, addresses: r }
      } catch (e: any) {
        out[fam] = { ms: Date.now() - s, error: e?.message, code: e?.code }
      }
    }

    // 3) 逐个 IP 做 TCP connect（区分连接层与 TLS 层）
    const ips: string[] = []
    for (const key of ["resolve4", "resolve6"]) {
      const addrs = out[key]?.addresses
      if (Array.isArray(addrs)) {
        for (const a of addrs) {
          ips.push(typeof a === "string" ? a : a?.address)
        }
      }
    }
    const net: any = await import("node:net")
    for (const ip of ips.slice(0, 6)) {
      const s = Date.now()
      const res: any = await new Promise((resolve) => {
        const sock = net.connect({ host: ip, port: PORT, family: ip.includes(":") ? 6 : 4 })
        let done = false
        const finish = (r: any) => {
          if (done) return
          done = true
          try {
            sock.destroy()
          } catch {}
          resolve(r)
        }
        sock.setTimeout(8000)
        sock.on("connect", () => finish({ ok: true }))
        sock.on("timeout", () => finish({ ok: false, error: "timeout" }))
        sock.on("error", (e: any) => finish({ ok: false, error: e?.code || e?.message }))
      })
      out.tcpConnect.push({ ip, ms: Date.now() - s, ...res })
    }

    // 4) 完整 fetch（与驱动行为一致）
    const fs0 = Date.now()
    try {
      const res = await fetch(`https://${HOST}/1/clouddrive/config?pr=ucpro&fr=pc`, {
        signal: AbortSignal.timeout(15000),
      })
      out.fetch = { ms: Date.now() - fs0, status: res.status, ok: res.ok }
      await res.text()
    } catch (e: any) {
      out.fetch = {
        ms: Date.now() - fs0,
        error: e?.message,
        causeCode: e?.cause?.code || e?.cause?.cause?.code,
        causeMsg: e?.cause?.message,
      }
    }

    // 5) 验证假设：关闭 Happy Eyeballs 后再 fetch 一次
    //    （autoSelectFamily 在 250ms 就切到 IPv6，而 IPv6 在此出口
    //     ENETUNREACH，导致整条连接在 257ms 被掐断）
    out.autoSelectFamilyBefore =
      typeof (net as any).getDefaultAutoSelectFamily === "function"
        ? (net as any).getDefaultAutoSelectFamily()
        : "n/a"
    try {
      if (typeof (net as any).setDefaultAutoSelectFamily === "function") {
        ;(net as any).setDefaultAutoSelectFamily(false)
      }
      const dnsMod: any = await import("node:dns")
      if (typeof dnsMod?.setDefaultResultOrder === "function") {
        dnsMod.setDefaultResultOrder("ipv4first")
      }
    } catch {}
    out.autoSelectFamilyAfter =
      typeof (net as any).getDefaultAutoSelectFamily === "function"
        ? (net as any).getDefaultAutoSelectFamily()
        : "n/a"

    const fetchResults: any[] = []
    for (let i = 1; i <= 5; i++) {
      const s = Date.now()
      try {
        const res = await fetch(
          `https://${HOST}/1/clouddrive/config?pr=ucpro&fr=pc`,
          { signal: AbortSignal.timeout(15000) },
        )
        await res.text()
        fetchResults.push({ try: i, ms: Date.now() - s, status: res.status, ok: true })
      } catch (e: any) {
        fetchResults.push({
          try: i,
          ms: Date.now() - s,
          ok: false,
          causeCode: e?.cause?.code || e?.cause?.cause?.code,
        })
      }
    }
    out.fetchAfterDisable = fetchResults
  } catch (e: any) {
    out.fatal = { message: e?.message, code: e?.code }
  }

  return c.json({ code: 200, message: "net probe", data: out })
})
