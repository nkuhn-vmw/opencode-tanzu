import { test } from "node:test"
import assert from "node:assert/strict"
import {
  resolveModels,
  CONSERVATIVE_CONTEXT,
  unknownChatIds,
  MIN_PLAUSIBLE_CONTEXT,
  MAX_PLAUSIBLE_CONTEXT,
} from "../src/opencode-tanzu-capabilities.js"

const QWEN = "cyankiwi/Qwen3.6-27B-AWQ-INT4"
const GEMMA = "google/gemma-4-31B-it-qat-w4a16-ct"
const ORNITH = "deepreinforce-ai/Ornith-1.0-35B"
const NOMIC = "nomic-ai/nomic-embed-text-v2-moe"

// REGRESSION: the CDC roster contains an embedding model that must never be
// offered as a chat model. The hand-written config filtered it by omission;
// live discovery must filter it by rule.
test("excludes the nomic embedding model", () => {
  const out = resolveModels([{ id: NOMIC }, { id: QWEN }])
  assert.ok(!(NOMIC in out), "nomic must not appear")
  assert.ok(QWEN in out)
})

test("resolves the full CDC roster to exactly the three chat models", () => {
  const out = resolveModels([{ id: NOMIC }, { id: QWEN }, { id: GEMMA }, { id: ORNITH }])
  assert.deepEqual(Object.keys(out).sort(), [QWEN, ORNITH, GEMMA].sort())
})

test("known models carry sourced context and tool_call", () => {
  const out = resolveModels([{ id: QWEN }])
  assert.equal(out[QWEN].limit.context, 262144)
  assert.equal(out[QWEN].tool_call, true)
})

// REGRESSION: Laguna is served at 131072 but the tile strips max_model_len
// from /v1/models, so before this table row existed it resolved to the 8192
// unknown-id default and opencode compacted the session in a loop.
test("Laguna carries its served 131072 context, not the unknown-id default", () => {
  const LAGUNA = "poolside/Laguna-S-2.1-INT4"
  const out = resolveModels([{ id: LAGUNA }])
  assert.equal(out[LAGUNA].limit.context, 131072)
  assert.equal(out[LAGUNA].tool_call, true)
  assert.ok(!/unverified/i.test(out[LAGUNA].name))
})

// REGRESSION: the CDC swap INT4 -> NVFP4 (Blackwell, 2026-07-24) changed the
// served model id. The new id must carry its 262144 context, or it falls to the
// 8192 unknown-id default and opencode loops/compacts nonstop.
test("Laguna-NVFP4 carries its served 262144 context, not the unknown-id default", () => {
  const LAGUNA = "poolside/Laguna-S-2.1-NVFP4"
  const out = resolveModels([{ id: LAGUNA }])
  assert.equal(out[LAGUNA].limit.context, 262144)
  assert.equal(out[LAGUNA].tool_call, true)
  assert.ok(!/unverified/i.test(out[LAGUNA].name))
})

// REGRESSION: these four ollama-style CDC ids clamp max_tokens instead of
// erroring, so the startup probe can't read their real window and they used
// to fall back to CONSERVATIVE_CONTEXT (8192) — double what the tile actually
// serves (measured live: a ~40k-token prompt returns prompt_tokens ~4098/4099,
// i.e. silently truncated at ollama's num_ctx of 4096). Advertising 8192 here
// let opencode pack a context ollama would then silently discard half of,
// with no error surfaced anywhere.
// REGRESSION: gemma4:e4b and the Bonsai GGUF were briefly shipped with
// tool_call: false on the reasoning that unverified should mean "don't
// advertise it". A false is not a neutral absence — it tells opencode the
// model CANNOT use tools, so opencode stops offering them, disabling a
// capability every one of these models demonstrably has. All four were sent a
// forced tool_choice: "required" request on 2026-07-27 and all four returned a
// native tool_calls payload.
test("every ollama-served row advertises the tool calling it was measured to support", () => {
  const ids = ["qwen3:14b", "qwen3:30b-a3b", "gemma4:e4b", "hf.co/prism-ml/Bonsai-8B-gguf:Q1_0"]
  const out = resolveModels(ids.map((id) => ({ id })))
  for (const id of ids) {
    assert.equal(out[id].tool_call, true, `${id} must not be advertised as tool-incapable`)
  }
})

test("qwen3:14b carries its served 4096 context, not the unknown-id default", () => {
  const out = resolveModels([{ id: "qwen3:14b" }])
  assert.equal(out["qwen3:14b"].limit.context, 4096)
  assert.ok(!/unverified/i.test(out["qwen3:14b"].name))
})

test("qwen3:30b-a3b carries its served 4096 context, not the unknown-id default", () => {
  const out = resolveModels([{ id: "qwen3:30b-a3b" }])
  assert.equal(out["qwen3:30b-a3b"].limit.context, 4096)
  assert.ok(!/unverified/i.test(out["qwen3:30b-a3b"].name))
})

test("gemma4:e4b carries its served 4096 context, not the unknown-id default", () => {
  const out = resolveModels([{ id: "gemma4:e4b" }])
  assert.equal(out["gemma4:e4b"].limit.context, 4096)
  assert.ok(!/unverified/i.test(out["gemma4:e4b"].name))
})

test("Bonsai GGUF carries its served 4096 context, not the unknown-id default", () => {
  const BONSAI = "hf.co/prism-ml/Bonsai-8B-gguf:Q1_0"
  const out = resolveModels([{ id: BONSAI }])
  assert.equal(out[BONSAI].limit.context, 4096)
  assert.ok(!/unverified/i.test(out[BONSAI].name))
})

test("unknown chat model is included with conservative defaults and marked unverified", () => {
  const out = resolveModels([{ id: "acme/mystery-7b" }])
  assert.equal(out["acme/mystery-7b"].limit.context, CONSERVATIVE_CONTEXT)
  assert.equal(out["acme/mystery-7b"].tool_call, true)
  assert.match(out["acme/mystery-7b"].name, /unverified/i)
})

test("unknown model with an embedding-ish id is excluded", () => {
  const out = resolveModels([{ id: "acme/bge-reranker-v2" }, { id: "acme/text-embedding-3" }])
  assert.deepEqual(Object.keys(out), [])
})

test("max_model_len wins over the table", () => {
  const out = resolveModels([{ id: QWEN, max_model_len: 32768 }])
  assert.equal(out[QWEN].limit.context, 32768)
})

test("null max_model_len is ignored (LoRA adapter cards report null)", () => {
  const out = resolveModels([{ id: QWEN, max_model_len: null }])
  assert.equal(out[QWEN].limit.context, 262144)
})

// I1 — a served/cached context outside the plausible band must be treated as
// ABSENT, not clamped into range: falling back to the table (or the
// conservative default for an unknown id) is safe, but silently substituting
// a fabricated in-band number for garbage is not. `max_model_len` here stands
// in for a value that could have come straight off the wire, or from a
// hand-edited/corrupt discovery cache — `applyServedLimit` cannot tell the
// difference and must guard both.
test("an absurdly large max_model_len (mangled or hostile) is ignored, not clamped", () => {
  const out = resolveModels([{ id: QWEN, max_model_len: 1e20 }])
  assert.equal(out[QWEN].limit.context, 262144, "must fall back to the table's context, not 1e20")
})

test("an absurdly small max_model_len is ignored, not treated as a real limit", () => {
  const out = resolveModels([{ id: QWEN, max_model_len: 1 }])
  assert.equal(out[QWEN].limit.context, 262144, "must fall back to the table's context, not 1")
})

test("an unknown model with an implausible max_model_len falls back to the conservative default", () => {
  const out = resolveModels([{ id: "acme/mystery-7b", max_model_len: Number.MAX_SAFE_INTEGER }])
  assert.equal(out["acme/mystery-7b"].limit.context, CONSERVATIVE_CONTEXT)
})

test("max_model_len exactly at the plausible band's edges is honored", () => {
  const atMin = resolveModels([{ id: QWEN, max_model_len: MIN_PLAUSIBLE_CONTEXT }])
  assert.equal(atMin[QWEN].limit.context, MIN_PLAUSIBLE_CONTEXT)
  const atMax = resolveModels([{ id: QWEN, max_model_len: MAX_PLAUSIBLE_CONTEXT }])
  assert.equal(atMax[QWEN].limit.context, MAX_PLAUSIBLE_CONTEXT)
})

test("max_model_len one past either edge of the plausible band is rejected", () => {
  const belowMin = resolveModels([{ id: QWEN, max_model_len: MIN_PLAUSIBLE_CONTEXT - 1 }])
  assert.equal(belowMin[QWEN].limit.context, 262144)
  const aboveMax = resolveModels([{ id: QWEN, max_model_len: MAX_PLAUSIBLE_CONTEXT + 1 }])
  assert.equal(aboveMax[QWEN].limit.context, 262144)
})

test("output is clamped to half the context, not merely <= context", () => {
  const out = resolveModels([{ id: QWEN, max_model_len: 4096 }])
  assert.deepEqual(out[QWEN].limit, { context: 4096, output: 2048 })
  assert.equal(out[QWEN].limit.output, Math.floor(out[QWEN].limit.context / 2), "clampOutput must halve, not just cap")
})

test("unknownChatIds returns only ids with no table row", () => {
  const ids = unknownChatIds([{ id: QWEN }, { id: "acme/mystery-7b" }])
  assert.deepEqual(ids, ["acme/mystery-7b"])
})

// Probing an embedding model would waste a request and can never yield a chat
// context — the filter must match resolveModels' own exclusion rules.
test("unknownChatIds never includes embedding or rerank ids", () => {
  const ids = unknownChatIds([{ id: NOMIC }, { id: "acme/text-embedding-3" }, { id: "acme/bge-reranker-v2" }])
  assert.deepEqual(ids, [])
})

test("unknownChatIds skips malformed cards and dedupes", () => {
  const ids = unknownChatIds([{ id: "a/b" }, { id: "a/b" }, {}, null])
  assert.deepEqual(ids, ["a/b"])
})

test("unknownChatIds on an empty roster is empty", () => {
  assert.deepEqual(unknownChatIds([]), [])
})

// REGRESSION: opencode loads EVERY .js in its plugin dir and calls the default
// export as a plugin factory. These helper modules must live in that same flat
// directory (opencode does not scan subdirectories), so each needs a no-op
// default export or opencode logs `failed to load plugin ... "Plugin export is
// not a function"` on every startup. Nothing breaks without it — but three
// ERROR lines per launch read exactly like a real outage, and were in fact
// reported as one.
test("every installed module has a loadable default export", async () => {
  // The main plugin uses opencode's { id, server } object shape; the helper
  // modules use a no-op factory function. opencode accepts either — what it
  // rejects is an UNDEFINED default, which is what produced the original
  // "Plugin export is not a function" errors.
  const mod = await import("../src/opencode-tanzu.js")
  assert.equal(typeof mod.default, "object", "the plugin keeps its { id, server } shape")
  assert.equal(typeof mod.default.server, "function", "and its server must be the plugin factory")

  for (const file of [
    "../src/opencode-tanzu-cache.js",
    "../src/opencode-tanzu-capabilities.js",
    "../src/opencode-tanzu-discovery.js",
  ]) {
    const helper = await import(file)
    assert.equal(typeof helper.default, "function", `${file} must default-export a no-op factory`)
    assert.equal(typeof (await helper.default({})), "object", `${file}'s factory must return hooks`)
  }
})

// REGRESSION: DeepSeek-V4-Flash on NDC ran as an unknown id (8192-context
// default -> nonstop compaction) AND without the anti-loop sampling params.
// The V4 family deterministically loops narration ("Let me X" x N, no tool
// call) at temp 0 once history is primed; frequencyPenalty 0.5 breaks the
// trap 5/5 even at temp 0 (measured on the NDC worker, 2026-08-17).
test("DeepSeek-V4-Flash carries served context and anti-loop sampling options", () => {
  const DS = "deepseek-ai/DeepSeek-V4-Flash-0731"
  const out = resolveModels([{ id: DS }])
  assert.equal(out[DS].limit.context, 262144)
  assert.equal(out[DS].tool_call, true)
  assert.ok(!/unverified/i.test(out[DS].name))
  assert.deepEqual(out[DS].options, { temperature: 1.0, topP: 0.95, frequencyPenalty: 0.5 })
})

test("Qwen3.8-27B-FP8 carries served context, multimodal input, and thinking-safe sampling", () => {
  const Q = "Qwen/Qwen3.8-27B-FP8"
  const out = resolveModels([{ id: Q }])
  assert.equal(out[Q].limit.context, 262144)
  assert.deepEqual(out[Q].modalities.input, ["text", "image", "video"])
  assert.deepEqual(out[Q].options, { temperature: 1.0, topP: 0.95 })
})

// Family fallback: a FUTURE deepseek id with no table row must still get the
// anti-loop sampling (with the conservative context) instead of nothing.
test("unknown deepseek ids inherit family anti-loop options", () => {
  const FUTURE = "deepseek-ai/DeepSeek-V5-Hypothetical"
  const out = resolveModels([{ id: FUTURE }])
  assert.equal(out[FUTURE].limit.context, CONSERVATIVE_CONTEXT)
  assert.equal(out[FUTURE].options.frequencyPenalty, 0.5)
  assert.ok(/unverified/i.test(out[FUTURE].name))
})

test("unknown non-family ids carry no options", () => {
  const out = resolveModels([{ id: "acme/some-model" }])
  assert.equal(out["acme/some-model"].options, undefined)
})

// REGRESSION: opencode gates pasted images on the `attachment` boolean, not
// modalities — a multimodal row without it gets "This model doesn't support
// image input" client-side (seen live with Qwen3.8 on NDC, 2026-08-18).
test("multimodal rows derive attachment: true; text-only rows do not", () => {
  const Q = "Qwen/Qwen3.8-27B-FP8"
  const DS = "deepseek-ai/DeepSeek-V4-Flash-0731"
  const out = resolveModels([{ id: Q }, { id: DS }])
  assert.equal(out[Q].attachment, true)
  assert.equal(out[DS].attachment, undefined)
})
