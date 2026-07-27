import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { CLAMPED, discoverModels, DiscoveryError, probeContextLength, probeToolCall } from "../src/opencode-tanzu-discovery.js"
import { MIN_PLAUSIBLE_CONTEXT, MAX_PLAUSIBLE_CONTEXT } from "../src/opencode-tanzu-capabilities.js"

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
// is no limit to read. That is a CONCLUSIVE, permanent negative (CLAMPED) —
// distinct from the plain `null` used for a merely inconclusive probe
// (network error, unparseable body). Conflating the two was Critical finding
// C2: a transient probe failure must not be cached as if it were this.
test("probe returns CLAMPED, not null, when the model answers successfully (ollama path)", async () => {
  const ok = { id: "x", object: "chat.completion", choices: [{ message: { content: "hi" } }] }
  const ctx = await probeContextLength(BASE, "k", "qwen3:14b", { fetchImpl: stubFetch(200, ok) })
  assert.equal(ctx, CLAMPED)
  assert.notEqual(ctx, null, "CLAMPED (conclusive) must be distinguishable from null (inconclusive)")
})

// F2 — a 2xx status alone must not be read as CLAMPED. An OpenAI-compatible
// gateway or route service can normalize an upstream error into a 200
// (LiteLLM-style proxies do exactly this), and the real limit still shows up
// in the message text — it must be parsed and trusted, not discarded in
// favor of a false-conclusive CLAMPED that pins the model at 8192 for a week.
test("a 200 carrying a max_model_len error message yields the parsed number, not CLAMPED", async () => {
  const body = { error: { message: "max_tokens=999999999 cannot be greater than max_model_len=131072." } }
  const ctx = await probeContextLength(BASE, "k", "a/b", { fetchImpl: stubFetch(200, body) })
  assert.equal(ctx, 131072)
  assert.notEqual(ctx, CLAMPED, "a real limit delivered on a 200 must be used, not discarded for CLAMPED")
})

// F2 — a 200 with neither `choices` (a real completion) nor a parseable
// limit is NOT evidence the backend can never be probed; it is simply a
// response shape we don't recognize. Must be null (inconclusive, retried
// soon), not CLAMPED (conclusive, pinned for a week).
test("a 200 with neither choices nor a parseable limit yields null, not CLAMPED", async () => {
  const body = { status: "ok" }
  const ctx = await probeContextLength(BASE, "k", "a/b", { fetchImpl: stubFetch(200, body) })
  assert.equal(ctx, null)
  assert.notEqual(ctx, CLAMPED, "an unrecognized 200 body must be inconclusive, not a conclusive negative")
})

// F2 regression guard — a genuine 200 completion (real choices, no
// parseable limit) must still yield CLAMPED, exactly as the ollama path
// requires. This is the case the fix must not break while closing the gap.
test("a genuine 200 completion (has choices) still yields CLAMPED", async () => {
  const ok = { id: "x", object: "chat.completion", choices: [{ message: { content: "hi" } }] }
  const ctx = await probeContextLength(BASE, "k", "qwen3:14b", { fetchImpl: stubFetch(200, ok) })
  assert.equal(ctx, CLAMPED)
})

// Finding 3 (Wave 4) — a 2xx `{"choices":[]}` body (a content filter, an
// aborted upstream, some load-balancer shapes) is NOT proof the backend
// clamps instead of erroring: it is a 2xx that never actually answered. The
// pre-fix code tested only `Array.isArray(body?.choices)`, so this body was
// scored CLAMPED and the model pinned at the conservative default for a
// week. `probeToolCall` already required a non-empty array; this is the same
// requirement for `probeContextLength`.
test("probe returns null, not CLAMPED, on a 200 with an empty choices array", async () => {
  const body = { id: "x", object: "chat.completion", choices: [] }
  const ctx = await probeContextLength(BASE, "k", "a/b", { fetchImpl: stubFetch(200, body) })
  assert.equal(ctx, null)
  assert.notEqual(ctx, CLAMPED, "an empty choices array is not proof of a real completion")
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

// I1 — a mangled or hostile error body could report an implausible number:
// far too small to be a real chat context (instant compaction looping) or
// absurdly large (compaction never fires, every request rejected at the
// tile). Both are inconclusive, not facts about the model.
test("probe returns null for an implausibly large parsed limit", async () => {
  const body = { error: { message: `max_model_len=${MAX_PLAUSIBLE_CONTEXT + 1}` } }
  assert.equal(await probeContextLength(BASE, "k", "a/b", { fetchImpl: stubFetch(400, body) }), null)
})

test("probe returns null for an implausibly small parsed limit", async () => {
  const body = { error: { message: `max_model_len=${MIN_PLAUSIBLE_CONTEXT - 1}` } }
  assert.equal(await probeContextLength(BASE, "k", "a/b", { fetchImpl: stubFetch(400, body) }), null)
})

test("probe accepts a parsed limit exactly at the plausible band's edges", async () => {
  const min = { error: { message: `max_model_len=${MIN_PLAUSIBLE_CONTEXT}` } }
  assert.equal(await probeContextLength(BASE, "k", "a/b", { fetchImpl: stubFetch(400, min) }), MIN_PLAUSIBLE_CONTEXT)
  const max = { error: { message: `max_model_len=${MAX_PLAUSIBLE_CONTEXT}` } }
  assert.equal(await probeContextLength(BASE, "k", "a/b", { fetchImpl: stubFetch(400, max) }), MAX_PLAUSIBLE_CONTEXT)
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

test("tool-call probe returns true when the model emits native tool_calls", async () => {
  const body = {
    choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "1", function: { name: "ping" } }] } }],
  }
  assert.equal(await probeToolCall(BASE, "k", "a/b", { fetchImpl: stubFetch(200, body) }), true)
})

test("tool-call probe returns false when the model answers without tool_calls", async () => {
  const body = { choices: [{ finish_reason: "stop", message: { content: "hello" } }] }
  assert.equal(await probeToolCall(BASE, "k", "a/b", { fetchImpl: stubFetch(200, body) }), false)
})

test("tool-call probe returns null on an error response", async () => {
  assert.equal(await probeToolCall(BASE, "k", "a/b", { fetchImpl: stubFetch(500, {}) }), null)
})

test("tool-call probe returns null on a network error rather than throwing", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED")
  }
  assert.equal(await probeToolCall(BASE, "k", "a/b", { fetchImpl }), null)
})

test("tool-call probe sends a tool definition and a bounded max_tokens", async () => {
  let seenBody
  const fetchImpl = async (url, init) => {
    seenBody = JSON.parse(init.body)
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "x" } }] }) }
  }
  await probeToolCall(BASE, "k", "a/b", { fetchImpl })
  assert.equal(seenBody.tools.length, 1)
  assert.equal(seenBody.tools[0].function.name, "ping")
  // 512, not the old 64: tiny enough to stay cheap, but large enough that a
  // reasoning model's <think> preamble doesn't eat the whole budget before it
  // ever reaches a tool call (see the finish_reason:"length" test below).
  assert.ok(seenBody.max_tokens <= 512, "probe must not generate an unbounded reply")
})

// C1: the design spec called for a FORCED tool-call request (the `validate.sh`
// pattern) and the pre-fix implementation never sent it, so a model that
// simply chose to answer in prose also scored a false "no tool support".
test("tool-call probe sends tool_choice: required", async () => {
  let seenBody
  const fetchImpl = async (url, init) => {
    seenBody = JSON.parse(init.body)
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "x" } }] }) }
  }
  await probeToolCall(BASE, "k", "a/b", { fetchImpl })
  assert.equal(seenBody.tool_choice, "required")
})

// C1, the headline regression: a reasoning model (Qwen3/Gemma — exactly what
// the tile swaps in) can burn its whole token budget inside a <think>
// preamble and never reach a tool call. The pre-fix probe scored that
// truncation as a confident, 7-day-cached `false`. It must be `null`
// (inconclusive) instead.
test("tool-call probe returns null, not false, on finish_reason: length", async () => {
  const body = { choices: [{ finish_reason: "length", message: { content: "<think>still thinking" } }] }
  const result = await probeToolCall(BASE, "k", "a/b", { fetchImpl: stubFetch(200, body) })
  assert.equal(result, null)
  assert.notEqual(result, false, "a truncated reply must never be reported as a definitive negative")
})
