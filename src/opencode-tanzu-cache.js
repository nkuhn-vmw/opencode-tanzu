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
