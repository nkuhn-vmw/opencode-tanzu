/**
 * On-disk memo for probe results, so a model is interrogated at most once per
 * TTL per foundation. Lives beside the api key under opencode's data dir.
 *
 * This is a cache and nothing more: every failure path degrades to "no cached
 * value" rather than surfacing an error, because a bad cache must never stop
 * opencode from starting.
 */

import { readFileSync } from "node:fs"
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"

/** Re-probe a model at most once a week; served limits change rarely. */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * TTL for an entry whose probe(s) were inconclusive — a timeout, DNS/TLS
 * failure, 429/503, a worker mid-restart. Distinct from a conclusive negative
 * (a backend that clamps instead of erroring, or a model that cleanly
 * declines a forced tool call): those are permanent answers and earn the full
 * `DEFAULT_TTL_MS`. An inconclusive one is "we don't know yet", and pinning it
 * for a week is exactly the compaction-loop incident this cache exists to
 * prevent — one unlucky startup must not cost a brand-new model its real
 * context for seven days. Short enough that the next normal opencode start
 * (VPN reconnected, tile worker back up) gets a fresh try.
 */
export const INCONCLUSIVE_TTL_MS = 30 * 60 * 1000

/**
 * Escalation schedule for an id that comes back inconclusive over and over.
 *
 * A single inconclusive probe is still retried quickly, at `INCONCLUSIVE_TTL_MS`
 * (~30 minutes) — that is the whole point of the conclusive/inconclusive
 * split: a genuinely transient blip (a timeout, a flaky VPN, a tile worker
 * mid-restart) must not pin a model at the wrong context for a week. But some
 * backends are permanently un-probeable rather than transiently unlucky: the
 * tile's ollama-style ids (`qwen3:14b`, `qwen3:30b-a3b`, `gemma4:e4b`,
 * `hf.co/prism-ml/Bonsai-8B-gguf:Q1_0`) clamp `max_tokens` instead of
 * erroring, so the over-limit probe doesn't fail fast — it actually starts
 * generating and hits the probe's `AbortSignal` timeout every single time.
 * Retrying that every 30 minutes forever means opencode pays an ~8-second
 * startup stall on a fixed cadence, permanently, which is the exact
 * regression this schedule exists to stop.
 *
 * `attempts` is the number of CONSECUTIVE inconclusive results for an entry
 * (reset to 0 the moment a conclusive one lands — see `setEntry`). The
 * effective TTL doubles with each consecutive miss, starting at
 * `INCONCLUSIVE_TTL_MS` (30m -> 1h -> 2h -> 4h -> ...), capped at
 * `DEFAULT_TTL_MS` (7 days) so a permanently-inconclusive id eventually
 * settles at the same cadence as a conclusive one, never past it.
 *
 * `attempts` missing or not a positive number (an entry written by
 * pre-backoff code, or any other malformed value) is treated as the FIRST
 * miss, not an already-escalated one — see `CACHE_SCHEMA_VERSION` for why
 * that default is deliberate and safe.
 *
 * @param {number} [attempts] consecutive inconclusive count from the entry.
 * @returns {number} the TTL, in ms, to use for an inconclusive entry.
 */
export function inconclusiveTtlMs(attempts) {
  const count = typeof attempts === "number" && attempts > 0 ? attempts : 1
  const ttl = INCONCLUSIVE_TTL_MS * 2 ** (count - 1)
  return Math.min(ttl, DEFAULT_TTL_MS)
}

/**
 * Bumped whenever the cache ENTRY shape changes in a way that makes a file
 * written by older code unsafe to trust as-is. This is the first version to
 * carry it. No released version of this plugin has ever shipped with a
 * discovery cache, so the public is unaffected — but this branch runs on the
 * maintainer's own machines, and an existing `discovery-cache.json` predates
 * the conclusive/inconclusive TTL split (the C1/C2 fixes): it can hold
 * `toolCall: false` values produced by the C1 truncation bug and
 * `context: null` values produced by transient C2-era failures, neither a
 * real, permanent answer. `readCache` refuses to trust ANY entry from a file
 * that isn't stamped with the CURRENT version — the whole file is treated as
 * though it were missing, exactly like a corrupt or unreadable one. That
 * costs a one-time re-probe per id on the first run after an upgrade
 * (bounded, same as any cold cache, by `PROBE_ID_CAP`/
 * `PROBE_CONCURRENCY_LIMIT`), never a stale answer surviving the upgrade.
 *
 * NOT bumped for the inconclusive-backoff `attempts` field added alongside
 * `inconclusiveTtlMs` above, even though it is a new field on the entry
 * shape. An entry written earlier today by this same branch (before backoff
 * existed) has no `attempts` field at all; `inconclusiveTtlMs` treats that
 * exactly like `attempts: 1` — the first-miss, ~30-minute TTL, i.e. the
 * FLAT behavior every inconclusive entry already had. That is not merely
 * "safe", it is bit-for-bit the old behavior: no existing entry can read
 * back with a longer TTL than it would have under the pre-backoff code, so
 * there is nothing for a version bump to protect against here. Contrast
 * with the C1/C2 upgrade above, where an old entry's `conclusive`/`context`
 * values could actively lie; a missing `attempts` cannot, because "unknown"
 * and "first attempt" collapse to the same number.
 */
export const CACHE_SCHEMA_VERSION = 1

/**
 * opencode's own data dir — `$XDG_DATA_HOME/opencode`, else
 * `~/.local/share/opencode`. Mirrors Global.Path.data in opencode 1.18.1.
 *
 * The single source of truth: the api-key file (opencode-tanzu.js) and the
 * cache file (this module) MUST land in the same directory, so this is
 * exported here — the lower-level, dependency-free module — and imported by
 * opencode-tanzu.js rather than redefined there.
 */
export function dataDir() {
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

/**
 * @returns {object} the cache, or {} when missing/corrupt/unreadable/stale-schema
 *
 * `typeof [] === "object"`, so an array on disk must be rejected explicitly —
 * otherwise `setEntry` attaches string-keyed properties to it that
 * `JSON.stringify` silently drops on the next write, and caching disables
 * itself forever with no error anywhere.
 *
 * A file whose `schemaVersion` does not match `CACHE_SCHEMA_VERSION` — missing
 * entirely (every pre-0.2.0 shape) or an older number — is discarded WHOLESALE
 * rather than partially trusted: see `CACHE_SCHEMA_VERSION` for why entries
 * from before the conclusive/inconclusive split must not be honored. Starting
 * fresh here (rather than gating per-entry in `getEntry`) also means a stale
 * entry can never be "grandfathered in" merely because some OTHER id's probe
 * later stamps the file with the current version.
 */
export function readCache() {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed.schemaVersion === CACHE_SCHEMA_VERSION ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * @param {number} [ttlMs] explicit override. When omitted, the TTL is picked
 *   from the entry itself: `DEFAULT_TTL_MS` for a conclusive entry (the
 *   default, so old entries written before `conclusive` existed keep their
 *   original week-long behavior), or the backoff-escalated TTL from
 *   `inconclusiveTtlMs(entry.attempts)` when the entry is explicitly marked
 *   `conclusive: false` — ~30 minutes on the first miss, doubling on each
 *   consecutive one, capped at `DEFAULT_TTL_MS`.
 * @returns {{context: number|null, toolCall: boolean|null, conclusive: boolean, attempts?: number, probedAt: number} | undefined}
 *   the entry when present and fresh — including a negative (null context) one,
 *   which is a legitimate cached answer for a backend that cannot be probed.
 */
export function getEntry(cache, baseURL, id, ttlMs) {
  const entry = cache?.[keyFor(baseURL, id)]
  if (!entry || typeof entry.probedAt !== "number") return undefined
  const effectiveTtl = ttlMs ?? (entry.conclusive === false ? inconclusiveTtlMs(entry.attempts) : DEFAULT_TTL_MS)
  const age = Date.now() - entry.probedAt
  // A negative age means `probedAt` is in the future — an NTP correction, a
  // resumed suspended VM, a dual-boot clock skew. Bound BOTH ends: an entry
  // must not be immortal just because it looks infinitely fresh, so treat a
  // future timestamp as expired rather than as the freshest possible entry.
  if (age < 0 || age > effectiveTtl) return undefined
  return entry
}

/**
 * Mutates `cache` in place; call `writeCache` to persist.
 *
 * @param {{context?: number|null, toolCall?: boolean|null, conclusive?: boolean}} entry
 *   `conclusive` defaults to `true` — a caller that doesn't know about the
 *   inconclusive/conclusive split gets the pre-existing week-long behavior.
 *   Pass `false` when either probe that fed this entry was inconclusive, so
 *   `getEntry` retries it after the (escalating) inconclusive TTL instead of
 *   pinning it for a week.
 *
 * Tracks `attempts`, the number of CONSECUTIVE inconclusive results: reset to
 * `0` whenever this call's result is conclusive, otherwise one more than
 * whatever was already on the entry at this key (0 if there was none, or it
 * wasn't a number). This is what `getEntry` feeds to `inconclusiveTtlMs` to
 * compute the escalated retry TTL — see that function for the schedule and
 * why an id that stays inconclusive forever (the tile's ollama-style
 * clamping backends) should be retried progressively less often rather than
 * on a flat 30-minute cadence forever.
 *
 * Also stamps `cache.schemaVersion = CACHE_SCHEMA_VERSION` on the cache
 * object itself, so a freshly (re)probed cache is marked current the moment
 * anything is written into it — see `CACHE_SCHEMA_VERSION` and `readCache`.
 */
export function setEntry(cache, baseURL, id, entry) {
  cache.schemaVersion = CACHE_SCHEMA_VERSION
  const key = keyFor(baseURL, id)
  const conclusive = entry.conclusive ?? true
  const previousAttempts = cache[key]?.attempts
  const attempts = conclusive ? 0 : (typeof previousAttempts === "number" ? previousAttempts : 0) + 1
  cache[key] = {
    context: entry.context ?? null,
    toolCall: entry.toolCall ?? null,
    conclusive,
    attempts,
    probedAt: Date.now(),
  }
}

/**
 * Best-effort persist. A failure here costs a re-probe next start, nothing more.
 *
 * Writes to a temp file in the same directory and `rename`s it over the live
 * path, rather than writing the live path directly: two opencode instances
 * starting at once (routine — one window per project) is exactly the case a
 * direct `writeFileSync` would let interleave and clobber, and a concurrent
 * reader could observe a truncated file mid-write. A same-filesystem rename
 * is atomic, so a reader always sees either the old file or the fully-written
 * new one, never a partial write. The temp name includes a random UUID so two
 * concurrent writers never collide on the same temp path either.
 */
export async function writeCache(cache) {
  const target = cachePath()
  const dir = path.dirname(target)
  const tmp = path.join(dir, `.discovery-cache.${randomUUID()}.tmp`)
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(tmp, JSON.stringify(cache), { mode: 0o600 })
    // writeFile's mode only applies when it creates the file; enforce 0600
    // explicitly so a stricter umask never leaves the temp file (and thus the
    // renamed final file) world- or group-readable.
    await chmod(tmp, 0o600)
    await rename(tmp, target)
  } catch {
    // Intentionally silent: see the module comment above.
    await rm(tmp, { force: true }).catch(() => {})
  }
}
