import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  CACHE_SCHEMA_VERSION,
  DEFAULT_TTL_MS,
  INCONCLUSIVE_TTL_MS,
  cachePath,
  getEntry,
  inconclusiveTtlMs,
  readCache,
  setEntry,
  writeCache,
} from "../src/opencode-tanzu-cache.js"

const BASE = "https://genai-proxy.example.test/inst/openai/v1"

/**
 * `setEntry` now also stamps a `schemaVersion` key onto the cache object
 * (F5), so `Object.keys(cache)[0]` can no longer be trusted to be the entry
 * key — it depends on insertion order which key landed first. Pick the one
 * key that isn't `schemaVersion` instead.
 */
function onlyEntryKey(cache) {
  return Object.keys(cache).find((k) => k !== "schemaVersion")
}

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

// M2 — `typeof [] === "object"`, so a naive object-check would accept an
// array on disk; `setEntry` would then attach string-keyed properties to it
// that `JSON.stringify` silently drops on the next write, disabling caching
// forever with no error anywhere.
test("an array on disk reads as empty rather than being accepted as the cache", async () => {
  await withDataHome(() => {
    mkdirSync(path.dirname(cachePath()), { recursive: true })
    writeFileSync(cachePath(), "[]")
    assert.deepEqual(readCache(), {})
  })
})

// ---------------------------------------------------------------------------
// F5 — pre-fix cache entries must not survive the upgrade.
//
// No released version of this plugin ever shipped a discovery cache, so the
// public is unaffected — but this branch has run on the maintainer's own
// machines, and an existing discovery-cache.json predates the
// conclusive/inconclusive split (C1/C2): it can hold `toolCall: false`
// entries produced by the C1 truncation bug and `context: null` entries
// produced by transient C2-era failures, neither a real, permanent answer.
// `readCache` must refuse the WHOLE file when its `schemaVersion` doesn't
// match the current one, exactly like a missing or corrupt file — not just
// individual suspicious-looking entries.
// ---------------------------------------------------------------------------

test("a cache file with no schemaVersion at all (the exact pre-fix shape) reads as empty", async () => {
  await withDataHome(() => {
    mkdirSync(path.dirname(cachePath()), { recursive: true })
    // The literal shape written by every pre-fix run: a flat map, no
    // schemaVersion key, entries that look perfectly fresh and conclusive.
    const legacy = {
      [`${BASE}\nacme/brand-new-9b`]: { context: null, toolCall: false, conclusive: true, probedAt: Date.now() },
    }
    writeFileSync(cachePath(), JSON.stringify(legacy))
    assert.deepEqual(readCache(), {}, "a file with no schemaVersion must be discarded wholesale, not partially trusted")
    assert.equal(
      getEntry(readCache(), BASE, "acme/brand-new-9b"),
      undefined,
      "an entry from a schema-less file must not be honored even though it looks fresh and conclusive",
    )
  })
})

test("a cache file with an older schemaVersion reads as empty", async () => {
  await withDataHome(() => {
    mkdirSync(path.dirname(cachePath()), { recursive: true })
    const stale = {
      schemaVersion: CACHE_SCHEMA_VERSION - 1,
      [`${BASE}\na/b`]: { context: 262144, toolCall: true, conclusive: true, probedAt: Date.now() },
    }
    writeFileSync(cachePath(), JSON.stringify(stale))
    assert.deepEqual(readCache(), {})
  })
})

test("a cache file stamped with the current schemaVersion is honored normally", async () => {
  await withDataHome(() => {
    mkdirSync(path.dirname(cachePath()), { recursive: true })
    const current = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      [`${BASE}\na/b`]: { context: 262144, toolCall: true, conclusive: true, probedAt: Date.now() },
    }
    writeFileSync(cachePath(), JSON.stringify(current))
    const entry = getEntry(readCache(), BASE, "a/b")
    assert.notEqual(entry, undefined)
    assert.equal(entry.context, 262144)
  })
})

test("setEntry stamps the current schemaVersion so a freshly-probed cache survives its own next read", async () => {
  await withDataHome(async () => {
    const cache = {}
    setEntry(cache, BASE, "a/b", { context: 1000 })
    assert.equal(cache.schemaVersion, CACHE_SCHEMA_VERSION)
    await writeCache(cache)
    assert.notEqual(getEntry(readCache(), BASE, "a/b"), undefined, "a cache setEntry just wrote must read back as a hit")
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
  const key = onlyEntryKey(cache)
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

// C2 — a conclusive entry (a backend that clamps forever, or a definite
// tool-call verdict) earns the full week: it must NOT be treated as stale
// just because it is older than the 30-minute inconclusive window.
test("a conclusive entry survives past the inconclusive TTL and is honored for the full week", () => {
  const cache = {}
  setEntry(cache, BASE, "qwen3:14b", { context: null, toolCall: true, conclusive: true })
  const key = onlyEntryKey(cache)
  // Well past INCONCLUSIVE_TTL_MS (30m), comfortably inside DEFAULT_TTL_MS (7d).
  cache[key].probedAt = Date.now() - (INCONCLUSIVE_TTL_MS + 60 * 1000)
  const entry = getEntry(cache, BASE, "qwen3:14b")
  assert.notEqual(entry, undefined, "a conclusive entry must not expire on the short TTL")
  assert.equal(entry.context, null)
})

test("a conclusive entry does eventually expire, on the long TTL", () => {
  const cache = {}
  setEntry(cache, BASE, "a/b", { context: 262144, conclusive: true })
  const key = onlyEntryKey(cache)
  cache[key].probedAt = Date.now() - (DEFAULT_TTL_MS + 1)
  assert.equal(getEntry(cache, BASE, "a/b"), undefined)
})

// C2 — an inconclusive entry (timeout, 5xx, a worker mid-restart) must be
// retried well before the week is up. This is the test that pins the actual
// bug fix: with the pre-fix cache, this same setup would still be a hit.
test("an inconclusive entry expires on the short TTL and is retried, not pinned for a week", () => {
  const cache = {}
  setEntry(cache, BASE, "a/b", { context: null, toolCall: null, conclusive: false })
  const key = onlyEntryKey(cache)
  // Past the 30-minute inconclusive TTL, but nowhere near the 7-day default —
  // a pre-fix cache that applied DEFAULT_TTL_MS uniformly would still call
  // this a hit.
  cache[key].probedAt = Date.now() - (INCONCLUSIVE_TTL_MS + 60 * 1000)
  assert.equal(getEntry(cache, BASE, "a/b"), undefined, "an inconclusive entry must be retried after 30 minutes")
})

test("an inconclusive entry is still honored within its short TTL", () => {
  const cache = {}
  setEntry(cache, BASE, "a/b", { context: null, toolCall: null, conclusive: false })
  const entry = getEntry(cache, BASE, "a/b")
  assert.notEqual(entry, undefined, "freshly-written inconclusive entry must still be a hit until it expires")
})

// ---------------------------------------------------------------------------
// Inconclusive backoff — an id that is inconclusive on EVERY attempt (the
// tile's ollama-style ids: qwen3:14b, qwen3:30b-a3b, gemma4:e4b,
// hf.co/prism-ml/Bonsai-8B-gguf:Q1_0 — clamp max_tokens instead of erroring,
// so the over-limit probe times out every single time) must back off rather
// than being re-probed on a flat 30-minute cadence forever. A single miss
// must still behave exactly like the pre-backoff flat TTL — that is the C2
// guarantee, and must not regress just because escalation now exists.
// ---------------------------------------------------------------------------

test("a first inconclusive result is still retried after ~INCONCLUSIVE_TTL_MS (C2 guarantee, unchanged by backoff)", () => {
  const cache = {}
  setEntry(cache, BASE, "qwen3:14b", { context: null, toolCall: null, conclusive: false })
  const key = onlyEntryKey(cache)
  assert.equal(cache[key].attempts, 1, "the first inconclusive result must record exactly one attempt")
  // Just before the base TTL: still a hit.
  cache[key].probedAt = Date.now() - (INCONCLUSIVE_TTL_MS - 1000)
  assert.notEqual(getEntry(cache, BASE, "qwen3:14b"), undefined, "a first miss must still be honored inside ~30 minutes")
  // Just past the base TTL: must expire and be retried, exactly like before backoff existed.
  cache[key].probedAt = Date.now() - (INCONCLUSIVE_TTL_MS + 60 * 1000)
  assert.equal(getEntry(cache, BASE, "qwen3:14b"), undefined, "a first miss must still expire at ~30 minutes, not later")
})

test("repeated inconclusive results escalate the retry TTL on a doubling schedule (30m, 1h, 2h, 4h, ...)", () => {
  const cache = {}
  setEntry(cache, BASE, "qwen3:14b", { conclusive: false }) // attempt 1 -> 30m
  setEntry(cache, BASE, "qwen3:14b", { conclusive: false }) // attempt 2 -> 1h
  setEntry(cache, BASE, "qwen3:14b", { conclusive: false }) // attempt 3 -> 2h
  const key = onlyEntryKey(cache)
  assert.equal(cache[key].attempts, 3, "three consecutive inconclusive results must record three attempts")

  assert.equal(inconclusiveTtlMs(1), INCONCLUSIVE_TTL_MS)
  assert.equal(inconclusiveTtlMs(2), INCONCLUSIVE_TTL_MS * 2)
  assert.equal(inconclusiveTtlMs(3), INCONCLUSIVE_TTL_MS * 4)

  // Past the FLAT 30-minute TTL but well inside the escalated ~2h TTL the
  // third miss actually earns: a flat-TTL implementation would wrongly
  // expire this and re-probe every 30 minutes forever, which is the exact
  // regression this schedule exists to fix.
  cache[key].probedAt = Date.now() - (INCONCLUSIVE_TTL_MS * 2 + 60 * 1000)
  assert.notEqual(
    getEntry(cache, BASE, "qwen3:14b"),
    undefined,
    "a third consecutive miss must survive well past the flat 30-minute TTL",
  )

  // Past its OWN escalated TTL (2h): must still eventually expire and retry.
  cache[key].probedAt = Date.now() - (INCONCLUSIVE_TTL_MS * 4 + 60 * 1000)
  assert.equal(
    getEntry(cache, BASE, "qwen3:14b"),
    undefined,
    "a third consecutive miss must still expire at its own ~2h TTL",
  )
})

test("the escalated TTL is capped at DEFAULT_TTL_MS and never exceeds it", () => {
  // Directly: a huge attempts count must not escalate past the cap.
  assert.equal(inconclusiveTtlMs(100), DEFAULT_TTL_MS, "the schedule must cap at DEFAULT_TTL_MS, not grow unbounded")

  const cache = {}
  for (let i = 0; i < 20; i++) setEntry(cache, BASE, "qwen3:14b", { conclusive: false })
  const key = onlyEntryKey(cache)
  assert.equal(cache[key].attempts, 20)

  // Just inside the cap: still a hit.
  cache[key].probedAt = Date.now() - (DEFAULT_TTL_MS - 1000)
  assert.notEqual(getEntry(cache, BASE, "qwen3:14b"), undefined, "an entry within the capped TTL must be a hit")

  // Just past the cap: must expire — 20 consecutive misses must never earn
  // MORE retry headroom than a conclusive result gets.
  cache[key].probedAt = Date.now() - (DEFAULT_TTL_MS + 1000)
  assert.equal(
    getEntry(cache, BASE, "qwen3:14b"),
    undefined,
    "even after many consecutive misses the TTL must not exceed DEFAULT_TTL_MS",
  )
})

test("a conclusive result resets the consecutive-inconclusive escalation to zero", () => {
  const cache = {}
  setEntry(cache, BASE, "qwen3:14b", { conclusive: false })
  setEntry(cache, BASE, "qwen3:14b", { conclusive: false })
  let key = onlyEntryKey(cache)
  assert.equal(cache[key].attempts, 2, "two consecutive misses must record two attempts before the reset")

  setEntry(cache, BASE, "qwen3:14b", { context: 131072, conclusive: true })
  key = onlyEntryKey(cache)
  assert.equal(cache[key].attempts, 0, "a conclusive result must reset the consecutive-inconclusive count to zero")

  // The schedule must restart from the first-miss TTL, not continue as if
  // escalation had never been reset.
  cache[key].probedAt = Date.now() - (INCONCLUSIVE_TTL_MS + 60 * 1000)
  assert.notEqual(
    getEntry(cache, BASE, "qwen3:14b"),
    undefined,
    "a conclusive entry must be honored for the full week regardless of prior escalation",
  )

  setEntry(cache, BASE, "qwen3:14b", { conclusive: false })
  assert.equal(cache[key].attempts, 1, "the next inconclusive result after a reset must start the schedule over at attempt 1")
})

// An entry written by pre-backoff code (or any hand-edited/malformed cache)
// has no `attempts` field at all. This must default to the FIRST-miss TTL
// (~30 minutes) — exactly the flat behavior every inconclusive entry already
// had — never to an already-escalated one. Treating a missing field as "many
// attempts" would silently pin a brand-new inconclusive entry at a long TTL
// with no probe ever having actually failed that many times; treating it as
// "zero" would conflict with `getEntry`'s `entry.conclusive === false` check
// already selecting the inconclusive branch. "first miss" is the only
// reading consistent with the pre-existing flat TTL, which is exactly why no
// CACHE_SCHEMA_VERSION bump was needed for this field — see the comment on
// CACHE_SCHEMA_VERSION in opencode-tanzu-cache.js.
test("an entry missing the attempts field defaults to a first-miss TTL, not an already-escalated one", () => {
  const cache = {}
  const key = `${BASE}\nqwen3:14b`
  cache[key] = {
    context: null,
    toolCall: null,
    conclusive: false,
    // No `attempts` field — the exact shape written before this change.
    probedAt: Date.now() - (INCONCLUSIVE_TTL_MS + 60 * 1000),
  }
  assert.equal(
    getEntry(cache, BASE, "qwen3:14b"),
    undefined,
    "a missing attempts field must behave like attempt 1 (expires at ~30m), matching pre-backoff flat-TTL behavior",
  )
  assert.equal(inconclusiveTtlMs(undefined), INCONCLUSIVE_TTL_MS, "inconclusiveTtlMs must treat a missing count as a first miss")
})

// A caller that writes an entry via `setEntry` without passing `conclusive`
// (setEntry's own default parameter, not a cross-version compatibility
// case) keeps the original week-long behavior. Note this is NOT the F5
// scenario: `setEntry` always stamps the CURRENT `schemaVersion`, so an
// entry produced this way is never mistaken for a genuine pre-fix file —
// see the schemaVersion tests below for that real upgrade scenario, which
// `readCache` guards instead.
test("an entry with no conclusive field defaults to the long TTL", () => {
  const cache = {}
  setEntry(cache, BASE, "a/b", { context: 1000 })
  const key = onlyEntryKey(cache)
  cache[key].probedAt = Date.now() - (INCONCLUSIVE_TTL_MS + 60 * 1000)
  assert.notEqual(getEntry(cache, BASE, "a/b"), undefined, "no conclusive field must default to conclusive:true")
})

// I4 — clock skew (NTP correction, a resumed suspended VM, a dual-boot clock)
// can put `probedAt` in the future. The pre-fix check (`Date.now() -
// probedAt > ttlMs`) goes negative in that case and never exceeds the TTL, so
// the entry — including a bad negative one — reads as fresh forever. Both
// ends of the age must be bounded.
test("an entry with a probedAt in the future (clock skew) is treated as expired, not immortal", () => {
  const cache = {}
  setEntry(cache, BASE, "a/b", { context: 1000 })
  const key = onlyEntryKey(cache)
  cache[key].probedAt = Date.now() + 60 * 60 * 1000 // one hour in the future
  assert.equal(
    getEntry(cache, BASE, "a/b"),
    undefined,
    "a future probedAt must not be treated as infinitely fresh",
  )
})

test("entries are scoped per foundation, not shared across base URLs", () => {
  const cache = {}
  setEntry(cache, BASE, "a/b", { context: 1000 })
  assert.equal(getEntry(cache, "https://other.example.test/inst/openai/v1", "a/b"), undefined)
})

test("writeCache swallows a write failure instead of throwing", async () => {
  await withDataHome(async () => {
    mkdirSync(path.dirname(path.dirname(cachePath())), { recursive: true })
    // A file where the cache directory must go makes mkdir fail.
    writeFileSync(path.dirname(cachePath()), "")
    await writeCache({ x: { context: 1, probedAt: Date.now() } })
  })
})

test("writeCache enforces 0600 permissions even when the file already exists", async () => {
  await withDataHome(async () => {
    mkdirSync(path.dirname(cachePath()), { recursive: true })
    // Create cache file with loose permissions (0644).
    writeFileSync(cachePath(), "{}", { mode: 0o644 })
    // Verify it was created with loose permissions.
    assert.equal(statSync(cachePath()).mode & 0o777, 0o644)
    // Now writeCache should enforce 0600 even on the existing file.
    const cache = { x: { context: 262144, toolCall: true, probedAt: Date.now() } }
    await writeCache(cache)
    // Assert the file now has 0600 permissions.
    assert.equal(statSync(cachePath()).mode & 0o777, 0o600)
  })
})
