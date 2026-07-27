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
