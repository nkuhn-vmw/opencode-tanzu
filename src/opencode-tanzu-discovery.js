/**
 * Live roster discovery against a Tanzu GenAI foundation's OpenAI-compatible
 * proxy. I/O only — this module knows nothing about capabilities or catalogs.
 */

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
