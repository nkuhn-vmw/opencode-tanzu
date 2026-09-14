#!/usr/bin/env bash
#
# Install (or uninstall) the opencode-tanzu plugin by copying its source files
# into opencode's global plugin directory, where opencode auto-loads every
# .js file at startup. No npm, no network, no dependencies — the four files
# in src/ are the entire plugin.
#
#   ./install.sh              install / update (idempotent)
#   ./install.sh --uninstall  remove the plugin files
#   ./install.sh --project    install into ./.opencode/plugins of the CWD
#                             instead of the global plugin directory
#
# Files must be copied FLAT into the plugin dir: opencode does not descend
# into subdirectories (verified against opencode 1.18.1). The opencode-tanzu-*
# filename prefix is what keeps this collision-safe next to other plugins.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILES=(opencode-tanzu.js opencode-tanzu-capabilities.js opencode-tanzu-discovery.js opencode-tanzu-cache.js)

RUNTIME="v1"
PROJECT=0
MODE="install"
TARGET_BASE="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime) [[ $# -ge 2 ]] || { echo "--runtime requires v1 or v2" >&2; exit 2; }; RUNTIME="$2"; shift 2 ;;
    --uninstall) MODE="uninstall"; shift ;;
    --project) PROJECT=1; shift ;;
    -h|--help) echo "Usage: $0 [--runtime v1|v2] [--project] [--uninstall]"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done
[[ "$RUNTIME" == v1 || "$RUNTIME" == v2 ]] || { echo "--runtime must be v1 or v2" >&2; exit 2; }
if [[ "$RUNTIME" == v2 ]]; then
  TARGET_BASE="${OPENCODE_TANZU_V2_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode-tanzu-v2}/opencode/plugins/opencode-tanzu-v2"
  [[ "$PROJECT" == 0 ]] || TARGET_BASE="$PWD/.opencode/plugins/opencode-tanzu-v2"
  FILES+=(opencode-tanzu-v2.js opencode-tanzu-transport.js)
else
  [[ "$PROJECT" == 0 ]] || TARGET_BASE="$PWD/.opencode/plugins"
fi

if [[ "$MODE" == "uninstall" ]]; then
  removed=0
  for f in "${FILES[@]}"; do
    if [[ -e "$TARGET_BASE/$f" ]]; then rm "$TARGET_BASE/$f"; removed=1; fi
  done
  if [[ "$removed" == 1 ]]; then
    echo "Removed opencode-tanzu from $TARGET_BASE"
  else
    echo "Nothing to remove in $TARGET_BASE"
  fi
  if [[ "$RUNTIME" == v2 ]]; then
    rm -f "$TARGET_BASE/index.js" "$TARGET_BASE/package.json"
    rmdir "$TARGET_BASE" 2>/dev/null || true
    echo "Credentials, configuration and session data were retained."
    exit 0
  fi
  cat <<'EOF'
Left in place (delete yourself if you want a full wipe):
  - your API key file:  ~/.local/share/opencode/opencode-tanzu/apikey
  - the persisted proxy URL: provider.tanzu.options.baseURL in
    ~/.config/opencode/opencode.json
EOF
  exit 0
fi

for f in "${FILES[@]}"; do
  [[ -f "$HERE/src/$f" ]] || { echo "missing $HERE/src/$f — run from a full checkout" >&2; exit 1; }
done

mkdir -p "$TARGET_BASE"
for f in "${FILES[@]}"; do
  cp "$HERE/src/$f" "$TARGET_BASE/$f"
done

echo "Installed opencode-tanzu ($RUNTIME) into $TARGET_BASE"
if [[ "$RUNTIME" == v2 ]]; then
  printf '%s\n' 'export { default } from "./opencode-tanzu-v2.js"' > "$TARGET_BASE/index.js"
  printf '%s\n' '{"name":"opencode-tanzu-v2","private":true,"type":"module","main":"./index.js"}' > "$TARGET_BASE/package.json"
  echo "Set TANZU_GENAI_BASE_URL and TANZU_GENAI_API_KEY_FILE (or TANZU_GENAI_API_KEY)."
  echo "Launch: $HERE/bin/opencode-tanzu-v2"
  echo "The launcher requires opencode2 on PATH, or OPENCODE_V2_BIN set to its executable."
  exit 0
fi
cat <<'EOF'

Next steps:
  1. Get your foundation's credentials from a CF service key:
       cf service-key <service-instance> <key-name>
  2. Log in (URL = the key's api_base with /openai/v1 appended):
       opencode providers login -p tanzu
  3. Check the roster:
       opencode models tanzu

To update: git pull && ./install.sh
To remove: ./install.sh --uninstall
EOF
