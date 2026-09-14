/**
 * Live roster discovery against a Tanzu GenAI foundation's OpenAI-compatible
 * proxy. I/O only — this module knows nothing about capabilities or catalogs.
 */

import { MAX_PLAUSIBLE_CONTEXT, MIN_PLAUSIBLE_CONTEXT } from "./opencode-tanzu-capabilities.js"

export class DiscoveryError extends Error {
  /** @param {string} message @param {{status?: number, hint?: string, cause?: unknown}} [opts] */
  constructor(message, opts = {}) {
    super(message, { cause: opts.cause })
    this.name = "DiscoveryError"
    this.status = opts.status
    this.hint = opts.hint
  }
}

function hintFor(status) {
  if (status === 401 || status === 403) {
    return "The foundation rejected the API key. Fetch a fresh one from your CF service key (`cf service-key <instance> <key>`), or re-run `opencode providers login -p tanzu`."
  }
  if (status === 404) return "Check the proxy URL — it should end in /openai/v1."
  if (status >= 500) return "The foundation returned a server error. Its model workers may be down."
  return undefined
}

/**
 * @param {string} baseURL e.g. https://genai-proxy.sys.<foundation>/<instance>/openai/v1
 * @param {string} apiKey
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [opts]
 * @returns {Promise<{id: string, max_model_len?: number|null}[]>}
 */
export async function discoverModels(baseURL, apiKey, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 20000
  const url = `${baseURL.replace(/\/$/, "")}/models`

  let res
  try {
    res = await fetchImpl(url, {
      redirect: "error",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (cause) {
    throw new DiscoveryError(`Could not reach the Tanzu foundation at ${url}`, {
      cause,
      hint: "Check the proxy URL and that the foundation is reachable from this network.",
    })
  }

  if (!res.ok) {
    throw new DiscoveryError(`Tanzu foundation returned ${res.status} for ${url}`, {
      status: res.status,
      hint: hintFor(res.status),
    })
  }

  let body
  try {
    body = await res.json()
  } catch (cause) {
    throw new DiscoveryError(`Tanzu foundation returned a non-JSON response for ${url}`, {
      status: res.status,
      cause,
      hint: "The proxy URL likely returned an HTML page instead of JSON — check for a typo, or a proxy/captive portal intercepting the request.",
    })
  }
  return Array.isArray(body?.data) ? body.data : []
}

/**
 * Sentinel returned by `probeContextLength` for a backend that clamps
 * `max_tokens` instead of erroring (ollama-served ids like `qwen3:14b`): it
 * answers 200 with an ordinary completion and reveals no limit. That is a
 * CONCLUSIVE, permanent "this model can never be probed this way" — worth the
 * full cache TTL — and must not be confused with plain `null`, which means
 * "could not determine right now" (timeout, DNS failure, TLS error, 429, 503,
 * a worker mid-restart) and must be retried soon. Caching the two alike is
 * exactly the incident this module exists to prevent: one unlucky startup
 * would otherwise pin a brand-new model at the 8192 default for a week.
 *
 * IMPORTANT: a 2xx status alone is NOT sufficient evidence for `CLAMPED`. An
 * OpenAI-compatible gateway or route service that normalizes an upstream
 * error into a 200 (LiteLLM-style proxies do exactly this — `200
 * {"error":{"message":"… max_model_len=131072 …"}}`) would otherwise be read
 * as "this model can never be probed", pinning it at the 8192 default for a
 * week and re-entering the very incident this sentinel exists to prevent.
 * `probeContextLength` therefore always attempts the `max_model_len` parse
 * FIRST, on any response body, 2xx or not, and only falls back to `CLAMPED`
 * when the 2xx body actually looks like a completion (`choices` is a
 * NON-EMPTY array — an empty array is a 2xx that never actually answered: a
 * content filter, an aborted upstream, some load-balancer shapes). Anything
 * else on a 2xx — no `choices`, an empty `choices`, no parseable limit — is
 * `null` (inconclusive), not `CLAMPED`.
 */
export const CLAMPED = Symbol("tanzu:context-clamped")

/**
 * The tile strips max_model_len from /v1/models, but vLLM leaks the real limit
 * in the error it raises for an impossible max_tokens. One cheap request —
 * it fails validation before generating anything — recovers the true context
 * window for a model we have no table row for.
 *
 * Verified against the live CDC tile 2026-07-27:
 *   "max_tokens=999999999 cannot be greater than max_model_len=max_total_tokens=262144."
 *
 * This function never throws: every failure path returns `null` and leaves
 * the caller on its existing defaults. See `CLAMPED` for the one outcome that
 * is a definite negative rather than an unknown.
 *
 * The `max_model_len` parse is attempted on EVERY response, 2xx or not,
 * before any status-code branching — a gateway/route service can deliver the
 * real limit on a 2xx (see the `CLAMPED` doc above for why `res.ok` alone
 * must never short-circuit straight to `CLAMPED`).
 *
 * @returns {Promise<number | typeof CLAMPED | null>}
 *   the served context length (found on either a 2xx or non-2xx body);
 *   `CLAMPED` only when a 2xx body has no parseable limit but does look like
 *   a real completion (`choices` is a non-empty array) — conclusive, cache
 *   long-term; `null` when inconclusive (network error, non-JSON body, or a
 *   body with no parseable limit and no non-empty `choices`) — cache
 *   short-term and retry.
 */
export async function probeContextLength(baseURL, apiKey, id, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 8000
  const url = `${baseURL.replace(/\/$/, "")}/chat/completions`

  let res
  try {
    res = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
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

  // Try the max_model_len parse FIRST, regardless of status. A 2xx does not
  // by itself mean "clamped" — a gateway/route service that normalizes an
  // upstream error into a 200 (LiteLLM-style proxies do exactly this) can
  // deliver the real limit with the wrong status code. If it parses to a
  // plausible number, it is a real limit; use it.
  const parsed = parseMaxModelLen(body)
  if (typeof parsed === "number") return parsed

  if (res.ok) {
    // No parseable limit on a 2xx. Only call this CLAMPED (conclusive,
    // cache long-term) when the body actually looks like a chat completion —
    // a NON-EMPTY array of `choices` means the backend genuinely answered
    // rather than validating, which is the ollama/clamping behavior this
    // sentinel exists for. `choices: []` (a content filter, an aborted
    // upstream, some load-balancer shapes) is NOT a completion, even though
    // it is a 2xx with an array — treating it as one would pin the model at
    // the conservative default for a week on the strength of a body that
    // never actually answered. Anything else (an unrecognized 200 shape, an
    // empty `choices`, a proxy's non-completion 200 body) is inconclusive: we
    // asked and got an answer we cannot interpret, not proof the backend can
    // never be probed.
    if (Array.isArray(body?.choices) && body.choices.length > 0) return CLAMPED
    return null
  }

  // Non-2xx with no parseable limit: inconclusive.
  return null
}

/**
 * Pull a `max_model_len` (or `max_total_tokens`) figure out of an error
 * message, if the body has one and it falls inside the plausible band.
 * Shared by both the 2xx and non-2xx paths of `probeContextLength` — the
 * tile can deliver this figure at either status code.
 *
 * @returns {number | null} the parsed, plausible context length, or `null`
 *   when the body has no message, no match, or an implausible value.
 */
function parseMaxModelLen(body) {
  const message = body?.error?.message
  if (typeof message !== "string") return null
  const match = message.match(/max_model_len=(?:max_total_tokens=)?(\d+)/)
  if (!match) return null
  const context = Number.parseInt(match[1], 10)
  // A mangled or hostile error body (or a value that survived a truncated
  // parse) could report an implausible number — either far too small to be a
  // real chat context (looping compaction) or absurdly large (compaction
  // never fires and every request is rejected at the tile). Treat anything
  // outside the plausible band as inconclusive rather than trusting it.
  if (!Number.isFinite(context) || context < MIN_PLAUSIBLE_CONTEXT || context > MAX_PLAUSIBLE_CONTEXT) return null
  return context
}

/**
 * Ask a model to call one trivial tool and see whether it answers with a native
 * `tool_calls` payload. Used only for ids with no table row, where the
 * alternative is assuming tool support and letting the agent discover otherwise
 * mid-session.
 *
 * `tool_choice: "required"` actually compels a compliant backend to call the
 * tool rather than merely offering it — without this, a model that simply
 * chooses to answer in prose scores a `false` that means nothing. Some
 * backends reject `tool_choice: "required"` outright; that is a non-2xx and
 * already falls through the `!res.ok` guard below to `null`, which is the
 * correct, safe answer for "we couldn't even ask".
 *
 * max_tokens is 512, not the bare minimum: a reasoning model (Qwen3/Gemma —
 * exactly what the tile swaps in) can spend its whole budget inside a
 * `<think>` preamble before ever reaching a tool call. A tiny max_tokens
 * truncates that preamble and produces `finish_reason: "length"`, which used
 * to be scored as a confident "no tool support" — a regression versus the
 * pre-probe behavior, and the reason this must be treated as inconclusive.
 *
 * @returns {Promise<boolean | null>}
 *   `true` for a real `tool_calls` payload (or `finish_reason: "tool_calls"`);
 *   `false` only for a clean, untruncated completion (`finish_reason: "stop"`)
 *   that produced no tool call — a genuine negative, safe to cache long-term;
 *   `null` for everything else (network error, non-2xx, no choices, or any
 *   other finish_reason — most importantly `"length"`) — inconclusive, cache
 *   short-term and retry.
 */
export async function probeToolCall(baseURL, apiKey, id, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 8000
  const url = `${baseURL.replace(/\/$/, "")}/chat/completions`

  let res
  try {
    res = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
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
        tool_choice: "required",
        max_tokens: 512,
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
  if ((Array.isArray(calls) && calls.length > 0) || choice?.finish_reason === "tool_calls") return true
  if (choice?.finish_reason === "stop") return false
  // Any other finish_reason — "length" above all — means the probe never
  // reached a conclusive answer. Not evidence of "no support".
  return null
}

// opencode loads EVERY .js file in its plugin directory and calls each one's
// default export as a plugin factory. This file is a helper module of
// opencode-tanzu.js, not a plugin — but it has to live in the same flat
// directory, because opencode does not scan subdirectories and the
// `opencode-tanzu-` prefix is what keeps these names collision-safe next to
// other people's plugins.
//
// Without this no-op, opencode logs `failed to load plugin ... "Plugin export
// is not a function"` for this file on every single startup. Nothing breaks —
// the real plugin still registers and inference works — but three ERROR lines
// per launch is indistinguishable from a real failure to anyone reading the
// log, and it has already been reported as one.
export default async () => ({})
