#!/bin/bash
# Download Codex CLI binary for bundling with the app.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/binaries"

# Codex CLI version to bundle — must match config/codex-version.json.
CODEX_VERSION="0.147.0"

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)
        CODEX_ARCH="x86_64"
        ;;
    arm64|aarch64)
        CODEX_ARCH="aarch64"
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

# Detect platform
OS=$(uname -s)
case "$OS" in
    Darwin)
        CODEX_TARGET="${CODEX_ARCH}-apple-darwin"
        ;;
    Linux)
        # Codex releases only publish Linux binaries under the musl triple.
        CODEX_TARGET="${CODEX_ARCH}-unknown-linux-musl"
        ;;
    *)
        echo "Unsupported platform: $OS"
        exit 1
        ;;
esac

CODEX_FILENAME="codex-${CODEX_TARGET}"
CODEX_URL="https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/${CODEX_FILENAME}.tar.gz"

# Codex spawns this helper from its own directory for every code-mode turn.
CODEX_HOST_FILENAME="codex-code-mode-host-${CODEX_TARGET}"
CODEX_HOST_URL="https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/${CODEX_HOST_FILENAME}.tar.gz"

echo "Downloading Codex v${CODEX_VERSION} for ${CODEX_TARGET}..."

mkdir -p "$BINARIES_DIR"

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
curl -fsSL "$CODEX_URL" -o "$TEMP_DIR/codex.tar.gz"
tar -xzf "$TEMP_DIR/codex.tar.gz" -C "$TEMP_DIR"

# Archive contains a single file named `codex-{target}` — rename to `codex`.
cp "$TEMP_DIR/${CODEX_FILENAME}" "$BINARIES_DIR/codex"
chmod +x "$BINARIES_DIR/codex"

echo "Downloading the Codex code-mode host for ${CODEX_TARGET}..."
curl -fsSL "$CODEX_HOST_URL" -o "$TEMP_DIR/codex-code-mode-host.tar.gz"
tar -xzf "$TEMP_DIR/codex-code-mode-host.tar.gz" -C "$TEMP_DIR"
cp "$TEMP_DIR/${CODEX_HOST_FILENAME}" "$BINARIES_DIR/codex-code-mode-host"
chmod +x "$BINARIES_DIR/codex-code-mode-host"

# Re-sign with an ad-hoc signature so the embedded binary isn't killed when
# the enclosing Electron app uses a different signing identity. Same rationale
# as bun/opencode.
if [[ "$OS" == "Darwin" ]]; then
    echo "Re-signing codex binaries with ad-hoc signatures for macOS app bundling..."
    for BINARY in codex codex-code-mode-host; do
        codesign --remove-signature "$BINARIES_DIR/$BINARY" 2>/dev/null || true
        codesign --sign - --force "$BINARIES_DIR/$BINARY"
    done
fi

echo "Codex binary downloaded to $BINARIES_DIR/codex"
echo "Codex code-mode host downloaded to $BINARIES_DIR/codex-code-mode-host"

# Verify it works. The host is a helper process with its own protocol rather
# than a CLI, so only its presence next to `codex` can be checked here.
"$BINARIES_DIR/codex" --version
test -x "$BINARIES_DIR/codex-code-mode-host"
