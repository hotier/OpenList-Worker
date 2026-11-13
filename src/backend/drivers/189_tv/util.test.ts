import assert from "node:assert/strict"
import { test } from "node:test"
import { createHmac } from "node:crypto"

import { sessionKeySignatureOfHmac, appKeySignatureOfHmac, Client189TV } from "./util"

function hmacSha1Upper(data: string, key: string): string {
  return createHmac("sha1", key)
    .update(data, "utf8")
    .digest("hex")
    .toUpperCase()
}

test("189TV SessionKey signature matches Go HMAC-SHA1", () => {
  const url = "https://api.cloud.189.cn/family/file/listFiles.action"
  const date = "Mon, 05 Sep 2026 10:30:00 GMT"
  const actual = sessionKeySignatureOfHmac(
    "secret123",
    "key456",
    "GET",
    url,
    date,
  )
  const path = "/family/file/listFiles.action"
  const data = `SessionKey=key456&Operate=GET&RequestURI=${path}&Date=${date}`
  const expected = hmacSha1Upper(data, "secret123")
  assert.equal(actual, expected)
})

test("189TV AppKey signature matches Go HMAC-SHA1", () => {
  const url = "https://api.cloud.189.cn/family/manage/loginFamilyMerge.action"
  const ts = 1725510600000
  const actual = appKeySignatureOfHmac(
    "fe5734c74c2f96a38157f420b32dc995",
    "600100885",
    "GET",
    url,
    ts,
  )
  const path = "/family/manage/loginFamilyMerge.action"
  const data = `AppKey=600100885&Operate=GET&RequestURI=${path}&Timestamp=${ts}`
  const expected = hmacSha1Upper(data, "fe5734c74c2f96a38157f420b32dc995")
  assert.equal(actual, expected)
})

test("189TV init: 无 access_token 时生成登录链接并回写 temp_uuid", async () => {
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    if (url.includes("getQrCodeUUID.action")) {
      return new Response(
        JSON.stringify({ uuid: "https://h5.cloud.189.cn/authorize?uuid=abc123" }),
        { status: 200 },
      )
    }
    throw new Error("unexpected fetch: " + url)
  }) as typeof fetch
  try {
    const patches: Array<Record<string, any>> = []
    const c = new Client189TV({}, undefined, async (p) => {
      patches.push(p)
    })
    await assert.rejects(() => c.init(), /需要登录授权.*authorize\?uuid=abc123/s)
    assert.equal(patches.length, 1)
    assert.ok(patches[0].temp_uuid)
  } finally {
    globalThis.fetch = orig
  }
})

test("189TV init: 已有 temp_uuid 时轮询换取 access_token 并完成登录", async () => {
  const orig = globalThis.fetch
  const seen: string[] = []
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    seen.push(url)
    if (url.includes("qrcodeLoginResult.action")) {
      return new Response(JSON.stringify({ e189AccessToken: "tok-1" }), {
        status: 200,
      })
    }
    if (url.includes("loginFamilyMerge.action")) {
      return new Response(
        JSON.stringify({ sessionKey: "sk", sessionSecret: "ss", loginName: "u" }),
        { status: 200 },
      )
    }
    throw new Error("unexpected fetch: " + url)
  }) as typeof fetch
  try {
    const patches: Array<Record<string, any>> = []
    const c = new Client189TV({ temp_uuid: "uuid-1" }, undefined, async (p) => {
      patches.push(p)
    })
    await c.init()
    assert.deepEqual(patches, [{ access_token: "tok-1", temp_uuid: "" }])
    assert.ok(seen.some((u) => u.includes("loginFamilyMerge.action")))
  } finally {
    globalThis.fetch = orig
  }
})

test("189TV init: 未完成扫码时提示重试且不回写 token", async () => {
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    if (url.includes("qrcodeLoginResult.action")) {
      return new Response(
        JSON.stringify({ res_code: 1, res_message: "not scanned yet" }),
        { status: 200 },
      )
    }
    throw new Error("unexpected fetch: " + url)
  }) as typeof fetch
  try {
    const patches: Array<Record<string, any>> = []
    const c = new Client189TV({ temp_uuid: "uuid-1" }, undefined, async (p) => {
      patches.push(p)
    })
    await assert.rejects(() => c.init(), /尚未完成登录/)
    assert.deepEqual(patches, [])
  } finally {
    globalThis.fetch = orig
  }
})
