#!/bin/sh
# Launcher for every claude-code-telegram-interface role (MCP server, hooks, slash commands).
#
# Resolution order:
#   1. CLAUDE_CODE_TELEGRAM_INTERFACE_DEV=1 + node   → the TypeScript sources, even if a binary is cached
#   2. cached binary in Plugin home   → exec it
#   3. node >= 23.6 + sources present → run the sources
#   4. download the release binary, verify, cache, exec
#   5. explain what to install and fail
#
# Node outranks downloading on purpose: the sources ship with the plugin and
# always match its version, so a machine that already has Node never needs a
# 90 MB download (nor a doomed request when no release exists yet). The binary
# is what makes the plugin work for people WITHOUT Node.
#
# stdout IS the MCP stdio channel: every diagnostic here must go to stderr.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPO=${CLAUDE_CODE_TELEGRAM_INTERFACE_REPO:-Esi-Abolfazl/claude-code-telegram-interface}
HOME_DIR=${CLAUDE_CODE_TELEGRAM_INTERFACE_HOME:-$HOME/.claude-code-telegram-interface}
ENTRY="$ROOT/src/main.ts"

# Node >= 23.6 runs .ts directly by stripping types.
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>23||(a===23&&b>=6)?0:1)' 2>/dev/null
}

if [ "${CLAUDE_CODE_TELEGRAM_INTERFACE_DEV:-}" = "1" ] && node_ok; then
  exec node "$ENTRY" "$@"
fi

# Cache key includes the plugin version so an update fetches its own binary
# instead of re-running the previous one. plugin.json is the single source of
# truth for the version (no jq dependency — one field, one grep).
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/.claude-plugin/plugin.json" 2>/dev/null | head -n 1)
[ -n "$VERSION" ] || VERSION=dev

case $(uname -s) in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) OS=unsupported ;;
esac
case $(uname -m) in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  *) ARCH=unsupported ;;
esac

ASSET="claude-code-telegram-interface-$OS-$ARCH"
BIN="$HOME_DIR/bin/$VERSION-$OS-$ARCH"

if [ -x "$BIN" ]; then
  exec "$BIN" "$@"
fi

if [ -f "$ENTRY" ] && node_ok; then
  exec node "$ENTRY" "$@"
fi

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}

if [ "$OS" != unsupported ] && [ "$ARCH" != unsupported ] && command -v curl >/dev/null 2>&1; then
  BASE="https://github.com/$REPO/releases/download/v$VERSION"
  TMP="$HOME_DIR/bin/.dl-$$"
  mkdir -p "$HOME_DIR/bin"
  if curl -fsSL "$BASE/$ASSET" -o "$TMP" 2>/dev/null &&
    curl -fsSL "$BASE/checksums.txt" -o "$TMP.sums" 2>/dev/null; then
    WANT=$(grep " $ASSET\$" "$TMP.sums" | cut -d' ' -f1 | head -n 1)
    GOT=$(sha256_of "$TMP")
    if [ -n "$WANT" ] && [ "$WANT" = "$GOT" ]; then
      chmod +x "$TMP"
      mv -f "$TMP" "$BIN"
      rm -f "$TMP.sums"
      exec "$BIN" "$@"
    fi
    echo "claude-code-telegram-interface: checksum mismatch for $ASSET — refusing to run it." >&2
  fi
  rm -f "$TMP" "$TMP.sums"
  echo "claude-code-telegram-interface: could not fetch $ASSET from $BASE; falling back to node." >&2
fi

if node_ok; then
  exec node "$ENTRY" "$@"
fi

cat >&2 <<EOF
claude-code-telegram-interface could not start.

No release binary for $OS-$ARCH could be downloaded, and no Node.js >= 23.6 is
installed to run from source. Either:
  - check your network / the release page: https://github.com/$REPO/releases
  - or install Node.js 23.6+ (https://nodejs.org) and restart Claude Code.
EOF
exit 1
