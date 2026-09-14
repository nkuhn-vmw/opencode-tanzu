/** Standalone OpenCode V2/beta provider. No CF binding or generated config. */
import { readFileSync } from "node:fs"
import { resolveModels, CONSERVATIVE_CONTEXT, CONSERVATIVE_OUTPUT, MIN_PLAUSIBLE_CONTEXT, MAX_PLAUSIBLE_CONTEXT } from "./opencode-tanzu-capabilities.js"
import { discoverModels } from "./opencode-tanzu-discovery.js"
import { enrichUnknownCards, PROBE_PHASE_BUDGET_MS } from "./opencode-tanzu.js"

const PROVIDER_ID = "tanzu"
import { createTransport } from "./opencode-tanzu-transport.js"
const PACKAGE = "@opencode/ai/providers/openai-compatible"

export function connection(options = {}, env = process.env) {
  const raw = options.baseURL ?? env.TANZU_GENAI_BASE_URL
  if (!raw) return undefined
  const baseURL = String(raw).trim().replace(/\/+$/, "")
  const url = new URL(baseURL)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/openai/v1")) {
    throw new Error("Tanzu URL must use HTTPS, end in /openai/v1, and contain no credentials, query or fragment")
  }
  const file = options.apiKeyFile ?? env.TANZU_GENAI_API_KEY_FILE
  // Read on every refresh/request so octnz token rotation works without restarting.
  const apiKey = String((file ? readFileSync(file, "utf8") : env.TANZU_GENAI_API_KEY) ?? "").trim()
  if (!apiKey) throw new Error("Set TANZU_GENAI_API_KEY or TANZU_GENAI_API_KEY_FILE")
  return { baseURL, apiKey }
}

export function refreshInterval(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.max(30_000, Math.min(3_600_000, n)) : 300_000
}

export function toV2Model(id, model, released = Date.now()) {
  return {
    modelID: id, name: model.name, family: model.family ?? id,
    capabilities: { tools: model.tool_call === true, input: model.modalities?.input ?? ["text"], output: model.modalities?.output ?? ["text"] },
    limit: model.limit, status: "active", time: { released },
  }
}

export async function discoverCatalog(baseURL, apiKey) {
  const cards = await discoverModels(baseURL, apiKey)
  // Probe known names too: a model-card maximum is not a deployed serving limit.
  const enriched = await enrichUnknownCards(cards, baseURL, apiKey, PROBE_PHASE_BUDGET_MS, Date.now, true)
  const models = resolveModels(enriched.cards)
  for (const [id, model] of Object.entries(models)) {
    const card = enriched.cards.find((item) => item.id === id)
    if (!Number.isFinite(card?.max_model_len) || card.max_model_len < MIN_PLAUSIBLE_CONTEXT || card.max_model_len > MAX_PLAUSIBLE_CONTEXT) {
      model.limit = { context: Math.min(model.limit.context, CONSERVATIVE_CONTEXT), output: Math.min(model.limit.output, CONSERVATIVE_OUTPUT) }
    }
    if (enriched.toolCalls.has(id)) model.tool_call = enriched.toolCalls.get(id)
  }
  return models
}

export async function omitUnsupportedPromptCacheKey(event, config = {}) {
  if (event.model?.providerID !== PROVIDER_ID) return
  const provider = config.providers?.[PROVIDER_ID]
  if (provider?.package && provider.package !== "@opencode/ai/providers/openai-compatible") return
  const model = provider?.models?.[event.model.id]
  const overrides = [provider?.body, model?.body, ...(model?.variants ?? []).filter((variant) => variant.id === event.model?.variant).map((variant) => variant.body)]
  if (overrides.some((body) => body && Object.hasOwn(body, "prompt_cache_key"))) return

  const request = event.request
  if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions")) return
  let body
  try {
    body = await request.clone().json()
  } catch {
    return
  }
  if (!body || typeof body !== "object" || !Object.hasOwn(body, "prompt_cache_key")) return
  const sessionID = event.sessionID
  if (typeof sessionID !== "string") return
  const generatedKey = /^ses_[0-9a-f]{64}$/.test(sessionID) ? sessionID.slice(4) : sessionID
  if (body.prompt_cache_key !== generatedKey) return
  delete body.prompt_cache_key
  const headers = new Headers(request.headers)
  headers.delete("content-length")
  event.request = new Request(request, { headers, body: JSON.stringify(body) })
}


export async function applySamplingDefaults(event, options, model) {
  if (!options || event.request.method !== "POST") return
  const body = await event.request.clone().json()
  const overrides = [model?.body, ...(model?.variants ?? []).filter((variant) => variant.id === event.model?.variant).map((variant) => variant.body)]
  for (const [key, value] of Object.entries(options)) {
    const wire = { topP: "top_p", frequencyPenalty: "frequency_penalty", presencePenalty: "presence_penalty" }[key] ?? key
    if (!overrides.some((override) => override && Object.hasOwn(override, wire))) body[wire] = value
  }
  const headers = new Headers(event.request.headers)
  headers.delete("content-length")
  event.request = new Request(event.request, { headers, body: JSON.stringify(body) })
}

export default {
  id: "opencode.provider.tanzu",
  setup: async (ctx) => {
    const options = ctx.options ?? {}
    // Read configured state from the editor, never the public catalog API:
    // the editor supplies a synchronous snapshot during catalog composition.
    let configured
    let settings = {}
    let configuredModels = new Map()
    let enabled = true
    const transport = await createTransport(() => connection(options))
    let models = {}
    let released = Date.now()
    let stopped = false
    let running = false

    try {
    await ctx.session.hook("http.request", async (event) => {
      if (event.model?.providerID !== PROVIDER_ID) return
      const current = ctx.catalog.model.list
        ? (await ctx.catalog.model.list()).data.find((model) => model.providerID === PROVIDER_ID && model.id === event.model.id)
        : configuredModels.get(event.model.id)
      if (current?.package && current.package !== PACKAGE) return
      if (new URL(event.request.url).origin !== new URL(transport.baseURL).origin) {
        throw new Error("Configure Tanzu connection via plugin options or TANZU_GENAI_* variables, not providers.tanzu.settings")
      }
      await omitUnsupportedPromptCacheKey(event, { providers: { tanzu: { ...configured, models: { [event.model.id]: current } } } })
      await applySamplingDefaults(event, models[event.model.id]?.options, current)

    }, { providerID: PROVIDER_ID })

    await ctx.catalog.transform((catalog) => {
      const record = catalog.provider.get(PROVIDER_ID)
      configured = record?.provider ? { ...record.provider } : undefined
      configuredModels = new Map(record?.models ?? [])
      settings = configured?.settings ?? {}
      enabled = configured?.activation !== "disabled" && (!configured?.package || configured.package === PACKAGE)
      if (!enabled || !connection(options)) return
      catalog.provider.update(PROVIDER_ID, (draft) => {
        draft.name = configured?.name ?? "Tanzu Platform"
        draft.package = PACKAGE
        // The native client receives only a loopback credential, never the
        // foundation key. The forwarder enforces redirect rejection.
        draft.settings = { ...settings, apiKey: transport.apiKey, baseURL: transport.baseURL }
      })
      for (const [id, model] of Object.entries(models)) {
        const current = catalog.model.get(PROVIDER_ID, id)
        const existing = current ? { ...current } : undefined
        const converted = toV2Model(id, model, released)
        // Existing configured models are operator-owned. Fill catalog visibility
        // and preserve their settings, capabilities and positive limit overrides.
        const limit = { ...converted.limit }
        for (const key of ["context", "output"]) {
          if (existing?.limit?.[key] > 0) limit[key] = existing.limit[key]
        }
        limit.output = Math.min(limit.output, limit.context)
        catalog.model.update(PROVIDER_ID, id, (draft) => Object.assign(draft, converted, existing ?? {}, { limit, family: existing?.family || converted.family, time: converted.time }))
      }
      const selected = options.model ?? process.env.OPENCODE_TANZU_MODEL
      if (!catalog.model.default.get() && selected && models[selected]) catalog.model.default.set(PROVIDER_ID, selected)
    })

    const refresh = async () => {
      if (running || stopped) return
      running = true
      try {
        const creds = connection(options)
        const next = await discoverCatalog(creds.baseURL, creds.apiKey)
        if (!Object.keys(next).length) throw new Error("No usable chat models")
        if (stopped) return
        models = next
        released = Date.now()
        await ctx.catalog.reload()
      } catch {
        // Do not log remote response bodies, token-file contents or API keys.
        console.error("[tanzu-v2] discovery failed; retaining previous/configured models. Check URL, credentials and network.")
      } finally { running = false }
    }
    await ctx.catalog.reload()
    if (!enabled || !connection(options)) { transport.close(); return }
    await refresh()
    const timer = setInterval(() => void refresh(), refreshInterval(options.refreshIntervalMs ?? process.env.OPENCODE_TANZU_REFRESH_INTERVAL_MS))
    timer.unref?.()
    return () => { stopped = true; clearInterval(timer); transport.close() }
    } catch (error) { transport.close(); throw error }
  },
}
