# V2 model discovery and probe budget

The native provider uses the shared discovery/cache modules. It discovers chat
models from the configured OpenAI-compatible endpoint and excludes embedding
and reranking models. V2 probes known model names too, rather than treating
curated card metadata as proof of a served context window.

Discovery has a 20-second timeout. Probes use an 8-second per-request timeout,
a pool of up to six model IDs, a limit of 25 IDs, and a 40-second overall probe
phase budget. A cold activation can therefore take about a minute. Probes are
real requests and may consume model capacity; cached starts reduce that cost.

Conclusive results are cached for about seven days. Inconclusive results start
with about a 30-minute retry interval; consecutive misses double that interval
up to about seven days. A conclusive result resets the miss count. Slow backends
that clamp output instead of returning a limit error may remain inconclusive.

The disk cache is `opencode/opencode-tanzu/discovery-cache.json` beneath the
launcher's isolated XDG data root. With standard defaults this is
`~/.local/share/opencode-tanzu-v2/opencode/opencode-tanzu/discovery-cache.json`.
Removing only that cache forces probes again; use this deliberately because it
can add startup latency and endpoint load. A missing or corrupt cache falls back
to discovery, not to a successful inference claim.

Without verified limits, context/output remain conservative at most 8192/4096.
Explicit positive native limits are retained, and output is clamped to context.
Failed refreshes preserve an existing/configured roster; initial failure with
no configured models leaves no usable Tanzu models.

See [configuration](opencode-v2.md#configuration-and-model-limits) for refresh
intervals and [sampling](opencode-v2.md#sampling-defaults-and-overrides) for body
precedence. Historical V1 fallback-roster behavior is documented separately in
[the legacy reference](legacy-v1.md#models).
