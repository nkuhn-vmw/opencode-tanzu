# opencode-tanzu

An [opencode](https://opencode.ai) plugin that adds a **Tanzu** provider, serving your
[Tanzu Platform](https://www.vmware.com/products/app-platform/tanzu) AI Services (GenAI) tile's
models through its OpenAI-compatible proxy.

> **Community project. Not supported by Broadcom/VMware.** No warranty, no SLA, not an official
> distribution. Issues and PRs are welcome, but nothing here is a supported product.

Zero runtime dependencies. Four plain JavaScript files. The source tree **is** the installed
artifact — there is nothing to build and no package manager in the install path.

**What you get:**

- Your platform-served models as a normal opencode provider — no OpenAI/Anthropic API key, no
  data egress; the agent's brain runs on your own Cloud Foundry foundation.
- **Live roster discovery**: models are discovered from your foundation's `/v1/models` on every
  start, so the picker tracks tile roster changes automatically.
- A **login flow** (`opencode providers login -p tanzu`) that validates your credentials against
  the foundation before saving anything.
- **No secrets in your config file** — the API key lives in a `0600` file under opencode's data
  dir; the config holds only the proxy URL.

## Install

Via Homebrew:

```bash
brew install nkuhn-vmw/tap/opencode-tanzu
opencode-tanzu-install
```

Or from a clone:

```bash
git clone https://github.com/nkuhn-vmw/opencode-tanzu.git
cd opencode-tanzu && ./install.sh
```

Both do the same thing: copy the four `src/*.js` files into opencode's global plugin directory
(`${XDG_CONFIG_HOME:-~/.config}/opencode/plugins/`), where opencode auto-loads them at startup.
Update with `brew upgrade opencode-tanzu && opencode-tanzu-install` (or `git pull &&
./install.sh`); remove with `opencode-tanzu-install --uninstall` (or `./install.sh
--uninstall`).

Prefer per-project? `./install.sh --project` installs into `./.opencode/plugins/` of the current
directory instead.

<details>
<summary>Why not <code>npm</code> / <code>opencode plugin …</code>?</summary>

opencode's `plugin` config key auto-installs npm packages — plus their full transitive
dependency trees — via Bun at startup, on every machine that uses the config. This plugin is
deliberately distributed as four auditable files copied into the plugin directory instead: what
you review is exactly what runs. (The plugin also works packaged via the `plugin` key; it is
just not the recommended path.)
</details>

## Log in

```bash
opencode providers login -p tanzu
```

You will be asked for **three** things — the proxy URL, the API key, and then the API key
*again*. The repeat is not a bug in this plugin; see
[Why it asks for the key twice](#why-it-asks-for-the-key-twice).

Both values come from a `cf` service key for a GenAI service instance on your foundation:

```bash
cf create-service <genai-offering> <plan> my-models        # once, if you have none
cf create-service-key my-models my-key                     # once
cf service-key my-models my-key
```

- **API key** — the key's `credentials.endpoint.api_key`.
- **Proxy URL** — the key's `credentials.endpoint.api_base` with **`/openai/v1` appended**.
  It must be `https` and must end in `/openai/v1`; the login prompt rejects anything else.

```
https://genai-proxy.sys.<foundation>/<instance>/openai/v1
```

Then verify:

```bash
opencode models tanzu
```

## Where your credentials go

| What | Where |
|---|---|
| API key | `$XDG_DATA_HOME/opencode/opencode-tanzu/apikey` (else `~/.local/share/opencode/…`), mode **0600** in a **0700** directory |
| Proxy URL | `provider.tanzu.options.baseURL` in `~/.config/opencode/opencode.json` |

**Your config file holds no API key — not the key, and not a reference to it.** Login persists
only the proxy URL. The plugin reads the key file itself at startup and keeps the key in memory
only. The key is also stored in opencode's own `auth.json`, which is what `providers login` does
for every provider.

### If the key file goes missing

Nothing breaks. The provider still registers, off the plugin's bundled model list, and prints:

```
[tanzu] no API key in the config or environment; using the bundled model list.
```

Log in again to restore live discovery: `opencode providers login -p tanzu`.

### Environment fallback

If you would rather configure nothing, set both of these and skip the login entirely:

```bash
export TANZU_GENAI_BASE_URL="https://genai-proxy.sys.<foundation>/<instance>/openai/v1"
export TANZU_GENAI_API_KEY="$(cat /path/to/token)"
```

Config takes precedence over the environment. A base URL is mandatory; without one the plugin
contributes nothing at all — an installed but unconfigured plugin never litters your picker.

## No plugin at all: the config-only fallback

Any OpenAI-compatible endpoint can be registered in plain `opencode.json` with no plugin — see
[`examples/opencode.json`](examples/opencode.json). You lose live discovery, the login flow, and
capability metadata (you pin models and limits by hand), but it is a zero-install option and the
right shape for committed, reproducible per-project configs. Note the `{file:…}` apiKey
indirection is safe **only** in the no-plugin setup; a dangling `{file:…}` reference stops
opencode from starting, which is exactly why this plugin never writes one.

## Models

The roster is **discovered live** from your foundation's `/v1/models` on every start.

The tile's `/v1/models` reports only model **ids** — no context window, no tool-call support, no
modalities. (vLLM exposes `max_model_len`; the tile's proxy strips it.) Capability metadata is
therefore **bundled** with the plugin, hand-sourced from each model's card and `config.json`:

- A discovered id **in** the bundled table gets its real context window, output limit, tool-call
  support and modalities.
- A discovered id **not** in the table still appears, named **`<id> (Tanzu, unverified)`**, with a
  conservative **8192**-token context and 4096-token output. It works; it is just not tuned.
  PRs adding verified entries to `src/opencode-tanzu-capabilities.js` are welcome.
- **Unknown ids are probed for their real context window and tool-call
  support.** The tile strips `max_model_len` from `/v1/models`, but vLLM
  reveals it when asked for an impossible `max_tokens`, so the plugin fires
  two cheap requests per unknown model — one for context length, one for
  tool-call support, concurrently — and uses the answers. Results are cached
  under `$XDG_DATA_HOME/opencode/opencode-tanzu/discovery-cache.json` (else
  `~/.local/share/opencode/opencode-tanzu/discovery-cache.json`), but **not
  all alike**:
  - A **conclusive** result — a real numeric context, a backend that clamps
    instead of erroring (the ollama path, see below), or a definite
    tool-call verdict — is cached for **~7 days**, so a steady-state start
    makes no extra requests for that model.
  - An **inconclusive** result — a timeout, an unreachable foundation, a
    5xx, or any other "we couldn't tell" outcome — is cached for only
    **~30 minutes** on the first miss, so one unlucky startup (a flaky VPN,
    a tile worker restarting) can't pin a brand-new model at the
    conservative 8192 default for a week. Each further CONSECUTIVE
    inconclusive result for that same model doubles the retry interval
    (30m → 1h → 2h → 4h → ...), capped at the same **~7 days** a conclusive
    result gets — so a model that is inconclusive on every attempt settles
    into progressively rarer retries instead of re-probing (and re-paying
    the probe's request cost) on a fixed 30-minute cadence forever. A single
    conclusive result resets the count back to zero.
  - Models served through the tile's ollama backend (colon-tag ids like
    `qwen3:14b`, or `hf.co/...`-style ids) clamp `max_tokens` instead of
    erroring. When that clamp answers quickly enough for the probe to see a
    real completion, it's scored a conclusive `CLAMPED` result and cached
    for the full week, same as any other conclusive answer. But some of
    these backends are slow enough — they're actually generating a full
    response instead of failing validation — that they never answer inside
    the probe's 8-second timeout at all, so every probe against them is
    inconclusive. Those ids are un-probeable in practice and are exactly
    what the backoff above exists for: rather than re-stalling opencode's
    startup by ~8 seconds every 30 minutes forever, they back off to
    ever-longer retry intervals while still keeping the conservative
    defaults.

  **Deleting the cache file forces every unknown model to be re-probed on
  the next start** — the plugin degrades to "no cache" exactly like a
  missing or corrupt one. This is the escape hatch if you suspect a stale or
  wrong cached value:

  ```bash
  rm "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode-tanzu/discovery-cache.json"
  ```
- If the tile ever stops stripping `max_model_len`, a served context limit overrides the bundled
  one automatically — an operator's `--max-model-len` cap must win over the table.
- **Embedding and reranking models are excluded by design** — opencode cannot chat with them.

If discovery fails for any reason, the provider **still registers** off the bundled table, with a
warning on stderr. You never get an empty picker.

**Startup can stall for up to ~60 seconds, in two separate phases.** Roster discovery is awaited
during opencode's `config` hook with a 20-second timeout. When that roster contains ids the
bundled table has never seen, the plugin then probes each one for its real context window and
tool-call support, in a worker pool of up to 6 concurrent ids at a time (each probe request has its
own 8-second timeout) capped at 25 ids per run — and the WHOLE probe phase additionally carries an
overall wall-clock budget, exported as `PROBE_PHASE_BUDGET_MS` (40 seconds), so a run that hits it
simply stops starting new probes and falls back to the conservative default for whatever it didn't
reach, rather than the phase's duration being an unenforced side effect of the other constants. 20
seconds of discovery plus a 40-second probe budget is where the ~60-second worst case comes from. A
foundation that actively refuses the connection degrades quickly, but one that answers `/v1/models`
and then silently blackholes `/chat/completions` (a packet-dropping firewall or VPN) will make
opencode's startup appear to hang for close to that full ~60 seconds before falling back to the
bundled table for whatever wasn't reached. That is a stall, not a freeze — it resolves on its own.

### Caveat: a hand-pinned roster will be replaced

The plugin's `config` hook sets `provider.tanzu.models` **unconditionally**: a hand-written
`models` block in your `opencode.json` is discarded in favor of whatever discovery returns (or
the bundled table when the foundation is unreachable). Everything else in the stanza is preserved
(`name`, `npm`, other `options`). If you need a pinned roster, use the
[config-only fallback](#no-plugin-at-all-the-config-only-fallback) without the plugin.

## When the tile swaps a model

A foundation's served models rotate, and an id changes whenever the quant or the
serving hardware changes — `poolside/Laguna-S-2.1-INT4` became
`poolside/Laguna-S-2.1-NVFP4` when CDC moved that model to Blackwell. Because
the tile does not report `max_model_len`, a new id has no known context window.

The plugin now probes for it automatically, so in most cases there is nothing to
do. To check a foundation for models the bundled table does not cover, run this
from a clone of the repo (`npm run drift` is a repo script — it is not one of
the four files a Homebrew install copies, so it is unreachable from a
`brew install` setup):

```bash
git clone https://github.com/nkuhn-vmw/opencode-tanzu.git && cd opencode-tanzu
export TANZU_GENAI_BASE_URL="https://genai-proxy.sys.<foundation>/<instance>/openai/v1"
export TANZU_GENAI_API_KEY="…"     # from `cf service-key <instance> <key>`
npm run drift -- --probe
```

To read one model's served limit by hand, ask for an impossible `max_tokens` —
the response body's error message carries the real number:

```bash
curl -s -H "Authorization: Bearer $TANZU_GENAI_API_KEY" -H "Content-Type: application/json" \
  "$TANZU_GENAI_BASE_URL/chat/completions" \
  -d '{"model":"<model-id>","messages":[{"role":"user","content":"hi"}],"max_tokens":999999999}'
# The response is a JSON error body, e.g. {"error":{"message":"...","type":"..."}};
# the line below is just the extracted "message" text, not the raw response:
# → max_tokens=999999999 cannot be greater than max_model_len=max_total_tokens=262144
```

Add a row to `src/opencode-tanzu-capabilities.js` when you want curated metadata
a probe cannot recover (modalities, a friendly name, a verified `tool_call`).
PRs welcome.

## Troubleshooting

**opencode keeps compacting the session / the agent appears to loop**
Almost always a context-window miss, not a model problem: opencode is compacting
to stay under a context limit far smaller than the model really has. It happens
when a served id has no table row and could not be probed. Check what the
provider actually registered:

```bash
npm run drift -- --probe
```

(`npm run drift` is a repo script, so this needs a clone —
`git clone https://github.com/nkuhn-vmw/opencode-tanzu.git && cd opencode-tanzu`
— not a Homebrew install; see [When the tile swaps a model](#when-the-tile-swaps-a-model).)

If the model shows up under DRIFT with a probed context, upgrade the plugin
(`brew upgrade nkuhn-vmw/tap/opencode-tanzu && opencode-tanzu-install`, or
`git pull && ./install.sh`) and restart opencode — the plugin's model list is
built at startup.

If the probe cannot determine it, a hand-written `models` override in
`~/.config/opencode/opencode.json` will **not** help — see
[Caveat: a hand-pinned roster will be replaced](#caveat-a-hand-pinned-roster-will-be-replaced):
the config hook overwrites `provider.tanzu.models` unconditionally on every
start, plugin installed or not. Two options that actually work instead:

- Add a row for the model to `src/opencode-tanzu-capabilities.js` (a context
  window, an output limit, `tool_call`) and reinstall — this is the same file
  the bundled table and the drift script both read.
- Drop the plugin and use the
  [config-only fallback](#no-plugin-at-all-the-config-only-fallback): with no
  `tanzu` plugin installed, nothing overwrites a hand-pinned `models` block.

**`401` / "The foundation rejected the API key"**
The bearer token is an ephemeral JWT and expires. Fetch a fresh one from your service key
(`cf service-key <instance> <key>`) and re-run `opencode providers login -p tanzu`. Note that on
a 401 discovery degrades to the **bundled** roster — seeing models listed does **not** mean your
key is good. Watch stderr.

**The `tanzu` provider is missing entirely**
The plugin contributes nothing when unconfigured. Check that either
`provider.tanzu.options.baseURL` is set in your config or `TANZU_GENAI_BASE_URL` is exported. If
a `tanzu` stanza exists but has no usable models, the plugin removes it and tells you why
(opencode deletes a zero-model provider without any message, which is worse).

**An embedding model is missing from the picker**
Working as intended. See [Models](#models).

**Why it asks for the key twice**
opencode's own login flow appends a built-in `Enter your API key` prompt to every `type: "api"`
plugin method, and it does not pass that value to the plugin. The plugin needs the key itself to
validate it against the foundation, write the key file, and enable live discovery — so it must
ask too. The plugin's answer is the one that is used; the built-in prompt's value is discarded.
Verified against opencode 1.18.1.

## Development

```bash
npm test          # node --test; 76 tests, no dependencies
```

The plugin registers its provider through opencode's plugin `config`/`auth` hooks. The provider
registration pattern sits partly outside opencode's *documented* plugin API surface; it is
verified end-to-end against **opencode 1.18.1**. If an opencode release changes plugin behavior,
expect this repo to need a follow-up — pin your opencode version if that matters to you.

Requires Node ≥ 20 (for `node --test`); the plugin itself runs inside opencode's runtime.

## Roadmap

Listing Tanzu in [models.dev](https://github.com/anomalyco/models.dev) — the
registry opencode reads its built-in provider catalog from — would make `tanzu`
a first-class provider id rather than one this plugin contributes. That is a
metadata-only PR upstream; this plugin would remain the home for live roster
discovery and the login flow, which a static registry entry cannot provide.

## License

Apache-2.0
