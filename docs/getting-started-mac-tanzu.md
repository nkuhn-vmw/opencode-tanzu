# OpenCode V2 on a Mac with Tanzu AI Services

Run OpenCode on your MacBook and use models hosted by your platform's Tanzu AI
Services tile. Your source files and tools stay on your Mac; prompts and tool
results go to the selected Tanzu model endpoint.

This guide uses the community [opencode-tanzu provider](https://github.com/nkuhn-vmw/opencode-tanzu),
whose verified combination is **OpenCode 2.0.18 + plugin 0.5.1**. You do not
need to deploy an OpenCode application or install a CF buildpack.

## 1. Install the Mac tools and OpenCode V2

You need [Homebrew](https://brew.sh), access to a Tanzu Platform for Cloud
Foundry org/space with AI Models enabled, and permission to create a service
instance and service key. Connect to your company VPN if required.

In Terminal (macOS's default zsh):

```bash
brew install node jq
brew install cloudfoundry/tap/cf-cli@8

# Keep this V2 runtime separate from any existing OpenCode installation.
npm install --prefix "$HOME/.local/share/opencode-v2" @opencode/cli@2.0.18
export OPENCODE_V2_BIN="$HOME/.local/share/opencode-v2/node_modules/.bin/opencode"
"$OPENCODE_V2_BIN" --version
```

Confirm the version is `2.0.18`. This installs the runtime for your Mac's
architecture and avoids replacing an existing global `opencode` command.

## 2. Create your Tanzu AI service instance

Replace the API URL, org and space with values from your platform team:

```bash
cf login -a https://api.YOUR-FOUNDATION.example.com --sso
cf target -o YOUR-ORG -s YOUR-SPACE
cf target
cf marketplace -e ai-models
```

If your foundation does not support `--sso`, use its approved CF login flow.
Check the target before creating anything. Choose an available plan containing
a chat model that supports tools. Offering and plan names vary by foundation;
`tanzu-all-models` is an example, not a required plan.

```bash
# Replace YOUR-AI-PLAN with a plan from the marketplace output.
cf create-service ai-models YOUR-AI-PLAN mac-opencode-models
cf service mac-opencode-models
```

Wait until the service reports successful creation, then create a dedicated
workstation key:

```bash
cf create-service-key mac-opencode-models mac-opencode-key --wait
```

If `ai-models` is absent or service keys are disabled, ask your platform team
to enable access or supply an approved endpoint and key. A service instance
uses the models your operator has already configured in the tile.

## 3. Save the endpoint and API key privately

Run these commands in the same Terminal. They capture the service key without
printing it and extract either supported credential shape:

```bash
umask 077
mkdir -p "$HOME/.config/tanzu/opencode-v2"
chmod 700 "$HOME/.config/tanzu/opencode-v2"

cf service-key mac-opencode-models mac-opencode-key \
  > "$HOME/.config/tanzu/opencode-v2/service-key.txt"

sed -n '/^[[:space:]]*{/,$p' "$HOME/.config/tanzu/opencode-v2/service-key.txt" \
  | jq -er '.credentials.endpoint.api_key // .endpoint.api_key | select(type == "string" and length > 0)' \
  > "$HOME/.config/tanzu/opencode-v2/api-key"

sed -n '/^[[:space:]]*{/,$p' "$HOME/.config/tanzu/opencode-v2/service-key.txt" \
  | jq -er '.credentials.endpoint.api_base // .endpoint.api_base | select(type == "string" and startswith("https://"))' \
  > "$HOME/.config/tanzu/opencode-v2/api-base"

chmod 600 "$HOME/.config/tanzu/opencode-v2/"*
```

If either `jq` command fails, stop and ask your platform team about its
credential format. Do not launch with an empty key or URL. Once both succeed:

```bash
export TANZU_GENAI_API_KEY_FILE="$HOME/.config/tanzu/opencode-v2/api-key"
export TANZU_GENAI_BASE_URL="$(cat "$HOME/.config/tanzu/opencode-v2/api-base")"
export TANZU_GENAI_BASE_URL="${TANZU_GENAI_BASE_URL%/}"
case "$TANZU_GENAI_BASE_URL" in
  */openai/v1) ;;
  *) export TANZU_GENAI_BASE_URL="$TANZU_GENAI_BASE_URL/openai/v1" ;;
esac
rm "$HOME/.config/tanzu/opencode-v2/service-key.txt"
```

Keep the key outside your repositories. The token file contains only the API
key; the plugin rereads it for each request, so you can replace it when your
operator renews credentials. Never commit it or paste service-key output into
chat, tickets or shell commands.

## 4. Install the Tanzu plugin

```bash
brew install nkuhn-vmw/tap/opencode-tanzu
opencode-tanzu-install --runtime v2
opencode-tanzu-v2 --version
opencode-tanzu-v2 models
```

If Homebrew requests trust for the community tap, review the
[tap repository](https://github.com/nkuhn-vmw/homebrew-tap) before running
`brew trust --tap nkuhn-vmw/tap` and retrying.

Launch through `opencode-tanzu-v2`: it selects the plugin's isolated V2 config
and state. No provider JSON or V1 provider-login command is needed. Allow
about a minute for initial discovery. You should see `tanzu/…` model IDs.

## 5. Verify inference, then work in your project

Replace the model placeholder with an ID from the model listing:

```bash
opencode-tanzu-v2 run --standalone --model 'tanzu/YOUR-SERVED-MODEL-ID' \
  'Do not use tools. Reply with exactly TANZU_OK.'

opencode-tanzu-v2 run --standalone --model 'tanzu/YOUR-SERVED-MODEL-ID' \
  'Use the shell tool to run printf TANZU_TOOL_OK. Report its output.'
```

Expect `TANZU_OK`, then an actual completed shell-tool call producing
`TANZU_TOOL_OK`. Review normal permission prompts. A model listing alone
does not prove inference or tool use.

```bash
cd /path/to/your/project
opencode-tanzu-v2
```

Choose a Tanzu model in the model picker. Start with:
“Read the README and explain how to run this project. Do not modify files.”

For future Terminal sessions, add the three non-secret `export` values
(`OPENCODE_V2_BIN`, `TANZU_GENAI_API_KEY_FILE`, and the resolved
`TANZU_GENAI_BASE_URL`) to your `~/.zshrc`, or load them from your approved
local environment setup. Keep the actual API key in its private file.

## Quick troubleshooting

| Symptom | What to check |
| --- | --- |
| No `ai-models` offering or suitable plan | CF target, marketplace access and platform-team configuration. |
| Wrapper cannot run V2 | `OPENCODE_V2_BIN` must point at the installed V2 executable. |
| No Tanzu models | Plugin installation, endpoint, token file, VPN and stderr. |
| TLS certificate error | Set `NODE_EXTRA_CA_CERTS=/path/to/approved-ca.pem` before launch; keep TLS verification enabled. |
| Models appear but inference returns 401 | Renew the service-key credentials through your platform's approved process. |
| CLI works but desktop does not | Desktop must connect to this configured backend; its embedded backend has separate settings. |
| Migrating an existing Tanzu connection | Follow the native provider guide below; saved V1 credentials can conflict with V2 transport. |

For desktop pairing, migration, upgrades and detailed configuration, see the
[standalone V2 provider guide](opencode-v2.md).
For running OpenCode remotely on CF instead, see the
[V2 buildpack guide](https://github.com/nkuhn-vmw/opencode-buildpack/blob/main/docs/getting-started-opencode2.md).

Service-key command references: [create-service-key](https://cli.cloudfoundry.org/en-US/v8/create-service-key.html)
and [service-key](https://cli.cloudfoundry.org/en-US/v8/service-key.html).
