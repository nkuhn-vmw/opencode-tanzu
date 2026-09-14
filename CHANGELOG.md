# Changelog

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
