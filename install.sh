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

MODE="install"
TARGET_BASE="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
for arg in "$@"; do
  case "$arg" in
    --uninstall) MODE="uninstall" ;;
    --project)   TARGET_BASE="$PWD/.opencode/plugins" ;;
    -h|--help)   sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

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

echo "Installed opencode-tanzu into $TARGET_BASE"
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
