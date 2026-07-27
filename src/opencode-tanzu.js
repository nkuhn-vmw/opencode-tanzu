/**
 * opencode v1 plugin: registers the "tanzu" provider.
 *
 * ---------------------------------------------------------------------------
 * TASK 3 / STEP 1 FINDING — how the `config` hook gets what the `auth` prompt
 * collected. Investigated against opencode 1.18.1 (installed locally) and the
 * `goniz/opencode-local-provider` precedent. Conclusions are empirical:
 *
 *   Candidate 1 — "PluginInput.client exposes stored auth": FALSE.
 *     @opencode-ai/sdk's client `auth` namespace is write-only for our purpose:
 *     { remove, start, callback, authenticate, set } — `set` writes, and the
 *     rest are MCP OAuth. There is NO auth read/get/list method. Verified in
 *     dist/gen/sdk.gen.d.ts (class Auth) and by walking a live client object.
 *
 *   Candidate 2 — "auth.loader supplies options": TRUE, and now load-bearing.
 *     The type is real: loader?: (auth: () => Promise<Auth>, provider: Provider)
 *     => Promise<Record<string, any>>, and it does fire for a novel id (config
 *     hook creates the entry at provider.ts:1418, loader runs at :1542). It CAN
 *     read the auth store. But it returns `options` only and runs long after the
 *     config hook has already had to decide the model roster — so it can carry
 *     credentials for *inference*, never for *discovery*. We use it for exactly
 *     that: a base URL with no key registers the provider off the bundled table
 *     and the loader supplies the key at inference time (see `loader` below).
 *
 *   Candidate 3 — "read auth.json directly": rejected, brittle, not needed.
 *
 *   What the precedent ACTUALLY does (a fourth path, and the one we adopt):
 *     it never bridges auth -> config at all. Its `authorize()` persists the URL
 *     into opencode's *config file* via the v2 SDK's global.config.update(), and
 *     its `config` hook reads it straight back off the `cfg` object opencode
 *     passes in (cfg.provider.local.options.targets). The round-trip is
 *     config -> disk -> config. Its authorize() even returns key: "".
 *
 * We implement that same bridge with ZERO dependencies:
 *   - READ is free: `cfg.provider.tanzu.options` is just the Config handed to
 *     the config hook; no SDK needed.
 *   - WRITE needs `/global/config`, which the v1 client does NOT expose (its
 *     `global` namespace has only `event`; its `config.update` is PATCH /config,
 *     which I verified returns 200 but does NOT persist). That is precisely why
 *     the precedent builds a v2 client. We cannot add that dependency, so we
 *     PATCH /global/config directly, reusing the injected client's own transport
 *     (fetch + headers) so a password-protected server still works.
 *
 * ---------------------------------------------------------------------------
 * REVIEW FIX — THE CLIENT FETCH IS REQUEST-ONLY. Read this before touching
 * `persistOptions`. `createOpencodeClient` injects
 *
 *     const customFetch = (req) => { req.timeout = false; return fetch(req) }
 *
 * (sdk/dist/client.js) and the client config types it `fetch?: (request:
 * Request) => ReturnType<typeof fetch>`. It is **arity 1**. Calling
 * `doFetch(url, init)` silently discards `init` — the wire request degrades to a
 * bare `GET /global/config`, which is a real 200 route. `res.ok` is then true,
 * `authorize` reports success, and nothing is written. A status code is not
 * proof of a write. So: build a `Request`, pass it as the ONLY argument, and
 * verify the merged config echoed back actually contains what we sent.
 *
 * SECRETS DO NOT GO IN THE CONFIG FILE, AND NEITHER DOES A `{file:…}` POINTER
 * AT ONE. The key is written to a 0600 file under opencode's own data dir and
 * the persisted config names no key AT ALL — `authorize` persists `baseURL` and
 * nothing else. The config hook reads the key file ITSELF (see `readKeyFile`).
 *
 * Do not "helpfully" reintroduce `"apiKey": "{file:<path>}"` here. It was tried,
 * and it bricks opencode: config `{file:…}` references are resolved AND
 * validated before any plugin loads, so if the key file goes missing —
 * `opencode uninstall --keep-config` removes the data dir and keeps the config,
 * an exact path into this — opencode refuses to start for EVERY provider:
 *
 *     Error: Configuration is invalid at ~/.config/opencode/opencode.json:
 *       bad file reference: "{file:/…/apikey}" /…/apikey does not exist
 *
 * and a plugin cannot guard against it, because with a dangling reference no
 * plugin runs at all. Only hand-editing the JSON recovers. `{file:…}` earns its
 * place in a *committed* config like this repo's `foundations/cdc/opencode.json`,
 * where there is no plugin to do the reading. Here the plugin IS present, so the
 * indirection buys nothing and costs a brick. A missing key file is now an
 * ordinary handled condition: bundled roster, a message, never a crash.
 *
 * (opencode still resolves `{file:…}` in a config it loads, before this hook
 * runs — verified on 1.18.1: config load runs `substitute({text, type:"path",…})`
 * over the raw file text and only then parses it. So an `options.apiKey` that
 * reaches us from a committed config is always already-resolved plaintext, which
 * is why `readCredentials` reads it as a plain string and no `{file:…}` parsing
 * belongs in this file.)
 * ---------------------------------------------------------------------------
 *
 * Credential precedence in the config hook is therefore:
 *   1. cfg.provider.tanzu.options.baseURL / .apiKey  (hand-written, e.g. octnz's
 *      foundations/<f>/opencode.json; only baseURL is ever persisted by us)
 *   2. TANZU_GENAI_BASE_URL / TANZU_GENAI_API_KEY  (the spike-verified fallback)
 *   3. the key file written by `authorize`, read directly (key only)
 *   4. the auth store, via `loader`, for the key only (inference, not discovery)
 *
 * NOTE: no `provider.models` hook. Its loop runs before config extension in
 * opencode's provider.ts, so it can never fire for a novel id like "tanzu".
 */

import { readFileSync } from "node:fs"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { resolveModels, TABLE, unknownChatIds } from "./opencode-tanzu-capabilities.js"
import { CLAMPED, discoverModels, DiscoveryError, probeContextLength, probeToolCall } from "./opencode-tanzu-discovery.js"
import { dataDir, getEntry, readCache, setEntry, writeCache } from "./opencode-tanzu-cache.js"

// Former src/index.js entry point, folded in so the installed artifact is the
// source tree itself: every file in an opencode plugin dir is loaded, so the
// fewer files that export a plugin, the better.
export const PROVIDER_ID = "tanzu"
export const PROVIDER_NAME = "Tanzu Platform"
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible"

/** Table entries minus the non-chat ones — the offline fallback roster. */
function tableFallbackModels() {
  return resolveModels(Object.keys(TABLE).map((id) => ({ id })))
}

/**
 * How many unknown ids get probed concurrently. Each probed id fires two
 * concurrent POSTs (context + tool_call), so this bounds the in-flight
 * request count to `PROBE_CONCURRENCY_LIMIT * 2` rather than letting a large
 * roster fire everything in the same tick.
 */
export const PROBE_CONCURRENCY_LIMIT = 6

/**
 * Hard cap on how many unknown ids are probed in a single startup. A gateway
 * listing 200+ models (or a hostile `/v1/models`) must not turn one cold
 * start into hundreds of simultaneous generation requests against the
 * foundation's scheduler and the laptop's socket table.
 *
 * Applied AFTER the cache lookup, to ids still needing a probe — not to the
 * raw unknown-id list. Capping before the cache check was a real bug: an
 * already-cached id would still consume a cap slot on every subsequent
 * start, so the tail beyond the cap was never reached on ANY run, cached or
 * not. With the cache-first ordering, ids beyond the cap fall back to the
 * conservative default for this run only and genuinely do get probed on a
 * later start, once earlier ids are cached (or age out) and free up room.
 */
export const PROBE_ID_CAP = 25

/**
 * Overall wall-clock budget for the ENTIRE probe phase of `enrichUnknownCards`
 * (not a per-request timeout — each probe already has its own 8-second
 * `AbortSignal.timeout`, see `opencode-tanzu-discovery.js`). This is the
 * number documented in the README as the probe phase's worst-case stall.
 *
 * With `PROBE_CONCURRENCY_LIMIT = 6` and up to `PROBE_ID_CAP = 25` ids to
 * probe, a worker pool can need up to `ceil(25 / 6) = 5` sequential rounds of
 * up to 8 seconds each — 40 seconds — if every single request runs to its
 * own timeout. Before this budget existed, that emergent number was ONLY
 * documentation, not an enforced bound: if a future change to either
 * constant (or an unexpectedly slow foundation) pushed the real number past
 * what the README claimed, nothing in the code would notice or correct it.
 * This constant is the actual backstop: once it elapses, workers in
 * `mapWithConcurrency` stop picking up NEW ids (already-in-flight ones still
 * finish, bounded by their own per-request timeout) and every id not yet
 * probed simply falls back to the conservative default this run, exactly
 * like a capped-out or not-yet-reached id — never a thrown error, never a
 * blocked provider registration.
 */
export const PROBE_PHASE_BUDGET_MS = 40_000

/**
 * Run `fn` over `items` with at most `limit` calls in flight at once. A
 * worker-pool, not a batch/chunk split — each worker immediately picks up the
 * next item as soon as its current one settles, so a slow id never blocks
 * workers assigned to items after it from starting.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @param {{deadlineAt?: number}} [opts] when `deadlineAt` (a `Date.now()`-style
 *   epoch ms) is given, a worker stops picking up NEW items once the clock
 *   passes it — an item already in flight still runs to completion (it has
 *   its own request-level timeout already), so this only bounds how many
 *   items a worker STARTS, not how long an individual call can take. Items
 *   never started this way leave a `undefined` hole in the returned array at
 *   their index; callers must treat a hole exactly like "not attempted this
 *   run", the same as any id excluded by `PROBE_ID_CAP`.
 * @returns {Promise<R[]>} results in the same order as `items`, `undefined`
 *   at indices abandoned to the deadline
 */
async function mapWithConcurrency(items, limit, fn, opts = {}) {
  const { deadlineAt } = opts
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    for (;;) {
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) return
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function trimURL(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : ""
}

/**
 * Where the API key lives. Under opencode's data dir alongside its own
 * `auth.json` — deliberately NOT under this repo's `foundations/`, which is
 * user-owned and whose token files belong to the `octnz` launcher.
 * Resolved on every call so the process env stays authoritative.
 */
export function secretPath() {
  return path.join(dataDir(), "opencode-tanzu", "apikey")
}

/** @returns {Promise<string>} the absolute path the key was written to */
async function writeSecret(key) {
  const file = secretPath()
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, key, { mode: 0o600 })
  // writeFile's mode only applies when it creates the file; an existing file
  // keeps its old (possibly world-readable) mode.
  await chmod(file, 0o600)
  return file
}

/**
 * Read the key `authorize` wrote. This is the whole point of dropping the
 * `{file:…}` indirection: the plugin knows the path, so the plugin does the
 * reading, and the config never has to name the file.
 *
 * Absent or unreadable is NOT an error — a user who has never logged in has no
 * key file, and one who cleared their data dir has lost it. Both degrade to the
 * bundled roster with a message (see the config hook), which is exactly what
 * `{file:…}` could not do, because opencode hard-failed the whole config first.
 */
function readKeyFile() {
  const file = secretPath()
  try {
    return readFileSync(file, "utf8").trim()
  } catch (err) {
    // ENOENT is the ordinary "not logged in" case and needs no commentary.
    // Anything else (a permissions problem, a directory in the way) is worth
    // saying out loud, since the user's key is there and we still cannot use it.
    if (err?.code !== "ENOENT") {
      console.error(`[tanzu] could not read the API key at ${file}: ${err.message}`)
    }
    return ""
  }
}

/**
 * Credential source. See the Step 1 finding above: the config hook reads what
 * `authorize` persisted into the opencode config, falling back to env vars.
 *
 * A base URL is mandatory — without one there is nothing to register. The key
 * is optional: absent, the provider still registers off the bundled table and
 * `loader` supplies the key from the auth store at inference time.
 *
 * `options.apiKey` is read as a plain string. If it arrived from a committed
 * config's `{file:…}`, opencode already resolved it before this hook ran.
 *
 * @param {object} cfg the Config object opencode passes to the config hook
 * @returns {{baseURL: string, apiKey: string} | undefined}
 */
function readCredentials(cfg) {
  const options = cfg?.provider?.[PROVIDER_ID]?.options ?? {}
  const baseURL = trimURL(options.baseURL) || trimURL(process.env.TANZU_GENAI_BASE_URL)
  if (!baseURL) return undefined
  const apiKey =
    (typeof options.apiKey === "string" ? options.apiKey.trim() : "") ||
    (process.env.TANZU_GENAI_API_KEY ?? "").trim() ||
    readKeyFile()
  return { baseURL, apiKey }
}

function modelCount(stanza) {
  return Object.keys(stanza?.models ?? {}).length
}

/**
 * opencode deletes a zero-model provider silently, so a models-less `tanzu`
 * stanza left behind on an early return is the forbidden state: the user gets
 * no signal at all. `authorize` persists exactly such a stanza (options, no
 * models — models are the config hook's job), so it can outlive an uninstall.
 * Strip it and say why.
 */
function pruneModellessStanza(cfg, why) {
  const stanza = cfg?.provider?.[PROVIDER_ID]
  if (!stanza || modelCount(stanza) > 0) return
  delete cfg.provider[PROVIDER_ID]
  console.error(
    `[tanzu] ${why} Removed the incomplete "tanzu" provider entry ` +
      `(opencode deletes a zero-model provider without telling you). ` +
      `Run \`opencode providers login -p tanzu\` to configure it.`,
  )
}

/**
 * Persist provider options into opencode's global config via PATCH
 * /global/config, reusing the injected client's transport so that a server
 * started with OPENCODE_SERVER_PASSWORD still authenticates. This is the write
 * half of the precedent's config -> disk -> config bridge.
 *
 * The client's fetch takes a **Request and nothing else** — see the header
 * comment. Passing (url, init) degrades to a bare GET that 200s and writes
 * nothing, so the request is built as a Request and the response is checked
 * against what we sent rather than trusted for its status code.
 */
async function persistOptions(input, options) {
  const clientConfig = input?.client?._client?.getConfig?.() ?? {}
  const doFetch = clientConfig.fetch ?? fetch

  const headers = new Headers({ "Content-Type": "application/json" })
  try {
    if (clientConfig.headers) {
      for (const [key, value] of new Headers(clientConfig.headers).entries()) headers.set(key, value)
    }
  } catch {
    // Non-Headers-shaped config; the default Content-Type alone is fine.
  }

  const base = input?.serverUrl ?? clientConfig.baseUrl
  if (!base) throw new Error("no opencode server URL available to save configuration")

  const request = new Request(new URL("/global/config", base), {
    method: "PATCH",
    headers,
    body: JSON.stringify({ provider: { [PROVIDER_ID]: { options } } }),
  })
  const res = await doFetch(request)
  if (!res?.ok) throw new Error(`opencode rejected the config update (HTTP ${res?.status})`)

  // PATCH /global/config answers with the merged config. Read the write back
  // out of it: a 200 alone would also be produced by the GET this used to send.
  let echoed
  try {
    echoed = await res.json()
  } catch {
    throw new Error("opencode returned a non-JSON response to the config update")
  }
  const saved = echoed?.provider?.[PROVIDER_ID]?.options ?? {}
  for (const [key, value] of Object.entries(options)) {
    if (saved[key] !== value) {
      throw new Error(`opencode did not persist the Tanzu configuration (${key} is missing from the saved config)`)
    }
  }
}

async function log(input, level, message) {
  try {
    await input?.client?.app?.log({ body: { service: "opencode-tanzu", level, message } })
  } catch {
    // Logging must never break a hook.
  }
}

/**
 * Translate `probeContextLength`'s raw result into a cacheable value plus
 * whether it is a conclusive, permanent answer. `CLAMPED` (the ollama path) is
 * conclusive with no numeric value; a plain `null` is inconclusive — a
 * transient failure, not a fact about the model — and must not be pinned
 * long-term.
 */
function contextOutcome(raw) {
  if (typeof raw === "number") return { value: raw, conclusive: true }
  if (raw === CLAMPED) return { value: null, conclusive: true }
  return { value: null, conclusive: false }
}

/**
 * Same idea for `probeToolCall`: `true`/`false` are both conclusive (a real
 * tool call, or a clean completion that declined one); `null` is inconclusive
 * (network error, non-2xx, or a truncated/ambiguous finish_reason — most
 * importantly `"length"`, a reasoning model burning its budget on a `<think>`
 * preamble) and must not be cached as a permanent "no tool support".
 */
function toolCallOutcome(raw) {
  if (typeof raw === "boolean") return { value: raw, conclusive: true }
  return { value: null, conclusive: false }
}

/**
 * Fill in what the tile will not tell us. `/v1/models` reports ids only, so a
 * model with no bundled row would otherwise land on the 8192 default and make
 * opencode compact the session in a loop (the INT4 -> NVFP4 swap, 2026-07-24).
 *
 * Only unknown ids are probed — table-backed models keep their curated
 * modalities and tool_call, which no probe can recover. Every result is
 * cached, but NOT alike: a conclusive one (a numeric context, a clamped-
 * forever backend, a definite tool-call verdict) gets the full week-long
 * `DEFAULT_TTL_MS`, so a steady-state start issues no requests at all. An
 * inconclusive one (either probe returned `null` — timeout, 5xx, a worker
 * mid-restart) gets the much shorter `INCONCLUSIVE_TTL_MS` instead, so a
 * transient failure at startup does not pin a brand-new model at the 8192
 * default for a week — that would recreate the exact incident this file
 * exists to fix.
 *
 * DOES NOT MUTATE `cards` OR ANY ELEMENT OF IT. The returned `cards` is a NEW
 * array: entries for probed ids are shallow copies carrying `max_model_len`;
 * every other entry (known, or unknown but uninformative) is passed through
 * by reference, unchanged. This matters because `discoverModels` is the only
 * thing that has ever made in-place mutation here safe (it hands back a
 * freshly parsed array every call) — a future caller that discovers once and
 * resolves twice, or a shared test fixture, must not see one call's probe
 * results bleed into another's.
 *
 * Probing is bounded three ways (an unbounded `Promise.all` fan-out here
 * would let a 200+-model roster fire hundreds of simultaneous generation
 * requests at cold start): at most `PROBE_CONCURRENCY_LIMIT` ids in flight at
 * once, at most `PROBE_ID_CAP` ids probed per run, and the whole phase is
 * further bounded to `PROBE_PHASE_BUDGET_MS` of wall-clock time regardless of
 * how many ids that leaves unprobed. Ids left over from any of the three —
 * capped, or abandoned once the phase budget elapses — fall back to the
 * conservative default, exactly like any other unknown id, and are picked up
 * on a later start.
 *
 * @returns {Promise<{cards: {id: string, max_model_len?: number|null}[], toolCalls: Map<string, boolean>}>}
 *   the enriched cards and the probed tool_call verdicts by id
 */
async function enrichUnknownCards(cards, baseURL, apiKey) {
  const unknown = unknownChatIds(cards)
  const toolCalls = new Map()
  if (unknown.length === 0) return { cards, toolCalls }

  const cache = readCache()
  let dirty = false

  // Read the cache FIRST, and only apply PROBE_ID_CAP to ids that are not
  // already answered by a live cache entry. Capping before the cache lookup
  // was the bug: already-cached ids consumed cap slots on every run, so any
  // id past the cap was never reached on ANY start, cached or not. Filtering
  // first means the cap only ever bites into ids that genuinely still need a
  // network round trip, so the skipped tail really does get picked up on a
  // later start, once earlier ids age out of cache or the roster shrinks.
  const stillNeeded = []
  const cachedResults = []
  for (const id of unknown) {
    const cached = getEntry(cache, baseURL, id)
    if (cached) cachedResults.push({ id, context: cached.context, toolCall: cached.toolCall })
    else stillNeeded.push(id)
  }

  let idsToProbe = stillNeeded
  if (stillNeeded.length > PROBE_ID_CAP) {
    idsToProbe = stillNeeded.slice(0, PROBE_ID_CAP)
    const skipped = stillNeeded.length - PROBE_ID_CAP
    console.error(
      `[tanzu] roster has ${stillNeeded.length} unknown models needing a probe; probing only the first ` +
        `${PROBE_ID_CAP} this run and skipping ${skipped} to bound startup request fan-out. Skipped ids keep the ` +
        `conservative default until a later start probes them.`,
    )
  }

  const deadlineAt = Date.now() + PROBE_PHASE_BUDGET_MS
  const rawProbedResults = await mapWithConcurrency(
    idsToProbe,
    PROBE_CONCURRENCY_LIMIT,
    async (id) => {
      const [rawContext, rawToolCall] = await Promise.all([
        probeContextLength(baseURL, apiKey, id),
        probeToolCall(baseURL, apiKey, id),
      ])
      const context = contextOutcome(rawContext)
      const toolCall = toolCallOutcome(rawToolCall)
      setEntry(cache, baseURL, id, {
        context: context.value,
        toolCall: toolCall.value,
        conclusive: context.conclusive && toolCall.conclusive,
      })
      dirty = true
      return { id, context: context.value, toolCall: toolCall.value }
    },
    { deadlineAt },
  )

  // A hole means a worker stopped picking up new ids once PROBE_PHASE_BUDGET_MS
  // elapsed. Those ids are simply not in `probedResults` and therefore keep
  // whatever default `cards.map` below falls back to — never a thrown error.
  const probedResults = rawProbedResults.filter((r) => r !== undefined)
  if (probedResults.length < idsToProbe.length) {
    console.error(
      `[tanzu] capability probing hit its ${Math.round(PROBE_PHASE_BUDGET_MS / 1000)}s phase budget; ` +
        `${idsToProbe.length - probedResults.length} of ${idsToProbe.length} ids were not reached this run and ` +
        `keep the conservative default until a later start probes them.`,
    )
  }

  const results = [...cachedResults, ...probedResults]

  const byId = new Map(results.map((r) => [r.id, r]))
  const enrichedCards = cards.map((card) => {
    const result = byId.get(card?.id)
    if (!result) return card
    if (typeof result.toolCall === "boolean") toolCalls.set(result.id, result.toolCall)
    // applyServedLimit already prefers a card's max_model_len over the table.
    if (typeof result.context === "number" && result.context > 0) {
      return { ...card, max_model_len: result.context }
    }
    return card
  })

  if (dirty) await writeCache(cache)
  return { cards: enrichedCards, toolCalls }
}

export const TanzuPlugin = async (input) => {
  return {
    config: async (cfg) => {
      const creds = readCredentials(cfg)
      if (!creds) {
        // Not configured — contribute nothing, but never leave a models-less
        // stanza behind for opencode to delete in silence.
        pruneModellessStanza(cfg, "No Tanzu proxy URL is configured.")
        return
      }

      let models
      if (!creds.apiKey) {
        // The key is in the auth store only (or nowhere). Discovery cannot
        // authenticate, but `loader` can still supply the key for inference, so
        // register the bundled roster rather than nothing.
        console.error(
          `[tanzu] no API key in the config or environment; using the bundled model list. ` +
            `The key from \`opencode providers login -p tanzu\` will still be used for inference.`,
        )
        models = tableFallbackModels()
      } else {
        try {
          const cards = await discoverModels(creds.baseURL, creds.apiKey)
          let enrichedCards = cards
          let probedToolCalls = new Map()
          try {
            const enrichment = await enrichUnknownCards(cards, creds.baseURL, creds.apiKey)
            enrichedCards = enrichment.cards
            probedToolCalls = enrichment.toolCalls
          } catch (err) {
            // Enrichment is an optimization. Losing it costs accuracy on
            // unknown models, never the provider itself.
            console.error(`[tanzu] capability probing failed: ${err.message}. Using bundled defaults.`)
          }
          models = resolveModels(enrichedCards)
          // resolveModels' unknown-default assumes tool_call: true and takes no
          // per-card hint, so an observed `false` is applied here.
          for (const [id, toolCall] of probedToolCalls) {
            if (models[id]) models[id].tool_call = toolCall
          }
        } catch (err) {
          // Never fail to an empty picker: a zero-model provider is deleted
          // silently and the user gets no signal at all. Degrade to the table.
          const hint = err instanceof DiscoveryError && err.hint ? ` ${err.hint}` : ""
          console.error(`[tanzu] model discovery failed: ${err.message}.${hint} Falling back to bundled models.`)
          models = tableFallbackModels()
        }
      }

      if (Object.keys(models).length === 0) {
        pruneModellessStanza(cfg, "No usable chat models were found.")
        return
      }

      const existing = cfg.provider?.[PROVIDER_ID] ?? {}
      // The key goes into the IN-MEMORY config only, because that is what
      // @ai-sdk/openai-compatible reads at inference. Config-hook mutations are
      // never written back to disk: opencode's Config.updateGlobal re-parses the
      // config FILE's raw text before merging and rewriting, and never
      // serializes the in-memory Config. So the key we inject here cannot leak
      // into opencode.json, even if some later code path calls updateGlobal.
      const options = { ...existing.options, baseURL: creds.baseURL }
      // Drop the key entirely when we have none, rather than leaving `""` from
      // `existing.options` to shadow what `loader` is about to supply from the
      // auth store.
      if (creds.apiKey) options.apiKey = creds.apiKey
      else delete options.apiKey

      cfg.provider = cfg.provider ?? {}
      cfg.provider[PROVIDER_ID] = {
        ...existing,
        name: existing.name ?? PROVIDER_NAME,
        npm: existing.npm ?? OPENAI_COMPATIBLE_NPM,
        models,
        options,
      }
    },

    auth: {
      provider: PROVIDER_ID,

      /**
       * Runs at provider.ts:1542, after the config hook has created the entry.
       * Returns options only — models are already settled by then.
       *
       * This is the no-secret-on-disk path and it is reachable: the config hook
       * registers on a base URL alone (bundled roster), and this fills the key
       * in for inference. A user who wants nothing in a config file can set
       * TANZU_GENAI_BASE_URL (or hand-write just `options.baseURL`), delete the
       * key file, and log in — the key then lives only in opencode's auth store.
       */
      loader: async (auth) => {
        try {
          const stored = await auth()
          if (!stored || stored.type !== "api" || !stored.key) return {}
          return { apiKey: stored.key }
        } catch {
          return {}
        }
      },

      methods: [
        {
          type: "api",
          label: "Foundation URL + API key",
          prompts: [
            {
              type: "text",
              key: "baseURL",
              message: "Tanzu GenAI proxy URL (must end in /openai/v1)",
              placeholder: "https://genai-proxy.sys.<foundation>/<instance>/openai/v1",
              validate: (value) => {
                // Trim exactly as `trimURL`/`authorize` do, or the prompt and
                // the config hook disagree about what is acceptable.
                const trimmed = trimURL(value)
                if (!trimmed) return "A proxy URL is required"
                let u
                try {
                  u = new URL(trimmed)
                } catch {
                  return "Not a valid URL"
                }
                if (u.protocol !== "https:") return "URL must use https"
                if (!trimmed.endsWith("/openai/v1")) return "URL must end in /openai/v1"
                return undefined
              },
            },
            {
              type: "text",
              key: "apiKey",
              // opencode's own `pluginAuth` ALWAYS appends a built-in "Enter your
              // API key" prompt for `type: "api"` methods, and it does NOT pass
              // that value to `authorize` — only these `prompts` reach us. We need
              // the key here to validate it, write the key file, and enable live
              // discovery, so the user is asked twice and the second answer is
              // discarded (`authorize` returns the key, and opencode takes
              // `X.key ?? h`). Verified on 1.18.1. Say so rather than surprise them.
              message: "API key (from `cf service-key`) — opencode will ask you to repeat this next",
              // `authorize` trims, so whitespace-only must be rejected here
              // rather than accepted and then reported as a missing key.
              validate: (value) => (typeof value === "string" && value.trim() ? undefined : "An API key is required"),
            },
          ],

          /**
           * The credential bridge, and the split that makes it safe. The config
           * hook cannot read the auth store, so what it needs must go somewhere
           * it can reach — but the two halves go to different places:
           *
           *   - the URL, a non-secret, is persisted into the opencode config,
           *     where the next config-hook run reads it off `cfg`;
           *   - the key goes to a 0600 file which the config hook reads ITSELF.
           *     The config never names it. See the header comment for why the
           *     `{file:…}` pointer this used to persist had to go.
           *
           * The key is ALSO returned so it lands in the auth store, which keeps
           * `loader` working for inference even if the key file is lost.
           */
          authorize: async (inputs = {}) => {
            const baseURL = trimURL(inputs.baseURL)
            const apiKey = (inputs.apiKey ?? "").trim()
            if (!baseURL || !apiKey) {
              await log(input, "error", "Login failed: a proxy URL and an API key are both required.")
              return { type: "failed" }
            }

            // Fail the login rather than persist credentials we know are bad.
            try {
              await discoverModels(baseURL, apiKey)
            } catch (err) {
              const hint = err instanceof DiscoveryError && err.hint ? ` ${err.hint}` : ""
              await log(input, "error", `Login failed: ${err.message}.${hint}`)
              return { type: "failed" }
            }

            try {
              await writeSecret(apiKey)
            } catch (err) {
              await log(input, "error", `Could not save the Tanzu API key: ${err.message}`)
              return { type: "failed" }
            }

            try {
              // ONLY non-secret settings. The key stays in the file `writeSecret`
              // just wrote, which the config hook reads itself; the config must
              // not name it, not even via `{file:…}` (see the header comment —
              // that bricks opencode for every provider).
              await persistOptions(input, { baseURL })
            } catch (err) {
              await log(input, "error", `Could not save the Tanzu configuration: ${err.message}`)
              return { type: "failed" }
            }

            return { type: "success", key: apiKey, provider: PROVIDER_ID }
          },
        },
      ],
    },
  }
}

export default { id: "opencode-tanzu", server: TanzuPlugin }
