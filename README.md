# opencode-tanzu

An [opencode](https://opencode.ai) plugin that adds a **Tanzu** provider, serving your
[Tanzu Platform](https://www.vmware.com/products/app-platform/tanzu) AI Services (GenAI) tile's
models through its OpenAI-compatible proxy.

> **Community project. Not supported by Broadcom/VMware.** No warranty, no SLA, not an official
> distribution. Issues and PRs are welcome, but nothing here is a supported product.

Zero runtime dependencies. Three plain JavaScript files. The source tree **is** the installed
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

Both do the same thing: copy the three `src/*.js` files into opencode's global plugin directory
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
deliberately distributed as three auditable files copied into the plugin directory instead: what
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
- If the tile ever stops stripping `max_model_len`, a served context limit overrides the bundled
  one automatically — an operator's `--max-model-len` cap must win over the table.
- **Embedding and reranking models are excluded by design** — opencode cannot chat with them.

If discovery fails for any reason, the provider **still registers** off the bundled table, with a
warning on stderr. You never get an empty picker.

**Discovery can take up to 20 seconds.** It is awaited during opencode's `config` hook with a
20-second timeout. A foundation that actively refuses the connection degrades quickly, but one
that is unreachable behind a packet-dropping firewall or VPN will make opencode's startup appear
to hang for the full 20 seconds before falling back to the bundled table. That is a stall, not a
freeze — it resolves on its own.

### Caveat: a hand-pinned roster will be replaced

The plugin's `config` hook sets `provider.tanzu.models` **unconditionally**: a hand-written
`models` block in your `opencode.json` is discarded in favor of whatever discovery returns (or
the bundled table when the foundation is unreachable). Everything else in the stanza is preserved
(`name`, `npm`, other `options`). If you need a pinned roster, use the
[config-only fallback](#no-plugin-at-all-the-config-only-fallback) without the plugin.

## Troubleshooting

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
npm test          # node --test; 40 tests, no dependencies
```

The plugin registers its provider through opencode's plugin `config`/`auth` hooks. The provider
registration pattern sits partly outside opencode's *documented* plugin API surface; it is
verified end-to-end against **opencode 1.18.1**. If an opencode release changes plugin behavior,
expect this repo to need a follow-up — pin your opencode version if that matters to you.

Requires Node ≥ 20 (for `node --test`); the plugin itself runs inside opencode's runtime.

## License

Apache-2.0
