import { test } from "node:test"
import assert from "node:assert/strict"

import { describeProbedContext, diffRoster } from "../scripts/check-roster-drift.mjs"
import { TABLE } from "../src/opencode-tanzu-capabilities.js"
import { CLAMPED } from "../src/opencode-tanzu-discovery.js"

test("a fully covered roster reports no drift", () => {
  const ids = ["deepreinforce-ai/Ornith-1.0-35B", "google/gemma-4-31B-it-qat-w4a16-ct"]
  const out = diffRoster(ids, TABLE)
  assert.deepEqual(out.uncoveredChat, [])
  assert.deepEqual(out.covered.sort(), ids.sort())
})

// The exact shape of the 2026-07-24 swap: a new id nobody has a row for.
test("an unknown chat id is reported as drift", () => {
  const out = diffRoster(["poolside/Laguna-S-2.1-SOMETHING-NEW"], TABLE)
  assert.deepEqual(out.uncoveredChat, ["poolside/Laguna-S-2.1-SOMETHING-NEW"])
})

test("an embedding id is excluded, not reported as drift", () => {
  const out = diffRoster(["acme/text-embedding-3"], TABLE)
  assert.deepEqual(out.uncoveredChat, [])
  assert.deepEqual(out.excludedEmbeddings, ["acme/text-embedding-3"])
})

test("an empty roster produces empty buckets", () => {
  const out = diffRoster([], TABLE)
  assert.deepEqual(out, { covered: [], uncoveredChat: [], excludedEmbeddings: [] })
})

// Finding 1 (Wave 4) — CLAMPED is a Symbol, and a Symbol is NOT nullish, so
// `context ?? "unavailable…"` does not catch it: it throws
// `TypeError: Cannot convert a Symbol value to a string` instead of printing
// a line, which used to abort the whole --probe report on the first
// clamping backend (every remaining uncovered id then went unreported).
// `describeProbedContext` must handle all three of `probeContextLength`'s
// outcomes without throwing, and say something distinct for each.
test("describeProbedContext renders CLAMPED without throwing, distinctly from a number or null", () => {
  assert.doesNotThrow(() => describeProbedContext(CLAMPED))
  const clamped = describeProbedContext(CLAMPED)
  assert.match(clamped, /clamp/i)

  const numeric = describeProbedContext(131072)
  assert.match(numeric, /131072/)

  const inconclusive = describeProbedContext(null)
  assert.match(inconclusive, /unavailable/)

  assert.notEqual(clamped, numeric)
  assert.notEqual(clamped, inconclusive)
})
