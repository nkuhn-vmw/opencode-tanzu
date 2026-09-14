# Tanzu models in standalone OpenCode V2 / beta

Plugin 0.3.0 adds a native V2 provider without a Cloud Foundry buildpack.
It shares V1 discovery, capability metadata, probing and caching, but has a
separate entry point. Tested runtimes are OpenCode **2.0.3** and **0.0.0-beta-19425**.
See [validation](validation-standalone-v2.md) for exactly what was tested.

## Homebrew

```bash
brew install nkuhn-vmw/tap/opencode-tanzu
opencode-tanzu-install --runtime v2

export TANZU_GENAI_BASE_URL='https://genai-proxy.example.com/instance/openai/v1'
export TANZU_GENAI_API_KEY_FILE="$HOME/.config/tanzu/api-key"
opencode-tanzu-v2
```

If current Homebrew reports an untrusted community tap, review the
[tap repository](https://github.com/nkuhn-vmw/homebrew-tap), run
`brew trust --tap nkuhn-vmw/tap`, then retry. This trusts formula code from
that tap.


Create the token file from the service key supplied by your platform operator;
use a private directory (0700) and a file readable only by you (0600). Do not
commit the token or paste it into a command argument. The URL is the key's
`endpoint.api_base` plus `/openai/v1`; the key is `endpoint.api_key` (sometimes
nested under `credentials`). The file contains only the raw key.

Alternatively export `TANZU_GENAI_API_KEY` from your secret manager. If both
are set, the token file wins. The stable V2 package names its binary `opencode`; keep it separate from V1
and point `OPENCODE_V2_BIN` at that V2 executable. The beta package names it
`opencode2`.

V2 does not use V1's `providers login` flow or
silently reuse V1's auth store. It reads the token file on discovery and on each
inference request, allowing rotation without a restart. A missing/unreadable
file fails the operation; no credentials are printed or generated into config.

Install the V2 executable separately. If yours is not named `opencode2`:

```bash
export OPENCODE_V2_BIN='/absolute/path/to/opencode2'
opencode-tanzu-v2 --version
```

## From source

```bash
git clone https://github.com/nkuhn-vmw/opencode-tanzu.git
cd opencode-tanzu
./install.sh --runtime v2
# Set the environment variables above, then:
./bin/opencode-tanzu-v2
```

The source installer and Homebrew installer use the same implementation.
Node >=20 is needed to run repository tests, not to load the plugin in OpenCode.
No npm download or build step is needed for the plugin.

## Isolation and project installs

The V2 wrapper places `opencode-tanzu-v2` beneath each current XDG config,
data, cache and state root, then launches V2. With standard XDG defaults,
plugins live in `~/.config/opencode-tanzu-v2/opencode/plugins/opencode-tanzu-v2/`.
V1's global plugins, login and sessions remain in their existing locations.

Override a complete V2 root with `OPENCODE_TANZU_V2_CONFIG_HOME`,
`OPENCODE_TANZU_V2_DATA_HOME`, `OPENCODE_TANZU_V2_CACHE_HOME` or
`OPENCODE_TANZU_V2_STATE_HOME`. Set the same config-root override during
installation and launch. An override is an XDG root: OpenCode appends `opencode`.
The wrapper preserves your working directory and all CLI arguments.

For a project install, run `/path/to/opencode-tanzu/install.sh --runtime v2
--project` from the project directory. This creates a native plugin directory
under `.opencode/plugins/`. Use it only in V2 projects; do not mix V1 and V2
plugin entry points in one project. Keep credentials outside the project.

The wrapper isolates global state, but OpenCode still reads project config.
A V1 `opencode.json` symlink created by `octnz-init` is not a V2 config: remove
that symlink before using V2 there, or use a separate project checkout.

## Configuration and model limits

No provider JSON is needed for environment-based setup. The plugin registers
`Tanzu Platform` using `@opencode/ai/providers/openai-compatible`, discovers
chat models and makes them visible in the V2 picker. Embeddings and rerankers
are excluded. Unknown model IDs retain conservative capabilities when probing
is inconclusive.

V2 probes known model names too: a model-card maximum does not prove a served
limit. A catalog or probe limit wins; otherwise context/output default to at
most 8192/4096. No lab-specific serving limit is assumed for other foundations.
Native `providers.tanzu.models` entries with positive context/output limits
retain your explicit limits. Output is clamped to context. Native model/body/default overrides remain authoritative. A disabled Tanzu provider or an
explicit alternative provider package is left alone.

The catalog refreshes every five minutes. Set
`OPENCODE_TANZU_REFRESH_INTERVAL_MS` (clamped to 30000–3600000) to change this.
Refreshes do not overlap. Failed refreshes retain the previous/configured
catalog; an initial failure without configured models leaves no usable Tanzu
models. A retained roster is not proof that authentication still works.
Probing shares the bounded request budget and disk cache described in the
[main README](../README.md#models), under the isolated V2 data root.

Optionally set `OPENCODE_TANZU_MODEL` to a served model ID. It supplies a
default only when the catalog has none; an explicit native `model` setting wins.
For per-project provider options, a native config can reference the plugin
entry with `plugins: [{ "package": "file:///absolute/path/to/plugin",
"options": { "baseURL": "https://example.com/instance/openai/v1",
"apiKeyFile": "/absolute/path/to/token", "refreshIntervalMs": 300000 } }]`.
Do not also auto-install the same plugin for that project. Plugin options take precedence over the environment. Configure the foundation
URL and key file through those options or environment variables, not native
`providers.tanzu.settings`: V2 applies that native configuration after plugin
activation, so it cannot supply this plugin's initial discovery credentials.
The plugin rejects native requests that bypass its local transport. The
config-only V1 fallback in the main README is a separate installation path.

The beta adapter removes only the runtime-generated `prompt_cache_key` from
Tanzu chat requests. Explicit provider/model body overrides remain authoritative.
The plugin starts an authenticated loopback forwarder inside the OpenCode
process. Native V2 receives only its ephemeral local credential; the real
foundation key is read by the forwarder and sent to the configured HTTPS
chat endpoint using redirect-rejecting fetch. This is necessary because the
native runtime discards Web Request redirect settings. The forwarder permits
only chat-completion POSTs, caps request bodies at 32 MiB, streams responses,
and stops with the plugin. The actual foundation key is absent from the
native model catalog. Discovery/probing also reject redirects. For private CAs, set `NODE_EXTRA_CA_CERTS` before launch.
Never disable TLS verification.

## Verify and troubleshoot

```bash
opencode-tanzu-v2 models
opencode-tanzu-v2 run --standalone --model 'tanzu/<served-model-id>' \
  'Do not use tools. Reply with exactly TANZU_OK.'
```

A model listing proves discovery, not inference. Verify a real response with
your chosen model. If no models appear, check the V2 plugin install path,
endpoint, token, CA trust and stderr. Activation may include up to about a
minute of discovery/probing on a cold start. A 401 means refresh credentials;
use your platform's approved service-key process or the
[`octnz` launcher](https://github.com/nkuhn-vmw/opencode-on-tnz#opencode-v2--beta).
This plugin never creates, deletes or rotates a CF service key itself.

If plain `opencode2` cannot see the plugin, launch with `opencode-tanzu-v2`,
which selects the isolated XDG paths. Desktop clients must connect to that
backend to use its plugins; these commands do not modify a desktop app's
embedded backend. Use authenticated server configuration when exposing a
backend beyond loopback.

## Upgrade and uninstall

```bash
brew upgrade nkuhn-vmw/tap/opencode-tanzu
opencode-tanzu-install --runtime v2
# Or from a clone: git pull && ./install.sh --runtime v2

opencode-tanzu-install --runtime v2 --uninstall
# Or: ./install.sh --runtime v2 --uninstall
```

Restart active V2 processes after upgrading. Uninstall removes the selected
runtime's plugin files only; config, credentials, cache, sessions and unrelated
files remain. Add `--project` for a project installation. V1 users continue to
use `opencode-tanzu-install --runtime v1` and their existing login workflow.
