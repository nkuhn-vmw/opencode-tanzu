import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { discoverModels, DiscoveryError } from "../src/opencode-tanzu-discovery.js"

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
