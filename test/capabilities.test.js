import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveModels, CONSERVATIVE_CONTEXT } from "../src/opencode-tanzu-capabilities.js"

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
