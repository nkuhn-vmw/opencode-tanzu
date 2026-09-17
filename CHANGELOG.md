# Changelog

## [0.4.0] — 2026-09-17

### Fixed
- **Per-model request options were inert and are now actually sent.** The
  `options` blocks added in 0.2.3 (DeepSeek-V4-Flash and Qwen3.8-27B-FP8, plus
  the `deepseek*`/`qwen*` family fallbacks) used AI SDK **CallSettings**
  spelling — `topP`, `frequencyPenalty`. opencode does not turn a model entry's
  `options` into call settings. It merges them into the provider-options bag
  (`LLM`'s params builder → `ProviderTransform.providerOptions`), keyed by
  `sdkKey(model.api.npm) ?? model.providerID`; `sdkKey` has no case for
  `@ai-sdk/openai-compatible`, so for this provider the key is `"tanzu"`, and
  `OpenAICompatibleChatLanguageModel.getArgs()` spreads every key of that bag
  that is not one of its own three schema keys **verbatim** into the
  `/chat/completions` body. So `topP`/`frequencyPenalty` travelled to vLLM as
  unknown body fields under those literal names and the sampler never saw them:
  the measured DeepSeek anti-loop fix was shipped but never applied, for two
  releases. All bundled options now use the OpenAI-compatible **wire** spelling
  (`top_p`, `frequency_penalty`) — the same shape as a hand-written
  `opencode.json` entry that is known to work. Traced against the opencode
  1.2.27 bundle, 2026-09-17; the full trace is recorded in the
  "PER-MODEL REQUEST OPTIONS" note at the top of
  `src/opencode-tanzu-capabilities.js`, and a test now fails on any camelCase
  option key.
  
  This was invisible on the standalone V2 provider added in 0.3.0, which
  rewrites `topP`/`frequencyPenalty`/`presencePenalty` to their wire names in
  `applySamplingDefaults` before forwarding and passes every other key
  through unchanged. Wire spelling is therefore correct on BOTH runtimes; the
  camelCase spelling was correct on neither, because the V1 path has no such
  rewrite.
- `resolveModels` hands out a copy of the table's `options` object rather than
  the table's own reference, so an override merged into one resolved entry
  cannot leak back into `TABLE` and affect every later call in the process.

### Added
- `OPENCODE_TANZU_MODEL_OPTIONS_JSON` — an operator override for per-model
  request options, keyed by served model id, e.g.
  `{"deepseek-ai/DeepSeek-V4-Flash-0731":{"frequency_penalty":0.5}}`. It merges
  over the bundled defaults key by key, so overriding one parameter keeps the
  rest. Values are validated against an allowlist with ranges
  (`temperature`, `top_p`, `top_k`, `min_p`, `frequency_penalty`,
  `presence_penalty`, `repetition_penalty`, `seed`) because whatever lands in
  `options` goes straight onto the wire. An unparseable document is discarded
  whole and reported; a well-formed document with one bad key keeps the good
  keys; an id the foundation does not serve is reported rather than silently
  ignored. None of these paths can fail a startup.
- The same override on the standalone V2 provider: `discoverCatalog` now runs
  it over the resolved roster, so a V1 install and a V2 install put identical
  sampling parameters on the wire.
- A startup log line per model that carries options —
  `[tanzu] applied model options for <id>: {…}` — so "did `frequency_penalty`
  actually reach the worker?" is answerable from the log instead of a packet
  capture.
- Re-confirmation of the DeepSeek-V4-Flash anti-loop evidence in the table
  comment: a blind 8-replicate A/B replay of the worst real failing session
  against the live NDC worker gave 0/8 hard degenerations at
  `frequency_penalty 0.5` versus 4/8 at 0 (Fisher's exact p ≈ 0.0001,
  2026-09-17), plus the verified non-fixes (`reasoning_effort` tuning,
  `chat_template_kwargs`, `reasoning_effort: "none"`) so they are not retried.

### Notes
- The companion loop-guard plugin (`opencode-deepseek-guard.js`) does not ship
  from this package. A plugin cannot register a sibling plugin; the V1 entry
  point is a V1-format plugin, which cannot load a V2-format one; and on the
  Cloud Foundry path the buildpack copies a fixed allowlist of this package's
  `src/` files and stages them as a package with a single `main`, so a file
  added here would be neither installed nor loaded. It lives in
  `opencode-buildpack` instead. See the README.

## 0.3.0

- Add a standalone native OpenCode V2/beta provider, catalog refresh, conservative served-limit discovery and beta prompt-cache compatibility.
- Add `--runtime v1|v2` installation and the isolated `opencode-tanzu-v2` launcher; retain V1 as the installer default.
- Keep foundation keys in a streaming, authenticated loopback forwarder that rejects redirects and preserves operator headers.
- Read V2 token files on each inference/refresh and reject redirects during discovery/probing.
- Share the installer with Homebrew and document V1/V2 setup, upgrades and troubleshooting.

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] — 2026-07-27

### Fixed
- Four ollama-style CDC models (`qwen3:14b`, `qwen3:30b-a3b`, `gemma4:e4b`,
  `hf.co/prism-ml/Bonsai-8B-gguf:Q1_0`) clamp `max_tokens` instead of erroring,
  so the startup probe can't read their real window and they were resolving
  to `CONSERVATIVE_CONTEXT` (8192) — double their real capacity. Measured live
  by sending a ~40,000-token prompt and reading `usage.prompt_tokens` back:
  all four silently truncated the input to ~4096 tokens (ollama's default
  `num_ctx`), with no error surfaced anywhere. Advertising 8192 let opencode
  pack a context that ollama then silently discarded half of — strictly worse
  than the compaction-loop problem this project exists to fix, since nothing
  told the agent it had lost context. Added table rows advertising the
  measured-safe 4096 for all four. `qwen3:14b`'s native tool-calling was
  verified live and `qwen3:30b-a3b` is treated as verified by extension (same
  Qwen3 family/template); `gemma4:e4b` and the Bonsai GGUF are unverified and
  ship with `tool_call: false` rather than an unconfirmed assumption.

## [0.2.0] — 2026-07-27

### Added
- Automatic context-window discovery for models with no bundled table row. The
  tile strips `max_model_len` from `/v1/models`, but vLLM reports it when asked
  for an impossible `max_tokens`, so unknown ids are probed once and cached.
- Tool-call probing for unknown models, replacing the optimistic assumption that
  every unknown model supports tools.
- A probe-result cache (`discovery-cache.json`) with a conclusive/inconclusive
  TTL split: a definite answer (a real context number, or a backend that
  provably clamps instead of reporting a limit) is cached for 7 days, while an
  inconclusive probe (a timeout, a 5xx, a worker mid-restart) is retried after
  30 minutes instead of being pinned as if it were permanent. The cache also
  carries a schema version and discards a file written by an incompatible
  version rather than trusting a shape it no longer understands.
- Exponential backoff for a model that comes back inconclusive on every
  consecutive attempt (30m → 1h → 2h → 4h → ..., capped at the same 7-day TTL
  a conclusive result gets). Some ollama-style backends (colon-tag ids like
  `qwen3:14b`, `hf.co/...`-style ids) clamp `max_tokens` instead of erroring
  but are slow enough that they never answer inside the probe's timeout —
  every probe against them is inconclusive, so without backoff they were
  re-probed (and re-stalled opencode's startup by several seconds) every 30
  minutes forever. A single conclusive result still resets the count, and a
  first-ever inconclusive result is still retried after ~30 minutes — a
  one-off timeout still cannot pin a model long-term.
- A per-start cap on how many unknown models get probed, a bounded
  concurrency limit on in-flight probe requests, and an enforced wall-clock
  budget on the whole probe phase — a foundation with a very large or hostile
  roster cannot turn one cold start into hundreds of simultaneous generation
  requests, or stall startup past a fixed ceiling. Models left over from any
  of the three bounds keep the conservative default this run and are probed
  on a later start.
- `scripts/check-roster-drift.mjs` (`npm run drift`) — reports foundation models
  the capability table does not cover, with `--probe` to read their real limits.
- CI: `node --test` on push and pull request.
- Docs: "When the tile swaps a model", a troubleshooting entry for the
  compaction/looping symptom, and a roadmap note about models.dev.

### Changed
- Unknown models now resolve at their real served context instead of always
  falling back to 8192.

## [0.1.2] — 2026-07-24

### Added
- `poolside/Laguna-S-2.1-NVFP4` at its served 262144 context. CDC swapped Laguna
  from the INT4 build to the Blackwell NVFP4 build; the new id fell to the 8192
  unknown-default and opencode compacted sessions nonstop.

## [0.1.1] — 2026-07-22

### Added
- `poolside/Laguna-S-2.1-INT4` at its served 131072 context.

### Changed
- Bundled-fallback tests derive the roster count from the table instead of
  hardcoding it, so adding a model cannot silently break them.

## [0.1.0] — 2026-07-22

### Added
- First public release: a zero-dependency opencode plugin registering a `tanzu`
  provider with live roster discovery, a login flow that validates credentials
  before saving, and no secrets in the opencode config file.
- `install.sh` and a Homebrew formula (`nkuhn-vmw/tap/opencode-tanzu`).
