# opencode-tanzu v0.2.0 — Auto-Discovery & Drift Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-discover context length (and tool-call support) for unknown vLLM-served Tanzu models by probing the tile, cache the results, and ship drift-detection tooling plus docs so a tile model swap no longer requires a code change.

**Architecture:** The tile strips `max_model_len` from `/v1/models`, but vLLM leaks it in an over-limit HTTP 400 body. Discovery gains no-throw probe functions; capabilities gains a pure `unknownChatIds` filter; a new cache module persists probe results (including negative ones); the plugin's `config` hook orchestrates probe-on-unknown-only and attaches `max_model_len` to cards, which the existing `applyServedLimit` already honors. A standalone script diffs the live roster against the table.

**Tech Stack:** Plain ES modules, Node ≥ 20, zero runtime dependencies, `node --test` + `node:assert/strict`.

## Global Constraints

- **Zero runtime dependencies.** Never add an npm dependency. Tests use `node:test`/`node:assert` only.
- **Node ≥ 20**, ES modules (`import`/`export`), `"type": "module"`.
- **No file in `src/` may throw during opencode startup.** Every failure degrades: the provider must always register, the picker must never be empty.
- **File naming:** every file in `src/` MUST be prefixed `opencode-tanzu` — opencode loads plugin-dir files flat, and unprefixed names collide with other plugins.
- **No secrets in the repo, in argv, or in the opencode config file.** Credentials come from env vars or the 0600 key file only.
- **Probe request shape (verified against the live CDC tile 2026-07-27):** POST `${baseURL}/chat/completions`, body `{"model":"<id>","messages":[{"role":"user","content":"hi"}],"max_tokens":999999999}`, `Authorization: Bearer <key>`. The 400 body contains `max_tokens=999999999 cannot be greater than max_model_len=max_total_tokens=262144.`
- **ollama-served ids** (colon-tag style, e.g. `qwen3:14b`) return HTTP 200 instead of erroring — the probe MUST return `null` for them, not throw.
- Style: double quotes, no semicolons (match existing `src/` files).

---

### Task 1: `probeContextLength` in discovery

**Files:**
- Modify: `src/opencode-tanzu-discovery.js`
- Test: `test/discovery.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `probeContextLength(baseURL: string, apiKey: string, id: string, opts?: {fetchImpl?, timeoutMs?}) => Promise<number | null>` — exported from `src/opencode-tanzu-discovery.js`. Returns a positive integer on success, `null` on any inconclusive outcome. Never throws.

- [ ] **Step 1: Write the failing tests**

Append to `test/discovery.test.js`:

```js
import { discoverModels, DiscoveryError, probeContextLength } from "../src/opencode-tanzu-discovery.js"

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
```

Note: `stubFetch` and `BASE` already exist at the top of this file. Replace the existing import line with the one shown above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/discovery.test.js`
Expected: FAIL — `probeContextLength is not a function` (or an import error).

- [ ] **Step 3: Implement `probeContextLength`**

Append to `src/opencode-tanzu-discovery.js`:

```js
/**
 * The tile strips max_model_len from /v1/models, but vLLM leaks the real limit
 * in the error it raises for an impossible max_tokens. One cheap request —
 * it fails validation before generating anything — recovers the true context
 * window for a model we have no table row for.
 *
 * Verified against the live CDC tile 2026-07-27:
 *   "max_tokens=999999999 cannot be greater than max_model_len=max_total_tokens=262144."
 *
 * Backends that clamp instead of erroring (ollama-served ids like `qwen3:14b`)
 * answer 200 with an ordinary completion and reveal nothing — that is a `null`,
 * not a failure. This function never throws: an inconclusive probe simply
 * leaves the caller on its existing defaults.
 *
 * @returns {Promise<number | null>} the served context length, or null
 */
export async function probeContextLength(baseURL, apiKey, id, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 8000
  const url = `${baseURL.replace(/\/$/, "")}/chat/completions`

  let res
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: id,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 999999999,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return null
  }

  let body
  try {
    body = await res.json()
  } catch {
    return null
  }

  const message = body?.error?.message
  if (typeof message !== "string") return null
  const match = message.match(/max_model_len=(?:max_total_tokens=)?(\d+)/)
  if (!match) return null
  const context = Number.parseInt(match[1], 10)
  return Number.isFinite(context) && context > 0 ? context : null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/discovery.test.js`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add src/opencode-tanzu-discovery.js test/discovery.test.js
git commit -m "feat(discovery): probeContextLength recovers max_model_len from vLLM's over-limit error"
```

---

### Task 2: `probeToolCall` in discovery

**Files:**
- Modify: `src/opencode-tanzu-discovery.js`
- Test: `test/discovery.test.js`

**Interfaces:**
- Consumes: nothing (independent of Task 1, same file).
- Produces: `probeToolCall(baseURL: string, apiKey: string, id: string, opts?: {fetchImpl?, timeoutMs?}) => Promise<boolean | null>` — `true` if the model emitted native `tool_calls`, `false` if it completed without them, `null` on error/timeout/unparseable. Never throws.

- [ ] **Step 1: Write the failing tests**

Append to `test/discovery.test.js` (add `probeToolCall` to the existing import from `../src/opencode-tanzu-discovery.js`):

```js
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
  assert.ok(seenBody.max_tokens <= 64, "probe must not generate a long reply")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/discovery.test.js`
Expected: FAIL — `probeToolCall is not a function`.

- [ ] **Step 3: Implement `probeToolCall`**

Append to `src/opencode-tanzu-discovery.js`:

```js
/**
 * Ask a model to call one trivial tool and see whether it answers with a native
 * `tool_calls` payload. Used only for ids with no table row, where the
 * alternative is assuming tool support and letting the agent discover otherwise
 * mid-session.
 *
 * max_tokens is deliberately tiny: a backend that clamps instead of erroring
 * (the ollama path) will actually generate here, and this must stay cheap.
 *
 * @returns {Promise<boolean | null>} true/false, or null when inconclusive
 */
export async function probeToolCall(baseURL, apiKey, id, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 8000
  const url = `${baseURL.replace(/\/$/, "")}/chat/completions`

  let res
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: id,
        messages: [{ role: "user", content: "Call the ping tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "ping",
              description: "Reply to a ping.",
              parameters: { type: "object", properties: {}, required: [] },
            },
          },
        ],
        max_tokens: 64,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return null
  }

  if (!res?.ok) return null

  let body
  try {
    body = await res.json()
  } catch {
    return null
  }

  const choices = body?.choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const choice = choices[0]
  const calls = choice?.message?.tool_calls
  return (Array.isArray(calls) && calls.length > 0) || choice?.finish_reason === "tool_calls"
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/discovery.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/opencode-tanzu-discovery.js test/discovery.test.js
git commit -m "feat(discovery): probeToolCall detects native tool-call support"
```

---

### Task 3: `unknownChatIds` in capabilities

**Files:**
- Modify: `src/opencode-tanzu-capabilities.js`
- Test: `test/capabilities.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `unknownChatIds(cards: {id: string}[]) => string[]` — exported from `src/opencode-tanzu-capabilities.js`. Returns ids that are neither in `TABLE` nor embedding/rerank-excluded. Pure, no I/O.

- [ ] **Step 1: Write the failing tests**

Append to `test/capabilities.test.js` (add `unknownChatIds` to the existing import from `../src/opencode-tanzu-capabilities.js`):

```js
test("unknownChatIds returns only ids with no table row", () => {
  const ids = unknownChatIds([{ id: QWEN }, { id: "acme/mystery-7b" }])
  assert.deepEqual(ids, ["acme/mystery-7b"])
})

// Probing an embedding model would waste a request and can never yield a chat
// context — the filter must match resolveModels' own exclusion rules.
test("unknownChatIds never includes embedding or rerank ids", () => {
  const ids = unknownChatIds([{ id: NOMIC }, { id: "acme/text-embedding-3" }, { id: "acme/bge-reranker-v2" }])
  assert.deepEqual(ids, [])
})

test("unknownChatIds skips malformed cards and dedupes", () => {
  const ids = unknownChatIds([{ id: "a/b" }, { id: "a/b" }, {}, null])
  assert.deepEqual(ids, ["a/b"])
})

test("unknownChatIds on an empty roster is empty", () => {
  assert.deepEqual(unknownChatIds([]), [])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/capabilities.test.js`
Expected: FAIL — `unknownChatIds is not a function`.

- [ ] **Step 3: Implement `unknownChatIds`**

Append to `src/opencode-tanzu-capabilities.js`:

```js
/**
 * The ids worth probing: chat models we have no bundled row for. Mirrors the
 * exclusions `resolveModels` applies, so a probe is never spent on a model that
 * would be filtered out of the picker anyway.
 *
 * @param {{id: string}[]} cards
 * @returns {string[]} unique unknown chat ids, in roster order
 */
export function unknownChatIds(cards) {
  const out = []
  const seen = new Set()
  for (const card of cards ?? []) {
    const id = card?.id
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (TABLE[id]) continue
    if (NON_CHAT_ID.test(id)) continue
    out.push(id)
  }
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/capabilities.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/opencode-tanzu-capabilities.js test/capabilities.test.js
git commit -m "feat(capabilities): unknownChatIds selects probe candidates"
```

---

### Task 4: Probe-result cache module

**Files:**
- Create: `src/opencode-tanzu-cache.js`
- Create: `test/cache.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, all exported from `src/opencode-tanzu-cache.js`:
  - `cachePath() => string` — `<dataDir>/opencode-tanzu/discovery-cache.json`, resolved per call so `XDG_DATA_HOME` stays authoritative.
  - `readCache() => object` — parsed cache, `{}` when missing/corrupt. Never throws.
  - `getEntry(cache, baseURL, id, ttlMs?) => {context, toolCall, probedAt} | undefined` — only within TTL (default `DEFAULT_TTL_MS`).
  - `setEntry(cache, baseURL, id, entry) => void` — mutates `cache` in place, stamping `probedAt: Date.now()`.
  - `writeCache(cache) => Promise<void>` — best-effort persist. Never throws.
  - `DEFAULT_TTL_MS` — 7 days in ms.

- [ ] **Step 1: Write the failing tests**

Create `test/cache.test.js`:

```js
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  DEFAULT_TTL_MS,
  cachePath,
  getEntry,
  readCache,
  setEntry,
  writeCache,
} from "../src/opencode-tanzu-cache.js"

const BASE = "https://genai-proxy.example.test/inst/openai/v1"

/** Run `fn` with a scratch XDG_DATA_HOME so cachePath() lands in a temp dir. */
async function withDataHome(fn) {
  const previous = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = mkdtempSync(path.join(os.tmpdir(), "octnz-cache-test-"))
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
  }
}

test("a missing cache file reads as an empty object", async () => {
  await withDataHome(() => {
    assert.deepEqual(readCache(), {})
  })
})

// A corrupt cache must never take opencode down — it is a cache, not state.
test("a corrupt cache file reads as empty rather than throwing", async () => {
  await withDataHome(() => {
    mkdirSync(path.dirname(cachePath()), { recursive: true })
    writeFileSync(cachePath(), "{not json")
    assert.deepEqual(readCache(), {})
  })
})

test("an entry round-trips through write and read", async () => {
  await withDataHome(async () => {
    const cache = {}
    setEntry(cache, BASE, "a/b", { context: 262144, toolCall: true })
    await writeCache(cache)
    const entry = getEntry(readCache(), BASE, "a/b")
    assert.equal(entry.context, 262144)
    assert.equal(entry.toolCall, true)
  })
})

test("an entry older than the TTL is treated as absent", async () => {
  const cache = {}
  setEntry(cache, BASE, "a/b", { context: 1000 })
  const key = Object.keys(cache)[0]
  cache[key].probedAt = Date.now() - (DEFAULT_TTL_MS + 1)
  assert.equal(getEntry(cache, BASE, "a/b"), undefined)
})

// The ollama ids probe to null. Caching that negative is the whole point —
// otherwise every startup re-probes a model that can never answer.
test("a negative result is cached and honored within the TTL", () => {
  const cache = {}
  setEntry(cache, BASE, "qwen3:14b", { context: null, toolCall: null })
  const entry = getEntry(cache, BASE, "qwen3:14b")
  assert.notEqual(entry, undefined, "a null-context entry must still be a cache hit")
  assert.equal(entry.context, null)
})

test("entries are scoped per foundation, not shared across base URLs", () => {
  const cache = {}
  setEntry(cache, BASE, "a/b", { context: 1000 })
  assert.equal(getEntry(cache, "https://other.example.test/inst/openai/v1", "a/b"), undefined)
})

test("writeCache swallows a write failure instead of throwing", async () => {
  await withDataHome(async () => {
    // A file where the cache directory must go makes mkdir fail.
    writeFileSync(path.dirname(cachePath()), "")
    await writeCache({ x: { context: 1, probedAt: Date.now() } })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/cache.test.js`
Expected: FAIL — cannot find module `../src/opencode-tanzu-cache.js`.

- [ ] **Step 3: Implement the cache**

Create `src/opencode-tanzu-cache.js`:

```js
/**
 * On-disk memo for probe results, so a model is interrogated at most once per
 * TTL per foundation. Lives beside the api key under opencode's data dir.
 *
 * This is a cache and nothing more: every failure path degrades to "no cached
 * value" rather than surfacing an error, because a bad cache must never stop
 * opencode from starting.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/** Re-probe a model at most once a week; served limits change rarely. */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

function dataDir() {
  const xdg = process.env.XDG_DATA_HOME
  return xdg ? path.join(xdg, "opencode") : path.join(os.homedir(), ".local", "share", "opencode")
}

/** Resolved per call so the process env stays authoritative (mirrors secretPath). */
export function cachePath() {
  return path.join(dataDir(), "opencode-tanzu", "discovery-cache.json")
}

/**
 * Keyed by foundation AND id: the same model id on two foundations can be
 * served with different --max-model-len caps.
 */
function keyFor(baseURL, id) {
  return `${baseURL}\n${id}`
}

/** @returns {object} the cache, or {} when missing/corrupt/unreadable */
export function readCache() {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * @returns {{context: number|null, toolCall: boolean|null, probedAt: number} | undefined}
 *   the entry when present and fresh — including a negative (null context) one,
 *   which is a legitimate cached answer for a backend that cannot be probed.
 */
export function getEntry(cache, baseURL, id, ttlMs = DEFAULT_TTL_MS) {
  const entry = cache?.[keyFor(baseURL, id)]
  if (!entry || typeof entry.probedAt !== "number") return undefined
  if (Date.now() - entry.probedAt > ttlMs) return undefined
  return entry
}

/** Mutates `cache` in place; call `writeCache` to persist. */
export function setEntry(cache, baseURL, id, entry) {
  cache[keyFor(baseURL, id)] = {
    context: entry.context ?? null,
    toolCall: entry.toolCall ?? null,
    probedAt: Date.now(),
  }
}

/** Best-effort persist. A failure here costs a re-probe next start, nothing more. */
export async function writeCache(cache) {
  try {
    mkdirSync(path.dirname(cachePath()), { recursive: true, mode: 0o700 })
    writeFileSync(cachePath(), JSON.stringify(cache), { mode: 0o600 })
  } catch {
    // Intentionally silent: see the module comment.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/cache.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/opencode-tanzu-cache.js test/cache.test.js
git commit -m "feat(cache): persist probe results with TTL and negative caching"
```

---

### Task 5: Wire probing into the config hook

**Files:**
- Modify: `src/opencode-tanzu.js`
- Test: `test/plugin.test.js`

**Interfaces:**
- Consumes: `probeContextLength`, `probeToolCall` (Task 1, 2); `unknownChatIds` (Task 3); `readCache`, `getEntry`, `setEntry`, `writeCache` (Task 4).
- Produces: no new exports. The `config` hook enriches unknown cards with `max_model_len` before `resolveModels`, and applies probed `tool_call` afterward.

- [ ] **Step 1: Write the failing tests**

Append to `test/plugin.test.js`. The `withFetch`, `jsonResponse`, `withEnv`, `withDataHome`, `hooks`, `BASE` helpers already exist in this file.

```js
const OVER_LIMIT_400 = {
  error: { message: "max_tokens=999999999 cannot be greater than max_model_len=max_total_tokens=262144." },
}

/** A roster with one id the bundled table has never heard of. */
const ROSTER_WITH_UNKNOWN = { data: [{ id: "cyankiwi/Qwen3.6-27B-AWQ-INT4" }, { id: "acme/brand-new-9b" }] }

// REGRESSION (the INT4 -> NVFP4 swap, 2026-07-24): a model id the table does
// not know must get its real context from a probe, not the 8192 default that
// makes opencode compact in a loop.
test("an unknown model is probed and resolves at its served context", async () => {
  await withDataHome(() =>
    withEnv({ TANZU_GENAI_BASE_URL: BASE, TANZU_GENAI_API_KEY: "k" }, async () => {
      const cfg = {}
      const h = await hooks()
      await withFetch(async (url, init) => {
        if (String(url).endsWith("/models")) return jsonResponse(ROSTER_WITH_UNKNOWN)
        if (String(url).endsWith("/chat/completions")) {
          const body = JSON.parse(init.body)
          if (body.max_tokens === 999999999) return jsonResponse(OVER_LIMIT_400, 400)
          return jsonResponse({ choices: [{ message: { content: "x" } }] })
        }
        throw new Error(`unexpected url ${url}`)
      }, () => h.config(cfg))
      assert.equal(cfg.provider.tanzu.models["acme/brand-new-9b"].limit.context, 262144)
    }),
  )
})

test("a model already in the table is never probed", async () => {
  await withDataHome(() =>
    withEnv({ TANZU_GENAI_BASE_URL: BASE, TANZU_GENAI_API_KEY: "k" }, async () => {
      const cfg = {}
      const h = await hooks()
      let probes = 0
      await withFetch(async (url) => {
        if (String(url).endsWith("/models")) return jsonResponse(ROSTER)
        probes += 1
        return jsonResponse(OVER_LIMIT_400, 400)
      }, () => h.config(cfg))
      assert.equal(probes, 0, "table-backed models must not cost a request")
    }),
  )
})

test("an unprobeable model keeps the conservative default and still registers", async () => {
  await withDataHome(() =>
    withEnv({ TANZU_GENAI_BASE_URL: BASE, TANZU_GENAI_API_KEY: "k" }, async () => {
      const cfg = {}
      const h = await hooks()
      await withFetch(async (url) => {
        if (String(url).endsWith("/models")) return jsonResponse(ROSTER_WITH_UNKNOWN)
        // ollama path: a normal completion, no limit to read.
        return jsonResponse({ choices: [{ message: { content: "hi" } }] })
      }, () => h.config(cfg))
      assert.equal(cfg.provider.tanzu.models["acme/brand-new-9b"].limit.context, 8192)
    }),
  )
})

test("a cached probe result means no second probe on the next start", async () => {
  await withDataHome(() =>
    withEnv({ TANZU_GENAI_BASE_URL: BASE, TANZU_GENAI_API_KEY: "k" }, async () => {
      let probes = 0
      const impl = async (url, init) => {
        if (String(url).endsWith("/models")) return jsonResponse(ROSTER_WITH_UNKNOWN)
        probes += 1
        const body = JSON.parse(init.body)
        if (body.max_tokens === 999999999) return jsonResponse(OVER_LIMIT_400, 400)
        return jsonResponse({ choices: [{ message: { content: "x" } }] })
      }
      const first = await hooks()
      await withFetch(impl, () => first.config({}))
      const afterFirst = probes
      assert.ok(afterFirst > 0, "the first start must probe")

      const cfg2 = {}
      const second = await hooks()
      await withFetch(impl, () => second.config(cfg2))
      assert.equal(probes, afterFirst, "the second start must be served from cache")
      assert.equal(cfg2.provider.tanzu.models["acme/brand-new-9b"].limit.context, 262144)
    }),
  )
})

test("a probed tool_call:false overrides the optimistic default", async () => {
  await withDataHome(() =>
    withEnv({ TANZU_GENAI_BASE_URL: BASE, TANZU_GENAI_API_KEY: "k" }, async () => {
      const cfg = {}
      const h = await hooks()
      await withFetch(async (url, init) => {
        if (String(url).endsWith("/models")) return jsonResponse(ROSTER_WITH_UNKNOWN)
        const body = JSON.parse(init.body)
        if (body.max_tokens === 999999999) return jsonResponse(OVER_LIMIT_400, 400)
        return jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "no tools here" } }] })
      }, () => h.config(cfg))
      assert.equal(cfg.provider.tanzu.models["acme/brand-new-9b"].tool_call, false)
    }),
  )
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/plugin.test.js`
Expected: FAIL — the unknown model resolves at 8192 instead of 262144 (no probing wired in yet).

- [ ] **Step 3: Implement the orchestration**

In `src/opencode-tanzu.js`, extend the imports:

```js
import { resolveModels, TABLE, unknownChatIds } from "./opencode-tanzu-capabilities.js"
import { discoverModels, DiscoveryError, probeContextLength, probeToolCall } from "./opencode-tanzu-discovery.js"
import { getEntry, readCache, setEntry, writeCache } from "./opencode-tanzu-cache.js"
```

Add this helper above `export const TanzuPlugin`:

```js
/**
 * Fill in what the tile will not tell us. `/v1/models` reports ids only, so a
 * model with no bundled row would otherwise land on the 8192 default and make
 * opencode compact the session in a loop (the INT4 -> NVFP4 swap, 2026-07-24).
 *
 * Only unknown ids are probed — table-backed models keep their curated
 * modalities and tool_call, which no probe can recover — and every result,
 * including a negative one, is cached so a steady-state start issues no
 * requests at all.
 *
 * @returns {Promise<Map<string, boolean>>} probed tool_call verdicts by id
 */
async function enrichUnknownCards(cards, baseURL, apiKey) {
  const unknown = unknownChatIds(cards)
  const toolCalls = new Map()
  if (unknown.length === 0) return toolCalls

  const cache = readCache()
  let dirty = false

  const results = await Promise.all(
    unknown.map(async (id) => {
      const cached = getEntry(cache, baseURL, id)
      if (cached) return { id, context: cached.context, toolCall: cached.toolCall }
      const [context, toolCall] = await Promise.all([
        probeContextLength(baseURL, apiKey, id),
        probeToolCall(baseURL, apiKey, id),
      ])
      setEntry(cache, baseURL, id, { context, toolCall })
      dirty = true
      return { id, context, toolCall }
    }),
  )

  const byId = new Map(results.map((r) => [r.id, r]))
  for (const card of cards) {
    const result = byId.get(card?.id)
    if (!result) continue
    // applyServedLimit already prefers a card's max_model_len over the table.
    if (typeof result.context === "number" && result.context > 0) card.max_model_len = result.context
    if (typeof result.toolCall === "boolean") toolCalls.set(result.id, result.toolCall)
  }

  if (dirty) await writeCache(cache)
  return toolCalls
}
```

In the `config` hook, replace the live-discovery branch:

```js
        try {
          models = resolveModels(await discoverModels(creds.baseURL, creds.apiKey))
        } catch (err) {
```

with:

```js
        try {
          const cards = await discoverModels(creds.baseURL, creds.apiKey)
          let probedToolCalls = new Map()
          try {
            probedToolCalls = await enrichUnknownCards(cards, creds.baseURL, creds.apiKey)
          } catch (err) {
            // Enrichment is an optimization. Losing it costs accuracy on
            // unknown models, never the provider itself.
            console.error(`[tanzu] capability probing failed: ${err.message}. Using bundled defaults.`)
          }
          models = resolveModels(cards)
          // resolveModels' unknown-default assumes tool_call: true and takes no
          // per-card hint, so an observed `false` is applied here.
          for (const [id, toolCall] of probedToolCalls) {
            if (models[id]) models[id].tool_call = toolCall
          }
        } catch (err) {
```

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `node --test`
Expected: PASS — all tests green, including the pre-existing 42.

- [ ] **Step 5: Commit**

```bash
git add src/opencode-tanzu.js test/plugin.test.js
git commit -m "feat: probe unknown models for context and tool-call support"
```

---

### Task 6: Roster drift-check script

**Files:**
- Create: `scripts/check-roster-drift.mjs`
- Create: `test/drift.test.js`
- Modify: `package.json` (add a `drift` script)

**Interfaces:**
- Consumes: `TABLE` (existing), `unknownChatIds` (Task 3), `discoverModels` / `probeContextLength` (Task 1).
- Produces: `diffRoster(ids: string[], table: object) => {covered: string[], uncoveredChat: string[], excludedEmbeddings: string[]}` — exported from `scripts/check-roster-drift.mjs` for testing. The module only performs I/O when run directly.

- [ ] **Step 1: Write the failing tests**

Create `test/drift.test.js`:

```js
import { test } from "node:test"
import assert from "node:assert/strict"

import { diffRoster } from "../scripts/check-roster-drift.mjs"
import { TABLE } from "../src/opencode-tanzu-capabilities.js"

test("a fully covered roster reports no drift", () => {
  const ids = ["deepreinforce-ai/Ornith-1.0-35B", "google/gemma-4-31B-it-qat-w4a16-ct"]
  const out = diffRoster(ids, TABLE)
  assert.deepEqual(out.uncoveredChat, [])
  assert.deepEqual(out.covered.sort(), ids.sort())
})

// The exact shape of the 2026-07-24 swap: a new id nobody has a row for.
test("an unknown chat id is reported as drift", () => {
  const out = diffRoster(["poolside/Laguna-S-2.1-SOMETHING-NEW"], TABLE)
  assert.deepEqual(out.uncoveredChat, ["poolside/Laguna-S-2.1-SOMETHING-NEW"])
})

test("an embedding id is excluded, not reported as drift", () => {
  const out = diffRoster(["acme/text-embedding-3"], TABLE)
  assert.deepEqual(out.uncoveredChat, [])
  assert.deepEqual(out.excludedEmbeddings, ["acme/text-embedding-3"])
})

test("an empty roster produces empty buckets", () => {
  const out = diffRoster([], TABLE)
  assert.deepEqual(out, { covered: [], uncoveredChat: [], excludedEmbeddings: [] })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/drift.test.js`
Expected: FAIL — cannot find module `../scripts/check-roster-drift.mjs`.

- [ ] **Step 3: Implement the script**

Create `scripts/check-roster-drift.mjs`:

```js
#!/usr/bin/env node
/**
 * Report Tanzu foundation models the bundled capability table does not cover.
 *
 * The tile rotates served models (and their ids change with the quant or the
 * hardware), while the table is hand-maintained. Run this against a foundation
 * to find drift before a user does — an uncovered id means opencode falls back
 * to a conservative 8192 context for that model.
 *
 * Usage:
 *   TANZU_GENAI_BASE_URL=https://genai-proxy.sys.<foundation>/<instance>/openai/v1 \
 *   TANZU_GENAI_API_KEY="$(cf service-key <instance> <key> | tail -n +2 | jq -r .credentials.endpoint.api_key)" \
 *   node scripts/check-roster-drift.mjs [--probe]
 *
 * Exits 0 when every chat model is covered, 1 when drift is found, 2 on a
 * usage or connection error. The token is read from the environment only,
 * never from argv, so it does not land in shell history or `ps`.
 */

import { TABLE, unknownChatIds } from "../src/opencode-tanzu-capabilities.js"
import { discoverModels, probeContextLength } from "../src/opencode-tanzu-discovery.js"

/**
 * Pure split of a roster against a capability table. Exported for tests; the
 * network lives in main().
 *
 * The uncovered-chat bucket is delegated to `unknownChatIds` rather than
 * re-deriving the exclusion rules here — a second copy of that regex would
 * drift from the one the plugin actually applies, and this script exists to
 * detect drift, not create it.
 *
 * @param {string[]} ids
 * @param {object} table
 */
export function diffRoster(ids, table) {
  const covered = []
  const excludedEmbeddings = []
  const uncoveredChat = unknownChatIds((ids ?? []).filter(Boolean).map((id) => ({ id })))
  const uncovered = new Set(uncoveredChat)
  for (const id of ids ?? []) {
    if (!id || uncovered.has(id)) continue
    if (table[id]?.kind === "chat") covered.push(id)
    else excludedEmbeddings.push(id)
  }
  return { covered, uncoveredChat, excludedEmbeddings }
}

async function main() {
  const baseURL = process.env.TANZU_GENAI_BASE_URL
  const apiKey = process.env.TANZU_GENAI_API_KEY
  if (!baseURL || !apiKey) {
    console.error("Set TANZU_GENAI_BASE_URL and TANZU_GENAI_API_KEY. See the header of this file.")
    process.exit(2)
  }
  const probe = process.argv.includes("--probe")

  let cards
  try {
    cards = await discoverModels(baseURL, apiKey)
  } catch (err) {
    console.error(`Could not read the roster: ${err.message}`)
    if (err.hint) console.error(err.hint)
    process.exit(2)
  }

  const { covered, uncoveredChat, excludedEmbeddings } = diffRoster(
    cards.map((c) => c.id),
    TABLE,
  )

  console.log(`Foundation: ${baseURL}`)
  console.log(`\nCovered by the table (${covered.length}):`)
  for (const id of covered) console.log(`  ✓ ${id}  (context ${TABLE[id].context})`)

  if (excludedEmbeddings.length > 0) {
    console.log(`\nExcluded as non-chat (${excludedEmbeddings.length}):`)
    for (const id of excludedEmbeddings) console.log(`  - ${id}`)
  }

  if (uncoveredChat.length === 0) {
    console.log("\nNo drift: every chat model on this foundation has a table row.")
    return 0
  }

  console.log(`\nDRIFT — no table row (${uncoveredChat.length}):`)
  for (const id of uncoveredChat) {
    if (probe) {
      const context = await probeContextLength(baseURL, apiKey, id)
      console.log(`  ✗ ${id}  (probed context: ${context ?? "unavailable — backend does not report it"})`)
    } else {
      console.log(`  ✗ ${id}`)
    }
  }
  console.log(
    "\nThese resolve to a conservative 8192 context unless probing recovers the real one at runtime.\n" +
      "Re-run with --probe to read each model's served limit, then add a row to\n" +
      "src/opencode-tanzu-capabilities.js for curated metadata (modalities, tool_call).",
  )
  return 1
}

// Only touch the network when run directly, so importing this for tests is free.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main())
}
```

Then add to `package.json` `scripts`:

```json
    "drift": "node scripts/check-roster-drift.mjs"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/drift.test.js`
Expected: PASS.

Also confirm the usage guard works (no env set):

Run: `node scripts/check-roster-drift.mjs; echo "exit=$?"`
Expected: the "Set TANZU_GENAI_BASE_URL…" message and `exit=2`.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-roster-drift.mjs test/drift.test.js package.json
git commit -m "feat(scripts): roster drift check against the capability table"
```

---

### Task 7: CI workflow

**Files:**
- Create: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: the `node --test` suite from all prior tasks.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/test.yml`:

```yaml
name: test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: ["20", "lts/*", "current"]
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}

      # No install step: the plugin has zero runtime and zero dev dependencies.
      - name: Run tests
        run: node --test
```

- [ ] **Step 2: Verify the suite passes locally on the floor version**

Run: `node --test`
Expected: PASS (all tests green).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: run node --test on push and PR"
```

---

### Task 8: Install script covers the new module

**Files:**
- Modify: `install.sh`

**Interfaces:**
- Consumes: `src/opencode-tanzu-cache.js` (Task 4).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the cache module to the copied files**

In `install.sh`, change:

```bash
FILES=(opencode-tanzu.js opencode-tanzu-capabilities.js opencode-tanzu-discovery.js)
```

to:

```bash
FILES=(opencode-tanzu.js opencode-tanzu-capabilities.js opencode-tanzu-discovery.js opencode-tanzu-cache.js)
```

The Homebrew formula copies `Dir["src/*.js"]` by glob and needs no change.

- [ ] **Step 2: Verify a clean install lands all four files**

Run:

```bash
TMPCFG=$(mktemp -d) && XDG_CONFIG_HOME="$TMPCFG" ./install.sh && ls "$TMPCFG/opencode/plugins"
```

Expected: all four `opencode-tanzu*.js` files listed, including `opencode-tanzu-cache.js`.

- [ ] **Step 3: Verify uninstall removes them**

Run:

```bash
XDG_CONFIG_HOME="$TMPCFG" ./install.sh --uninstall && ls "$TMPCFG/opencode/plugins"
```

Expected: the directory is empty.

- [ ] **Step 4: Commit**

```bash
git add install.sh
git commit -m "fix(install): copy the new cache module"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md`
- Create: `CHANGELOG.md`

**Interfaces:**
- Consumes: behavior from Tasks 1–6.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Update the README Models section**

In `README.md`, immediately after the bullet list item that begins "A discovered id **not** in the table still appears", insert:

```markdown
- **Unknown ids are probed for their real context window.** The tile strips
  `max_model_len` from `/v1/models`, but vLLM reveals it when asked for an
  impossible `max_tokens`, so the plugin issues one cheap request per unknown
  model and uses the answer. Results (including "could not determine") are
  cached for a week under `$XDG_DATA_HOME/opencode/opencode-tanzu/discovery-cache.json`,
  so a steady-state start makes no extra requests. Models served through the
  tile's ollama backend (colon-tag ids like `qwen3:14b`) clamp instead of
  erroring and cannot be probed — they keep the conservative defaults.
```

- [ ] **Step 2: Add the "When the tile swaps a model" section**

In `README.md`, immediately before the `## Troubleshooting` heading, insert:

````markdown
## When the tile swaps a model

A foundation's served models rotate, and an id changes whenever the quant or the
serving hardware changes — `poolside/Laguna-S-2.1-INT4` became
`poolside/Laguna-S-2.1-NVFP4` when CDC moved that model to Blackwell. Because
the tile does not report `max_model_len`, a new id has no known context window.

The plugin now probes for it automatically, so in most cases there is nothing to
do. To check a foundation for models the bundled table does not cover:

```bash
export TANZU_GENAI_BASE_URL="https://genai-proxy.sys.<foundation>/<instance>/openai/v1"
export TANZU_GENAI_API_KEY="…"     # from `cf service-key <instance> <key>`
npm run drift -- --probe
```

To read one model's served limit by hand, ask for an impossible `max_tokens` —
the error carries the real number:

```bash
curl -s -H "Authorization: Bearer $TANZU_GENAI_API_KEY" -H "Content-Type: application/json" \
  "$TANZU_GENAI_BASE_URL/chat/completions" \
  -d '{"model":"<model-id>","messages":[{"role":"user","content":"hi"}],"max_tokens":999999999}'
# → max_tokens=999999999 cannot be greater than max_model_len=max_total_tokens=262144
```

Add a row to `src/opencode-tanzu-capabilities.js` when you want curated metadata
a probe cannot recover (modalities, a friendly name, a verified `tool_call`).
PRs welcome.
````

- [ ] **Step 3: Add the troubleshooting entry**

In `README.md`, immediately after the `## Troubleshooting` heading, insert:

```markdown
**opencode keeps compacting the session / the agent appears to loop**
Almost always a context-window miss, not a model problem: opencode is compacting
to stay under a context limit far smaller than the model really has. It happens
when a served id has no table row and could not be probed. Check what the
provider actually registered:

```bash
npm run drift -- --probe
```

If the model shows up under DRIFT with a probed context, upgrade the plugin
(`brew upgrade nkuhn-vmw/tap/opencode-tanzu && opencode-tanzu-install`, or
`git pull && ./install.sh`) and restart opencode — the plugin's model list is
built at startup. If the probe cannot determine it, pin the limit yourself with
a `models` override in `~/.config/opencode/opencode.json` (this is a plain
value, not the `{file:}` indirection that breaks startup):

```json
{ "provider": { "tanzu": { "models": {
  "<model-id>": { "limit": { "context": 262144, "output": 32768 } }
} } } }
```
```

- [ ] **Step 4: Add the roadmap note**

In `README.md`, immediately before the `## License` heading, insert:

```markdown
## Roadmap

Listing Tanzu in [models.dev](https://github.com/anomalyco/models.dev) — the
registry opencode reads its built-in provider catalog from — would make `tanzu`
a first-class provider id rather than one this plugin contributes. That is a
metadata-only PR upstream; this plugin would remain the home for live roster
discovery and the login flow, which a static registry entry cannot provide.
```

- [ ] **Step 5: Create the CHANGELOG**

Create `CHANGELOG.md`:

```markdown
# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-07-27

### Added
- Automatic context-window discovery for models with no bundled table row. The
  tile strips `max_model_len` from `/v1/models`, but vLLM reports it when asked
  for an impossible `max_tokens`, so unknown ids are probed once and cached.
- Tool-call probing for unknown models, replacing the optimistic assumption that
  every unknown model supports tools.
- A probe-result cache (`discovery-cache.json`, 7-day TTL) that also remembers
  negative results, so unprobeable backends are not re-probed every start.
- `scripts/check-roster-drift.mjs` (`npm run drift`) — reports foundation models
  the capability table does not cover, with `--probe` to read their real limits.
- CI: `node --test` on push and pull request.
- Docs: "When the tile swaps a model", a troubleshooting entry for the
  compaction/looping symptom, and a roadmap note about models.dev.

### Changed
- Unknown models now resolve at their real served context instead of always
  falling back to 8192.

## [0.1.2] — 2026-07-24

### Added
- `poolside/Laguna-S-2.1-NVFP4` at its served 262144 context. CDC swapped Laguna
  from the INT4 build to the Blackwell NVFP4 build; the new id fell to the 8192
  unknown-default and opencode compacted sessions nonstop.

## [0.1.1] — 2026-07-22

### Added
- `poolside/Laguna-S-2.1-INT4` at its served 131072 context.

### Changed
- Bundled-fallback tests derive the roster count from the table instead of
  hardcoding it, so adding a model cannot silently break them.

## [0.1.0] — 2026-07-22

### Added
- First public release: a zero-dependency opencode plugin registering a `tanzu`
  provider with live roster discovery, a login flow that validates credentials
  before saving, and no secrets in the opencode config file.
- `install.sh` and a Homebrew formula (`nkuhn-vmw/tap/opencode-tanzu`).
```

- [ ] **Step 6: Verify the README renders and links are intact**

Run: `grep -n "When the tile swaps a model\|keeps compacting\|## Roadmap" README.md`
Expected: three matches, one per inserted section.

- [ ] **Step 7: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: probing behavior, model-swap runbook, troubleshooting, changelog"
```

---

### Task 10: Release 0.2.0

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: a `v0.2.0` tag and GitHub release; the Homebrew formula bump happens in the tap repo (`/Users/nkuhn/claude/homebrew-tap`), which is outside this repo.

- [ ] **Step 1: Run the full suite one final time**

Run: `node --test`
Expected: PASS, zero failures.

- [ ] **Step 2: Bump the version**

In `package.json`, change `"version": "0.1.2"` to `"version": "0.2.0"`.

- [ ] **Step 3: Commit and tag**

```bash
git add package.json
git commit -m "0.2.0: context auto-discovery, drift tooling, docs"
git push origin main
git tag v0.2.0
git push origin v0.2.0
```

- [ ] **Step 4: Create the GitHub release**

```bash
gh release create v0.2.0 --title "v0.2.0" \
  --notes "Automatic context-window discovery for models with no bundled table row (the tile strips max_model_len; vLLM reveals it in an over-limit error), cached with a 7-day TTL. Adds tool-call probing, a roster drift-check script (npm run drift), CI, and docs covering the compaction-loop symptom. See CHANGELOG.md."
```

- [ ] **Step 5: Bump the Homebrew formula**

```bash
curl -sL https://github.com/nkuhn-vmw/opencode-tanzu/archive/refs/tags/v0.2.0.tar.gz | shasum -a 256
```

Then in `/Users/nkuhn/claude/homebrew-tap/Formula/opencode-tanzu.rb` update `url` to the `v0.2.0` tarball and `sha256` to the value printed above, and:

```bash
cd /Users/nkuhn/claude/homebrew-tap
git add Formula/opencode-tanzu.rb
git commit -m "opencode-tanzu 0.2.0"
git push origin main
```

- [ ] **Step 6: Install locally and verify**

```bash
cp /Users/nkuhn/claude/homebrew-tap/Formula/opencode-tanzu.rb /opt/homebrew/Library/Taps/nkuhn-vmw/homebrew-tap/Formula/
brew upgrade nkuhn-vmw/tap/opencode-tanzu
opencode-tanzu-install
ls ~/.config/opencode/plugins
```

Expected: four `opencode-tanzu*.js` files, including `opencode-tanzu-cache.js`.

---

## Notes for the implementer

- **Never let a probe break startup.** Every probe path returns `null` on
  failure. The config hook must still register the provider when probing fails
  entirely — there is a test for this.
- **Do not probe known models.** They carry curated modalities and `tool_call`
  that no probe can recover, and probing them would spend a request per model on
  every cold cache.
- **Negative caching is load-bearing.** Without it, the tile's ollama-served ids
  cost two requests on every single startup.
- The existing 42 tests must stay green throughout; run the full `node --test`
  (not just the file you touched) before each commit after Task 5.
