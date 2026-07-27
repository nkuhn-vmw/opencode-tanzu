#!/usr/bin/env node
/**
 * Report Tanzu foundation models the bundled capability table does not cover.
 *
 * The tile rotates served models (and their ids change with the quant or the
 * hardware), while the table is hand-maintained. Run this against a foundation
 * to find drift before a user does — an uncovered id means opencode falls back
 * to a conservative 8192 context for that model.
 *
 * Usage:
 *   TANZU_GENAI_BASE_URL=https://genai-proxy.sys.<foundation>/<instance>/openai/v1 \
 *   TANZU_GENAI_API_KEY="$(cf service-key <instance> <key> | tail -n +2 | jq -r .credentials.endpoint.api_key)" \
 *   node scripts/check-roster-drift.mjs [--probe]
 *
 * Exits 0 when every chat model is covered, 1 when drift is found, 2 on a
 * usage or connection error. The token is read from the environment only,
 * never from argv, so it does not land in shell history or `ps`.
 */

import { TABLE, unknownChatIds } from "../src/opencode-tanzu-capabilities.js"
import { CLAMPED, discoverModels, probeContextLength } from "../src/opencode-tanzu-discovery.js"

/**
 * Render `probeContextLength`'s three possible outcomes for the drift report.
 * `CLAMPED` is a Symbol, and a Symbol is NOT nullish, so `context ?? "..."`
 * does not catch it — it throws `TypeError: Cannot convert a Symbol value to
 * a string` instead of printing anything, aborting the whole report on the
 * first clamping backend (exactly the ollama-served colon-tag ids this
 * script's uncovered list is full of). Test the type explicitly instead of
 * relying on nullish coalescing to distinguish all three outcomes.
 *
 * @param {number | typeof CLAMPED | null} context
 * @returns {string}
 */
export function describeProbedContext(context) {
  if (typeof context === "number") return `probed context: ${context}`
  if (context === CLAMPED) return "probed context: backend clamps instead of reporting a limit — not probeable"
  return "probed context: unavailable — backend does not report it"
}

/**
 * Pure split of a roster against a capability table. Exported for tests; the
 * network lives in main().
 *
 * The uncovered-chat bucket is delegated to `unknownChatIds` rather than
 * re-deriving the exclusion rules here — a second copy of that regex would
 * drift from the one the plugin actually applies, and this script exists to
 * detect drift, not create it.
 *
 * @param {string[]} ids
 * @param {object} table
 */
export function diffRoster(ids, table) {
  const covered = []
  const excludedEmbeddings = []
  const uncoveredChat = unknownChatIds((ids ?? []).filter(Boolean).map((id) => ({ id })))
  const uncovered = new Set(uncoveredChat)
  for (const id of ids ?? []) {
    if (!id || uncovered.has(id)) continue
    if (table[id]?.kind === "chat") covered.push(id)
    else excludedEmbeddings.push(id)
  }
  return { covered, uncoveredChat, excludedEmbeddings }
}

async function main() {
  const baseURL = process.env.TANZU_GENAI_BASE_URL
  const apiKey = process.env.TANZU_GENAI_API_KEY
  if (!baseURL || !apiKey) {
    console.error("Set TANZU_GENAI_BASE_URL and TANZU_GENAI_API_KEY. See the header of this file.")
    process.exit(2)
  }
  const probe = process.argv.includes("--probe")

  let cards
  try {
    cards = await discoverModels(baseURL, apiKey)
  } catch (err) {
    console.error(`Could not read the roster: ${err.message}`)
    if (err.hint) console.error(err.hint)
    process.exit(2)
  }

  const { covered, uncoveredChat, excludedEmbeddings } = diffRoster(
    cards.map((c) => c.id),
    TABLE,
  )

  console.log(`Foundation: ${baseURL}`)
  console.log(`\nCovered by the table (${covered.length}):`)
  for (const id of covered) console.log(`  ✓ ${id}  (context ${TABLE[id].context})`)

  if (excludedEmbeddings.length > 0) {
    console.log(`\nExcluded as non-chat (${excludedEmbeddings.length}):`)
    for (const id of excludedEmbeddings) console.log(`  - ${id}`)
  }

  if (uncoveredChat.length === 0) {
    console.log("\nNo drift: every chat model on this foundation has a table row.")
    return 0
  }

  console.log(`\nDRIFT — no table row (${uncoveredChat.length}):`)
  for (const id of uncoveredChat) {
    if (probe) {
      const context = await probeContextLength(baseURL, apiKey, id)
      console.log(`  ✗ ${id}  (${describeProbedContext(context)})`)
    } else {
      console.log(`  ✗ ${id}`)
    }
  }
  console.log(
    "\nThese resolve to a conservative 8192 context unless probing recovers the real one at runtime.\n" +
      "Re-run with --probe to read each model's served limit, then add a row to\n" +
      "src/opencode-tanzu-capabilities.js for curated metadata (modalities, tool_call).",
  )
  return 1
}

// Only touch the network when run directly, so importing this for tests is free.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main())
}
