#!/bin/bash
# Run Bun on Vercel at the mise-pinned version.
#
# Vercel's build image ships Bun 1.3.x and offers no way to pin the build-time
# Bun release (`bunVersion` only selects the Functions runtime). The builds rely
# on `bun check`, which needs Bun 1.4+, so install the pinned release from npm
# (no unzip needed) and run the given command with it first on PATH, so nested
# `bun` calls in package scripts resolve to the same binary.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

BUN_VERSION="$(sed -n 's/^bun = "\(.*\)"$/\1/p' "$PROJECT_ROOT/mise.toml")"
if [ -z "$BUN_VERSION" ]; then
    echo "Could not read the Bun version from mise.toml" >&2
    exit 1
fi

# Outside the checkout so the install and build steps share it without it
# showing up as a workspace file.
BUN_PREFIX="${TMPDIR:-/tmp}/orkestrator-bun-$BUN_VERSION"
BUN_BIN_DIR="$BUN_PREFIX/node_modules/.bin"

if [ "$("$BUN_BIN_DIR/bun" --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
    npm install --prefix "$BUN_PREFIX" --no-save --no-audit --no-fund --loglevel=error "bun@$BUN_VERSION"
fi

export PATH="$BUN_BIN_DIR:$PATH"
exec bun "$@"
