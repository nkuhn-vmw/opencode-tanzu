/**
 * Pure model-capability resolution. No I/O.
 *
 * The tile's /v1/models returns only {id, object, created} — no context, no
 * tool_call, no modality. vLLM would expose max_model_len, but the tile's proxy
 * strips it. So capability metadata is bundled here and sourced by hand.
 *
 * Sources verified 2026-07-15 from each repo's config.json / model card.
 */

export const CONSERVATIVE_CONTEXT = 8192
export const CONSERVATIVE_OUTPUT = 4096

/**
 * Plausibility band for ANY served context length — one this table did not
 * author itself. Applies to a probe's parsed result (see
 * `opencode-tanzu-discovery.js`'s `probeContextLength`) and, independently, to
 * whatever number reaches `applyServedLimit` below, because that value can
 * come from a hand-edited or corrupt discovery cache and must be re-checked
 * rather than trusted just because the probe once validated it.
 *
 * A value outside this band is not treated as "clamp it into range" — it is
 * treated as ABSENT, so the model falls back to its table row or the
 * conservative default instead of silently getting a fabricated limit. 1024
 * is below any real chat model's context; 4_000_000 is comfortably above the
 * largest served context in the table (262144) with headroom for a future
 * long-context model, while still rejecting a mangled/hostile value like
 * 1e20 that would otherwise disable compaction entirely.
 */
export const MIN_PLAUSIBLE_CONTEXT = 1024
export const MAX_PLAUSIBLE_CONTEXT = 4_000_000

function isPlausibleContext(value) {
  return Number.isFinite(value) && value >= MIN_PLAUSIBLE_CONTEXT && value <= MAX_PLAUSIBLE_CONTEXT
}

/** Unknown ids matching this are treated as non-chat and excluded. */
const NON_CHAT_ID = /embed|rerank/i

/**
 * PER-MODEL REQUEST OPTIONS — THE WIRE CONTRACT. READ THIS BEFORE EDITING ANY
 * `options` BLOCK BELOW.
 *
 * Investigated 2026-09-17 against the opencode bundle on the NDC ops box
 * (`~/.opencode/bin/opencode`, 1.2.27) by reading the shipped code, not the
 * docs. A model entry's `options` object does NOT become AI SDK CallSettings.
 * opencode merges it into the PROVIDER OPTIONS bag:
 *
 *     const options = merge(base, model.options, agent.options, variant)
 *     streamText({ …, providerOptions: ProviderTransform.providerOptions(model, options) })
 *
 * and `ProviderTransform.providerOptions` keys that bag by
 * `sdkKey(model.api.npm) ?? model.providerID`. `sdkKey` has cases for
 * @ai-sdk/openai, /anthropic, /google, /amazon-bedrock, /gateway,
 * /github-copilot and @openrouter/ai-sdk-provider — and NO case for
 * `@ai-sdk/openai-compatible`, which is the npm this provider registers. So
 * for us the bag is keyed by the provider id, `"tanzu"`, which is also what
 * `OpenAICompatibleChatLanguageModel.providerOptionsName` resolves to.
 *
 * That model's `getArgs()` then does, after building `temperature`,
 * `top_p: topP` and `frequency_penalty: frequencyPenalty` out of CallSettings:
 *
 *     ...Object.fromEntries(Object.entries(providerOptions["tanzu"] ?? {})
 *       .filter(([key]) => !Object.keys(openaiCompatibleProviderOptions.shape).includes(key)))
 *
 * i.e. every key that is not one of its own three schema keys (`user`,
 * `reasoningEffort`, `textVerbosity`) is spread VERBATIM into the
 * /chat/completions JSON body — and, being spread afterwards, overrides the
 * CallSettings-derived fields. Meanwhile CallSettings `temperature`/`topP`
 * come only from the agent config and `ProviderTransform`'s per-family
 * heuristics; a model entry's `options` never reaches them.
 *
 * CONSEQUENCE: these keys must be spelled the way the OpenAI-compatible WIRE
 * spells them (`top_p`, `frequency_penalty`), not the way the AI SDK spells
 * its CallSettings (`topP`, `frequencyPenalty`). The camelCase spellings this
 * table shipped in 0.2.3/0.2.4 were INERT — they reached vLLM as unknown body
 * fields literally named `topP` and `frequencyPenalty`, and the sampler never
 * saw them, so the measured anti-loop fix was never actually applied through
 * this plugin. Wire spelling is also exactly what the owner's proven host
 * `~/.config/opencode/opencode.json` entry uses:
 *   {"temperature": 1, "top_p": 0.95, "frequency_penalty": 0.5}
 *
 * Only keys in `MODEL_OPTION_SPEC` may appear here; anything else would be
 * forwarded to the backend unvalidated.
 */

/**
 * The request options this plugin is willing to put on the wire, with the
 * range each one is accepted in. Deliberately a small allowlist: whatever
 * lands in a model entry's `options` is spread straight into the
 * /chat/completions body (see the note above), so an unrecognised key is a
 * silent unknown-field on someone's inference endpoint, and an out-of-range
 * value is a 400 at the worst possible moment. Ranges follow the OpenAI
 * chat-completions contract that vLLM implements.
 *
 * `integer: true` means the value must be a whole number. `top_k: -1` is
 * vLLM's "disabled" sentinel, which is why its floor is below zero.
 */
export const MODEL_OPTION_SPEC = {
  temperature: { min: 0, max: 2 },
  top_p: { min: 0, max: 1 },
  top_k: { min: -1, max: 100_000, integer: true },
  min_p: { min: 0, max: 1 },
  frequency_penalty: { min: -2, max: 2 },
  presence_penalty: { min: -2, max: 2 },
  repetition_penalty: { min: 0.01, max: 2 },
  seed: { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
}

const KNOWN_OPTION_KEYS = Object.keys(MODEL_OPTION_SPEC).join(", ")

/**
 * Validate one `{option: value}` bag against `MODEL_OPTION_SPEC`.
 *
 * Never throws and never propagates a bad value: a rejected key is dropped
 * with an explanatory warning and the rest of the bag still applies. A caller
 * that hands us something that is not an object at all gets `undefined` back,
 * because there is no partial result to salvage.
 *
 * @param {unknown} raw
 * @param {{where?: string, onWarn?: (message: string) => void}} [opts]
 * @returns {Record<string, number>|undefined}
 */
export function sanitizeModelOptions(raw, { where = "model options", onWarn = () => {} } = {}) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    onWarn(`${where}: expected a JSON object of request options, got ${Array.isArray(raw) ? "an array" : typeof raw}; ignored`)
    return undefined
  }
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    const spec = Object.hasOwn(MODEL_OPTION_SPEC, key) ? MODEL_OPTION_SPEC[key] : undefined
    if (!spec) {
      onWarn(`${where}: unknown request option "${key}"; ignored (accepted options: ${KNOWN_OPTION_KEYS})`)
      continue
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      onWarn(`${where}: "${key}" must be a finite number; ignored`)
      continue
    }
    if (spec.integer && !Number.isInteger(value)) {
      onWarn(`${where}: "${key}" must be a whole number, got ${value}; ignored`)
      continue
    }
    if (value < spec.min || value > spec.max) {
      onWarn(`${where}: "${key}" must be between ${spec.min} and ${spec.max}, got ${value}; ignored`)
      continue
    }
    out[key] = value
  }
  return out
}

/**
 * Parse the `OPENCODE_TANZU_MODEL_OPTIONS_JSON` operator override:
 *
 *     {"deepseek-ai/DeepSeek-V4-Flash-0731": {"frequency_penalty": 0.5}}
 *
 * A malformed document is discarded WHOLE and reported, rather than partially
 * applied — half an operator's sampling intent is not a safer state than none
 * of it. A well-formed document with one bad entry keeps the good entries.
 *
 * @param {unknown} rawJSON value of the env var
 * @param {{onWarn?: (message: string) => void}} [opts]
 * @returns {Record<string, Record<string, number>>} overrides keyed by model id
 */
export function parseModelOptionsOverride(rawJSON, { onWarn = () => {} } = {}) {
  const text = typeof rawJSON === "string" ? rawJSON.trim() : ""
  if (!text) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    onWarn("OPENCODE_TANZU_MODEL_OPTIONS_JSON is not valid JSON; ignoring it entirely")
    return {}
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    onWarn(
      `OPENCODE_TANZU_MODEL_OPTIONS_JSON must be a JSON object keyed by served model id, ` +
        `e.g. {"deepseek-ai/DeepSeek-V4-Flash-0731":{"frequency_penalty":0.5}}; ignoring it entirely`,
    )
    return {}
  }
  const out = {}
  for (const [id, value] of Object.entries(parsed)) {
    const clean = sanitizeModelOptions(value, { where: `OPENCODE_TANZU_MODEL_OPTIONS_JSON["${id}"]`, onWarn })
    if (clean) Object.defineProperty(out, id, { value: clean, enumerable: true, configurable: true, writable: true })
  }
  return out
}

/**
 * Merge operator overrides over the bundled per-model options, in place.
 *
 * Merge is per key, not per model: an operator who sets only
 * `frequency_penalty` keeps the table's `temperature`/`top_p` rather than
 * silently losing them. An override naming a model the roster does not carry
 * is reported — that is almost always a typo in a `cf set-env`, and silently
 * doing nothing is how it stays a typo for a week.
 *
 * @param {Record<string, object>} models output of `resolveModels`
 * @param {Record<string, Record<string, number>>} overrides
 * @param {{onWarn?: (message: string) => void}} [opts]
 * @returns {Record<string, object>} the same `models` object
 */
export function applyModelOptions(models, overrides, { onWarn = () => {} } = {}) {
  for (const [id, override] of Object.entries(overrides ?? {})) {
    const entry = models && Object.hasOwn(models, id) ? models[id] : undefined
    if (!entry) {
      onWarn(`OPENCODE_TANZU_MODEL_OPTIONS_JSON names "${id}", which this foundation does not serve; ignored`)
      continue
    }
    entry.options = { ...(entry.options ?? {}), ...override }
  }
  return models
}

export const TABLE = {
  // huggingface.co/cyankiwi/Qwen3.6-27B-AWQ-INT4 — repack of Qwen/Qwen3.6-27B.
  // 262144 = text_config.max_position_embeddings. The card's 1,010,000 figure
  // requires explicitly enabling RoPE scaling; do not advertise it.
  "cyankiwi/Qwen3.6-27B-AWQ-INT4": {
    kind: "chat",
    name: "Qwen3.6-27B (Tanzu)",
    tool_call: true,
    context: 262144,
    output: 32768, // card's recommended max
    modalities: { input: ["text", "image", "video"], output: ["text"] },
  },
  // huggingface.co/google/gemma-4-31B-it-qat-w4a16-ct — card states 256K, Text+Image.
  // audio_config: null confirms no audio at 31B. sliding_window: 1024 is per-layer
  // local attention, NOT a context limit. Max output is unstated upstream, so it
  // takes the conservative value rather than a guess.
  "google/gemma-4-31B-it-qat-w4a16-ct": {
    kind: "chat",
    name: "Gemma-4-31B (Tanzu)",
    tool_call: true,
    context: 262144,
    output: CONSERVATIVE_OUTPUT,
    modalities: { input: ["text", "image"], output: ["text"] },
  },
  // huggingface.co/deepreinforce-ai/Ornith-1.0-35B — a full post-train, not a quant.
  // Config fingerprint-matches Qwen/Qwen3.5-35B-A3B. Card documents tool calling.
  // Config carries a vision_config inherited from the base, but the card never
  // claims vision — treat as text-only, do not advertise image input.
  "deepreinforce-ai/Ornith-1.0-35B": {
    kind: "chat",
    name: "Ornith-1.0-35B (Tanzu)",
    tool_call: true,
    context: 262144,
    output: 32768,
    modalities: { input: ["text"], output: ["text"] },
  },
  // The INT4 (Ampere / 4×3090, W4A16) variant — formerly served on CDC at
  // max_model_len 131072 (verified on the worker's vLLM config 2026-07-22).
  // Superseded on CDC 2026-07-24 by the -NVFP4 row below; kept for foundations
  // still serving the INT4 build. The tile's /v1/models strips max_model_len,
  // which is exactly why this row exists: without it the id falls to the 8192
  // unknown-id default and opencode compacts the session nonstop. Tool calling
  // verified in agentic use through the tile. Text-only.
  "poolside/Laguna-S-2.1-INT4": {
    kind: "chat",
    name: "Laguna-S-2.1 (Tanzu)",
    tool_call: true,
    context: 131072,
    output: 32768,
    modalities: { input: ["text"], output: ["text"] },
  },
  // The Blackwell (RTX PRO 6000 / SM120) NVFP4 build — supersedes the INT4 row
  // on CDC as of 2026-07-24. Served at max_model_len 262144 (verified on the
  // worker's vLLM 0.25.1 config; the tile still strips the field, so this row is
  // required or the id falls to the 8192 unknown-id default → nonstop compaction
  // / looping). Tool calling verified. Text-only.
  "poolside/Laguna-S-2.1-NVFP4": {
    kind: "chat",
    name: "Laguna-S-2.1 (Tanzu)",
    tool_call: true,
    context: 262144,
    output: 32768,
    modalities: { input: ["text"], output: ["text"] },
  },
  // Listed explicitly so exclusion is deterministic rather than dependent on the
  // NON_CHAT_ID regex. config.json says n_positions 2048, but the card and
  // sentence_bert_config.json both say 512 — max_position_embeddings overstates 4x.
  "nomic-ai/nomic-embed-text-v2-moe": {
    kind: "embedding",
    name: "Nomic Embed v2 MoE",
    context: 512,
  },
  // Four ollama-style CDC ids that clamp max_tokens instead of erroring, so the
  // startup probe cannot read their real window and they were falling back to
  // the 8192 CONSERVATIVE_CONTEXT — double their real capacity. Measured live
  // 2026-07-27 by sending a ~40k-token prompt and reading the response's
  // usage.prompt_tokens: all four returned ~4098/4099, i.e. silently truncated
  // the input at ollama's default num_ctx of 4096 (confirmed not an artifact —
  // a ~6k-token prompt to qwen3:14b came back with prompt_tokens: 3016,
  // accepted in full). We advertise 4096, not the observed 4098/4099: the
  // small excess is chat-template overhead counted into prompt_tokens, and
  // under-advertising is safe (the agent just compacts a little early) while
  // over-advertising recreates exactly the silent-truncation bug this row
  // exists to fix.
  //
  // IMPORTANT: 4096 is ollama's *serving* configuration (num_ctx) on this
  // tile, NOT these models' architectural context maximum — qwen3-14b's own
  // model card claims a far larger window. If the platform team ever raises
  // num_ctx on the backend, these rows become wrong only in the safe
  // direction (under-advertised) until updated; do not "correct" this number
  // upward from a spec sheet without re-measuring what the tile actually
  // serves. Also note applyServedLimit() above already prefers a tile-reported
  // max_model_len over this table, so if the tile ever starts reporting these
  // ids' real served length, this row is automatically overridden.
  //
  // tool_call: ALL FOUR VERIFIED 2026-07-27 — each was sent a forced
  // tool_choice: "required" request and each answered HTTP 200,
  // finish_reason "stop", with a native tool_calls payload.
  //
  // gemma4:e4b and the Bonsai GGUF were briefly marked false here on the
  // assumption that unverified should mean "don't advertise it". That is the
  // wrong default for this field: a false tells opencode the model CANNOT use
  // tools, so it stops offering them — actively disabling a capability the
  // model has. "Unproven" and "absent" are different claims, and only a
  // measurement settles which one applies. Measure before changing any of
  // these; do not infer tool support from a model's family or size.
  "qwen3:14b": {
    kind: "chat",
    name: "Qwen3-14B (Tanzu)",
    tool_call: true,
    context: 4096,
    output: CONSERVATIVE_OUTPUT,
    modalities: { input: ["text"], output: ["text"] },
  },
  "qwen3:30b-a3b": {
    kind: "chat",
    name: "Qwen3-30B-A3B (Tanzu)",
    tool_call: true,
    context: 4096,
    output: CONSERVATIVE_OUTPUT,
    modalities: { input: ["text"], output: ["text"] },
  },
  "gemma4:e4b": {
    kind: "chat",
    name: "Gemma-4-E4B (Tanzu)",
    tool_call: true,
    context: 4096,
    output: CONSERVATIVE_OUTPUT,
    modalities: { input: ["text"], output: ["text"] },
  },
  "hf.co/prism-ml/Bonsai-8B-gguf:Q1_0": {
    kind: "chat",
    name: "Bonsai-8B GGUF (Tanzu)",
    tool_call: true,
    context: 4096,
    output: CONSERVATIVE_OUTPUT,
    modalities: { input: ["text"], output: ["text"] },
  },
  // Served on NDC at max_model_len 262144 (verified on the worker's vLLM 0.25.1
  // config 2026-08-14; the tile strips the field). Tool calling verified in
  // agentic use. Text-only. `options` are load-bearing, not preference:
  // temperature/top_p are DeepSeek's official agentic recommendation for the
  // 0731 variant (recipes.vllm.ai), and frequency_penalty 0.5 is the measured
  // fix for the V4-family long-context narration loop — at temp 0 with ~20
  // identical "Let me X" turns in history the model loops deterministically
  // (5/5); frequency_penalty 0.5 breaks the trap 5/5 even at temp 0
  // (reproduced on the NDC worker 2026-08-17, ndc-ops PLAN doc).
  //
  // Re-confirmed 2026-09-17 by a blind 8-replicate A/B replay of the worst
  // real failing session against the live NDC worker: frequency_penalty 0.5
  // gave 0/8 hard degenerations, frequency_penalty 0 gave 4/8 (finish=length,
  // 15-17K-char loop blobs). One-sided Fisher exact p = 0.03846;
  // two-sided p = 0.07692. The investigator reports pooled p = 2.9e-4
  // across arms; that is a separate comparison, not this 8-versus-8 arm.
  // Through the tile proxy, reasoning_effort is not inert: thinking tokens
  // are generated and stripped before the proxy drops the field. The replay
  // does not establish a non-thinking serving mode or a causal explanation.
  // Keep temperature 1, top_p 0.95, frequency_penalty 0.5; full-suite v5
  // re-benchmarking remains the acceptance gate.
  //
  // Wire spelling (top_p / frequency_penalty), NOT AI SDK CallSettings
  // spelling — see the "PER-MODEL REQUEST OPTIONS" note above.
  "deepseek-ai/DeepSeek-V4-Flash-0731": {
    kind: "chat",
    name: "DeepSeek-V4-Flash (Tanzu)",
    tool_call: true,
    context: 262144,
    output: 32768,
    modalities: { input: ["text"], output: ["text"] },
    options: { temperature: 1.0, top_p: 0.95, frequency_penalty: 0.5 },
  },
  // Served on NDC at max_model_len 262144 (verified 2026-08-14). Multimodal:
  // image + video input validated end-to-end on the worker (direct file URLs /
  // base64 — NOT YouTube page links). Thinking model; the NDC tile serves a
  // custom chat template defaulting reasoning to medium with in-band switches
  // (/no_think /think_low /think_medium /think_hard) usable in any user
  // message. Sampling per the model card's thinking-mode recommendation —
  // at temperature 0 thinking models can stall in the think phase.
  "Qwen/Qwen3.8-27B-FP8": {
    kind: "chat",
    name: "Qwen3.8-27B (Tanzu)",
    tool_call: true,
    context: 262144,
    output: 32768,
    modalities: { input: ["text", "image", "video"], output: ["text"] },
    options: { temperature: 1.0, top_p: 0.95 },
  },
}

/**
 * Family fallbacks for roster ids with no TABLE row yet. The tile's /v1/models
 * strips everything but the id, so true dynamic discovery of sampling params is
 * impossible — the honest middle ground is: recognize the family from the id
 * and apply that family's known-safe sampling while keeping the conservative
 * context until a verified row is added. Order matters; first match wins.
 */
const FAMILY_OPTIONS = [
  // Anti-loop insurance for the whole DeepSeek-V4 family (see the 0731 row).
  { match: /deepseek/i, options: { temperature: 1.0, top_p: 0.95, frequency_penalty: 0.5 } },
  // Qwen3.5+ thinking models misbehave at temp 0 (think-phase stalls).
  { match: /qwen/i, options: { temperature: 1.0, top_p: 0.95 } },
]

function clampOutput(context, output) {
  return Math.max(1, Math.min(output, Math.floor(context / 2)))
}

function fromTable(entry) {
  const context = entry.context
  // opencode's attach-a-file gate keys on the `attachment` boolean (models.dev
  // convention: multimodal models carry BOTH attachment: true and modalities).
  // Without it, opencode refuses pasted images client-side — "This model
  // doesn't support image input" — even for models whose image path is
  // verified end-to-end on the worker. Derive it from the modalities we
  // already assert rather than maintaining a second hand-set flag.
  const multimodal = entry.modalities?.input?.some((m) => m !== "text") === true
  return {
    name: entry.name,
    tool_call: entry.tool_call === true,
    limit: { context, output: clampOutput(context, entry.output) },
    ...(entry.modalities ? { modalities: entry.modalities } : {}),
    ...(multimodal ? { attachment: true } : {}),
    // Copied, not aliased: `TABLE` is a module singleton and the operator
    // override merges into the resolved entry's `options`. Handing out the
    // table's own object would let one override leak into every later
    // `resolveModels` call in the same process.
    ...(entry.options ? { options: { ...entry.options } } : {}),
  }
}

function familyOptions(id) {
  const hit = FAMILY_OPTIONS.find((f) => f.match.test(id))
  return hit ? { options: { ...hit.options } } : {}
}

function unknownDefaults(id) {
  return {
    name: `${id} (Tanzu, unverified)`,
    tool_call: true,
    limit: { context: CONSERVATIVE_CONTEXT, output: CONSERVATIVE_OUTPUT },
    ...familyOptions(id),
  }
}

/**
 * The served context wins when the tile reports it — an operator's
 * --max-model-len cap must not be overridden by our table. Forward-compatible:
 * the day the tile stops stripping max_model_len, this starts working for free.
 *
 * `maxModelLen` is not trusted merely for being a number: it can arrive from
 * a hand-edited or corrupt discovery cache as well as a live probe, so it is
 * re-checked against the same plausibility band the probe itself enforces
 * (see `MIN_PLAUSIBLE_CONTEXT`/`MAX_PLAUSIBLE_CONTEXT`). A value outside the
 * band is treated as absent, not clamped into range — clamping would still
 * silently substitute a fabricated limit for whatever nonsense the cache held.
 */
function applyServedLimit(meta, maxModelLen) {
  if (typeof maxModelLen !== "number" || !isPlausibleContext(maxModelLen)) return meta
  return { ...meta, limit: { context: maxModelLen, output: clampOutput(maxModelLen, meta.limit.output) } }
}

/**
 * @param {{id: string, max_model_len?: number|null}[]} cards
 * @returns {Record<string, object>} opencode model configs, keyed by model id
 */
export function resolveModels(cards) {
  const out = {}
  for (const card of cards ?? []) {
    if (!card?.id) continue
    const entry = TABLE[card.id]
    let meta
    if (entry) {
      if (entry.kind !== "chat") continue // known non-chat: excluded
      meta = fromTable(entry)
    } else {
      if (NON_CHAT_ID.test(card.id)) continue // unknown non-chat: excluded
      meta = unknownDefaults(card.id)
    }
    out[card.id] = applyServedLimit(meta, card.max_model_len)
  }
  return out
}

/**
 * The ids worth probing: chat models we have no bundled row for. Mirrors the
 * exclusions `resolveModels` applies, so a probe is never spent on a model that
 * would be filtered out of the picker anyway.
 *
 * @param {{id: string}[]} cards
 * @returns {string[]} unique unknown chat ids, in roster order
 */
export function unknownChatIds(cards) {
  const out = []
  const seen = new Set()
  for (const card of cards ?? []) {
    const id = card?.id
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (TABLE[id]) continue
    if (NON_CHAT_ID.test(id)) continue
    out.push(id)
  }
  return out
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
