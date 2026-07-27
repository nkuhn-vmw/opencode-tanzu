/**
 * On-disk memo for probe results, so a model is interrogated at most once per
 * TTL per foundation. Lives beside the api key under opencode's data dir.
 *
 * This is a cache and nothing more: every failure path degrades to "no cached
 * value" rather than surfacing an error, because a bad cache must never stop
 * opencode from starting.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
  if (Date.now() - entry.probedAt > effectiveTtl) return undefined
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

/** Best-effort persist. A failure here costs a re-probe next start, nothing more. */
export async function writeCache(cache) {
  try {
    mkdirSync(path.dirname(cachePath()), { recursive: true, mode: 0o700 })
    writeFileSync(cachePath(), JSON.stringify(cache), { mode: 0o600 })
    // writeFileSync's mode only applies when it creates the file; an existing file
    // keeps its old (possibly world-readable) mode.
    chmodSync(cachePath(), 0o600)
  } catch {
    // Intentionally silent: see the module comment.
  }
}
