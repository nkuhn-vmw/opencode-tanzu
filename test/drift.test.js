import { test } from "node:test"
import assert from "node:assert/strict"

import { diffRoster } from "../scripts/check-roster-drift.mjs"
import { TABLE } from "../src/opencode-tanzu-capabilities.js"

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
