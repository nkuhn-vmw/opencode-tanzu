import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveModels, CONSERVATIVE_CONTEXT, unknownChatIds } from "../src/opencode-tanzu-capabilities.js"

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
