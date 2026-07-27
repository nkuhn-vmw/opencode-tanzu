# opencode-tanzu v0.2.0 — Context Auto-Discovery, Drift Tooling & Docs

*Design spec — 2026-07-27*

## Problem

The Tanzu AI Services tile strips `max_model_len` from its `/v1/models` response
(returns only `id`/`object`/`created`). The plugin therefore hand-maintains a
capability `TABLE` for context/output/tool_call/modalities. Every time the tile
swaps a served model the id changes (e.g. `poolside/Laguna-S-2.1-INT4` →
`…-NVFP4` on 2026-07-24), the new id misses the table, falls to the 8192
unknown-default, and opencode compacts the session nonstop ("looping"). This has
required a hand-edited table row + release for each swap.

Verified 2026-07-27 against the live CDC tile: vLLM leaks the real
`max_model_len` in an over-limit error. A single request with
`max_tokens: 999999999` returns HTTP 400 with a body like:

```
max_tokens=999999999 cannot be greater than max_model_len=max_total_tokens=262144.
```

This works for the vLLM-served (HF-style id) models — Laguna, Gemma-4-31B,
Ornith — which is exactly where the pain is. The ollama-served ids (`qwen3:14b`,
`qwen3:30b-a3b`, `gemma4:e4b`, `hf.co/prism-ml/Bonsai-8B-gguf:Q1_0`) do **not**
error (ollama silently clamps `max_tokens`) and return a normal completion, so
the probe yields nothing for them — they degrade to the existing default/table
behavior.

## Goals

1. Auto-discover context length for unknown vLLM-served models so a tile model
   swap needs **no code change** for those models.
2. Cache discovery results so steady-state startup does zero extra work and is
   offline-resilient.
3. Give a standalone drift-check tool so roster changes are caught proactively.
4. Add first CI (plain `node --test`), a CHANGELOG, and docs that map the
   real-world symptom (compaction loop) to the fix.

## Non-goals

- Making the ollama-served ids probeable (their backend doesn't expose the
  limit this way; they keep table/default behavior).
- A live GitHub Action against the tile. The tile JWT is ephemeral and the
  foundation is not assumed reachable from GitHub runners; drift detection ships
  as a standalone script the user wires wherever they have `cf` access.
- Changing the credential model, the login flow, or the persisted-config shape.

## Architecture

Keeps the existing module boundaries; each unit stays independently testable.

### `opencode-tanzu-discovery.js` (I/O only — unchanged responsibilities)

Add:

```
probeContextLength(baseURL, apiKey, id, { fetchImpl?, timeoutMs? }) → Promise<number | null>
```

- POSTs to `${baseURL}/chat/completions` with body
  `{ model: id, messages: [{ role: "user", content: "hi" }], max_tokens: 999999999 }`.
- Parses `max_model_len=(\d+)` (tolerant of the `max_total_tokens=` infix) from
  the response body — regardless of HTTP status, since the number lives in a 400
  body.
- Returns the integer on match; returns `null` on: a 2xx success (ollama path,
  no error to parse), a timeout/network error, a non-matching body, or a
  non-positive/NaN parse. Never throws — a failed probe is an ordinary "unknown"
  outcome.
- `timeoutMs` default ~8000 (tighter than roster discovery's 20s; bounds the
  ollama-generates-a-reply case).

`probeToolCall(baseURL, apiKey, id, opts) → Promise<boolean | null>` lives here
too, same no-throw contract: it sends a forced-tool-call request (the
`validate.sh` pattern) and returns `true` if the model emits a native
`tool_calls` response, `false` if it completes without one, `null` on
error/timeout. Cost note: for an unprobeable ollama id this is a second request
that generates a tiny reply; both probes are bounded by the per-probe timeout and
the result (including `null`) is cached so it happens at most once per TTL.

### `opencode-tanzu-capabilities.js` (pure — unchanged core)

Add:

```
unknownChatIds(cards) → string[]
```

- Returns the ids from `cards` that are **not** in `TABLE` and **not**
  embedding/rerank-excluded — mirroring `resolveModels`'s own filtering so an
  embedding model is never probed. Pure, no I/O.

`resolveModels` and `applyServedLimit` are unchanged. `applyServedLimit` already
prefers a card's `max_model_len` over the table, so attaching a probed value as
`card.max_model_len` needs no change to resolution.

### `opencode-tanzu-cache.js` (new, small, pure + fs)

A JSON cache at `<dataDir>/opencode-tanzu/discovery-cache.json` (same `dataDir()`
opencode uses for the apikey). Shape:

```json
{ "<baseURL>\n<id>": { "context": 262144, "toolCall": true, "probedAt": <epoch_ms> } }
```

API (plain functions):

- `readCache() → object` — parse the file; missing/corrupt → `{}`, never throws.
- `getEntry(cache, baseURL, id, ttlMs) → entry | undefined` — returns the entry
  only if `probedAt` is within `ttlMs` (default 7 days); otherwise `undefined`.
- `setEntry(cache, baseURL, id, entry)` — mutate in memory.
- `writeCache(cache) → Promise<void>` — best-effort persist (mode 0600 dir 0700,
  matching the apikey path); write failure is logged, not thrown.

`context: null` is a legitimate cached value (the negative result for ollama /
unprobeable ids) and is honored within TTL so those ids aren't re-probed every
start. Only positive `toolCall`/`context` values are used to enrich; `null`
means "leave the card as the table/default decides."

### `opencode-tanzu.js` `config` hook (orchestration)

Current flow: `discoverModels` → `resolveModels`. New flow when a key is present
and discovery succeeds:

1. `cards = await discoverModels(...)` (unchanged).
2. `unknown = unknownChatIds(cards)`.
3. `cache = readCache()`.
4. For each id in `unknown`, in parallel:
   - cache hit within TTL → use it;
   - else `probeContextLength` (and `probeToolCall`), `setEntry`, mark dirty.
5. For each unknown card with a positive cached/probed `context`, set
   `card.max_model_len = context` (honored by `applyServedLimit`).
6. If dirty, `await writeCache(cache)` (best-effort).
7. `models = resolveModels(cards)` (unchanged).
8. **tool_call override**: `resolveModels`' unknown-default hardcodes
   `tool_call: true` and has no per-card hint, so a probed *boolean* is applied
   as an explicit post-step in the hook: for each unknown id whose probe returned
   a non-`null` `toolCall`, set `models[id].tool_call = toolCall`. `null` (probe
   inconclusive) leaves the existing `true` default untouched. Context needs no
   such post-step because `applyServedLimit` already threads `max_model_len`
   through resolution. Capabilities stays unchanged except for `unknownChatIds`.

Bounds: probes run in parallel; each has the ~8s per-probe timeout; known models
and cache-hit unknowns issue no request, so steady state adds nothing. The whole
step stays within the config hook's existing "startup may pause on a cold,
unreachable foundation" contract already documented for discovery.

Failure posture is unchanged: any probe returning `null` leaves the card to
`resolveModels`' existing unknown-default (8192, `unverified` name). The provider
still always registers; the picker is never empty.

### `scripts/check-roster-drift.mjs` (new, standalone)

- Reads `TANZU_GENAI_BASE_URL` / `TANZU_GENAI_API_KEY` from env (or `--base` /
  token via env only — no secret on argv).
- Fetches `/v1/models`, imports `TABLE` from the plugin source.
- Diff logic factored into a pure exported `diffRoster(ids, table) → { covered,
  uncoveredChat, excludedEmbeddings }` so it is unit-testable without network.
- Prints a readable report; exits `0` when `uncoveredChat` is empty, `1`
  otherwise (drift present).
- `--probe` also calls `probeContextLength` for each uncovered chat id and prints
  the discovered context, so the operator sees "new id X, context 262144" ready
  to paste into a table row or a models.dev PR.
- No secrets committed; the user runs it from any foundation-reachable host
  (laptop, cron, BOSH errand).

### `.github/workflows/test.yml` (new)

- Trigger: push + pull_request.
- Steps: checkout, setup-node (matrix: 20, latest), `node --test`. No secrets.

## Docs

- **README**
  - *Models* section: note that unknown vLLM-served ids are auto-probed for
    context (with the ollama caveat that colon-tag ids can't be probed and keep
    conservative defaults).
  - New **"When the tile swaps a model"** section: the `max_tokens: 999999999`
    probe-recipe curl, and the two durable fixes (auto-probe handles it; or add a
    table row / use the config-only `models` override for curated metadata).
  - New **Troubleshooting** entry: "opencode keeps compacting / the session
    loops" → context miss → auto-probe or add a row / override.
  - **Roadmap** note: eventual models.dev listing as the official catalog path.
- **CHANGELOG.md**: backfill 0.1.0, 0.1.1, 0.1.2; add 0.2.0.

## Housekeeping

- `install.sh`'s explicit `FILES=(opencode-tanzu.js opencode-tanzu-capabilities.js
  opencode-tanzu-discovery.js)` array gains `opencode-tanzu-cache.js`. The brew
  formula copies `Dir["src/*.js"]` (glob) so it needs no change.

## Version

`0.2.0` (feature). Release flow unchanged: bump `package.json`, tag, GitHub
release, bump the tap formula url+sha, `brew upgrade` + `opencode-tanzu-install`.

## Testing

- **discovery**: `probeContextLength` — 400 body → integer; `max_total_tokens=`
  infix parsed; 2xx success → `null`; timeout → `null`; network error → `null`;
  non-matching body → `null`; NaN/≤0 → `null`. `probeToolCall` — tool_call
  present → `true`; absent → `false`; error → `null`.
- **capabilities**: `unknownChatIds` — excludes table ids and embeddings,
  includes unknown chat ids; empty input → `[]`.
- **cache**: fresh entry returned within TTL; stale entry (`probedAt` older than
  TTL) → `undefined`; corrupt/missing file → `{}`, no throw; negative
  (`context: null`) entry honored within TTL; write failure swallowed.
- **drift script**: `diffRoster` — all covered → empty `uncoveredChat`;
  unknown chat id surfaces in `uncoveredChat`; embedding id lands in
  `excludedEmbeddings`, not `uncoveredChat`.
- **plugin config hook (integration, existing mock-fetch harness)**: unknown id
  → probed → card gains `max_model_len` → resolved at that context; known id →
  no probe issued; cache hit → no probe issued; probe `null` → card resolves at
  the 8192 default and provider still registers.

All existing 42 tests remain green.
