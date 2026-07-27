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
 * @returns {object} the cache, or {} when missing/corrupt/unreadable
 *
 * `typeof [] === "object"`, so an array on disk must be rejected explicitly —
 * otherwise `setEntry` attaches string-keyed properties to it that
 * `JSON.stringify` silently drops on the next write, and caching disables
 * itself forever with no error anywhere.
 */
export function readCache() {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * @param {number} [ttlMs] explicit override. When omitted, the TTL is picked
 *   from the entry itself: `DEFAULT_TTL_MS` for a conclusive entry (the
 *   default, so old entries written before `conclusive` existed keep their
 *   original week-long behavior), `INCONCLUSIVE_TTL_MS` when the entry is
 *   explicitly marked `conclusive: false`.
 * @returns {{context: number|null, toolCall: boolean|null, conclusive: boolean, probedAt: number} | undefined}
 *   the entry when present and fresh — including a negative (null context) one,
 *   which is a legitimate cached answer for a backend that cannot be probed.
 */
export function getEntry(cache, baseURL, id, ttlMs) {
  const entry = cache?.[keyFor(baseURL, id)]
  if (!entry || typeof entry.probedAt !== "number") return undefined
  const effectiveTtl = ttlMs ?? (entry.conclusive === false ? INCONCLUSIVE_TTL_MS : DEFAULT_TTL_MS)
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
 *   `getEntry` retries it after `INCONCLUSIVE_TTL_MS` instead of pinning it
 *   for a week.
 */
export function setEntry(cache, baseURL, id, entry) {
  cache[keyFor(baseURL, id)] = {
    context: entry.context ?? null,
    toolCall: entry.toolCall ?? null,
    conclusive: entry.conclusive ?? true,
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
