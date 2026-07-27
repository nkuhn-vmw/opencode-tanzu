# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-07-27

### Added
- Automatic context-window discovery for models with no bundled table row. The
  tile strips `max_model_len` from `/v1/models`, but vLLM reports it when asked
  for an impossible `max_tokens`, so unknown ids are probed once and cached.
- Tool-call probing for unknown models, replacing the optimistic assumption that
  every unknown model supports tools.
- A probe-result cache (`discovery-cache.json`, 7-day TTL) that also remembers
  negative results, so unprobeable backends are not re-probed every start.
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
