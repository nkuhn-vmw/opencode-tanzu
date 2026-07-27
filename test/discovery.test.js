import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { discoverModels, DiscoveryError, probeContextLength } from "../src/opencode-tanzu-discovery.js"

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/cdc-models.json", import.meta.url)))
const BASE = "https://genai-proxy.example.test/inst/openai/v1"

function stubFetch(status, body) {
  return async () => ({ ok: status >= 200 && status < 300, status, statusText: `HTTP ${status}`, json: async () => body })
}

test("returns model cards from a healthy endpoint", async () => {
  const cards = await discoverModels(BASE, "k", { fetchImpl: stubFetch(200, FIXTURE) })
  assert.equal(cards.length, 4)
  assert.equal(cards[0].id, "nomic-ai/nomic-embed-text-v2-moe")
})

test("passes the bearer token and hits /models", async () => {
  let seenUrl, seenAuth
  const fetchImpl = async (url, init) => {
    seenUrl = url
    seenAuth = init.headers.Authorization
    return { ok: true, status: 200, json: async () => FIXTURE }
  }
  await discoverModels(BASE, "secret-token", { fetchImpl })
  assert.equal(seenUrl, `${BASE}/models`)
  assert.equal(seenAuth, "Bearer secret-token")
})

test("surfaces max_model_len when the endpoint provides it", async () => {
  const body = { data: [{ id: "a/b", max_model_len: 32768 }] }
  const cards = await discoverModels(BASE, "k", { fetchImpl: stubFetch(200, body) })
  assert.equal(cards[0].max_model_len, 32768)
})

test("401 throws a DiscoveryError whose hint names the fix", async () => {
  await assert.rejects(
    () => discoverModels(BASE, "k", { fetchImpl: stubFetch(401, {}) }),
    (err) => {
      assert.ok(err instanceof DiscoveryError)
      assert.equal(err.status, 401)
      assert.match(err.hint, /cf service-key/)
      return true
    },
  )
})

test("network failure throws DiscoveryError, not a raw TypeError", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED") }
  await assert.rejects(() => discoverModels(BASE, "k", { fetchImpl }), DiscoveryError)
})

test("tolerates a missing data array", async () => {
  const cards = await discoverModels(BASE, "k", { fetchImpl: stubFetch(200, {}) })
  assert.deepEqual(cards, [])
})

test("a non-JSON 200 body throws DiscoveryError, not a raw SyntaxError", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON at position 0")
    },
  })
  await assert.rejects(
    () => discoverModels(BASE, "k", { fetchImpl }),
    (err) => {
      assert.ok(err instanceof DiscoveryError)
      assert.ok(!(err instanceof SyntaxError))
      assert.ok(err.hint, "must name a concrete fix, like every other failure mode in this module")
      return true
    },
  )
})

const OVER_LIMIT_400 = {
  error: {
    code: "runtime_error",
    message:
      "400: max_tokens=999999999 cannot be greater than max_model_len=max_total_tokens=262144. Please request fewer output tokens. (parameter=max_tokens, value=999999999)",
  },
}

test("probe parses max_model_len out of the over-limit 400 body", async () => {
  const ctx = await probeContextLength(BASE, "k", "poolside/Laguna-S-2.1-NVFP4", {
    fetchImpl: stubFetch(400, OVER_LIMIT_400),
  })
  assert.equal(ctx, 262144)
})

test("probe parses a plain max_model_len= form without the max_total_tokens infix", async () => {
  const body = { error: { message: "max_tokens=999999999 cannot be greater than max_model_len=131072." } }
  const ctx = await probeContextLength(BASE, "k", "a/b", { fetchImpl: stubFetch(400, body) })
  assert.equal(ctx, 131072)
})

// ollama silently clamps max_tokens and returns a normal completion, so there
// is no limit to read. This must be an ordinary null, never a throw.
test("probe returns null when the model answers successfully (ollama path)", async () => {
  const ok = { id: "x", object: "chat.completion", choices: [{ message: { content: "hi" } }] }
  const ctx = await probeContextLength(BASE, "k", "qwen3:14b", { fetchImpl: stubFetch(200, ok) })
  assert.equal(ctx, null)
})

test("probe returns null on a network error rather than throwing", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED")
  }
  assert.equal(await probeContextLength(BASE, "k", "a/b", { fetchImpl }), null)
})

test("probe returns null when the error body has no parseable limit", async () => {
  const body = { error: { message: "something else went wrong" } }
  assert.equal(await probeContextLength(BASE, "k", "a/b", { fetchImpl: stubFetch(400, body) }), null)
})

test("probe returns null for a non-positive parsed limit", async () => {
  const body = { error: { message: "max_model_len=0" } }
  assert.equal(await probeContextLength(BASE, "k", "a/b", { fetchImpl: stubFetch(400, body) }), null)
})

test("probe posts the over-limit request with the bearer token", async () => {
  let seenUrl, seenInit
  const fetchImpl = async (url, init) => {
    seenUrl = url
    seenInit = init
    return { ok: false, status: 400, json: async () => OVER_LIMIT_400 }
  }
  await probeContextLength(BASE, "tok", "a/b", { fetchImpl })
  assert.equal(seenUrl, `${BASE}/chat/completions`)
  assert.equal(seenInit.method, "POST")
  assert.equal(seenInit.headers.Authorization, "Bearer tok")
  const body = JSON.parse(seenInit.body)
  assert.equal(body.model, "a/b")
  assert.equal(body.max_tokens, 999999999)
})
