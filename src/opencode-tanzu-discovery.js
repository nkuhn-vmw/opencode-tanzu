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
