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
}

function clampOutput(context, output) {
  return Math.max(1, Math.min(output, Math.floor(context / 2)))
}

function fromTable(entry) {
  const context = entry.context
  return {
    name: entry.name,
    tool_call: entry.tool_call === true,
    limit: { context, output: clampOutput(context, entry.output) },
    ...(entry.modalities ? { modalities: entry.modalities } : {}),
  }
}

function unknownDefaults(id) {
  return {
    name: `${id} (Tanzu, unverified)`,
    tool_call: true,
    limit: { context: CONSERVATIVE_CONTEXT, output: CONSERVATIVE_OUTPUT },
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
