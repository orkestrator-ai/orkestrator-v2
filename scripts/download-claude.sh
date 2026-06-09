#!/bin/bash
# Download Claude Code binary for bundling with the app.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/binaries"

# Claude Code version to bundle. Keep in sync with docker/Dockerfile.
CLAUDE_VERSION="2.1.170"

ARCH=$(uname -m)
case "$ARCH" in
    x86_64)
        CLAUDE_ARCH="x64"
        ;;
    arm64|aarch64)
        CLAUDE_ARCH="arm64"
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

OS=$(uname -s)
case "$OS" in
    Darwin)
        PLATFORM="darwin"
        ;;
    Linux)
        PLATFORM="linux"
        ;;
    *)
        echo "Unsupported platform: $OS"
        exit 1
        ;;
esac

PACKAGE_NAME="claude-code-${PLATFORM}-${CLAUDE_ARCH}"
CLAUDE_URL="https://registry.npmjs.org/@anthropic-ai/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${CLAUDE_VERSION}.tgz"

echo "Downloading Claude Code v${CLAUDE_VERSION} for ${PLATFORM}-${CLAUDE_ARCH}..."

mkdir -p "$BINARIES_DIR"

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
curl -fsSL "$CLAUDE_URL" -o "$TEMP_DIR/claude.tgz"
tar -xzf "$TEMP_DIR/claude.tgz" -C "$TEMP_DIR"

cp "$TEMP_DIR/package/claude" "$BINARIES_DIR/claude"
chmod +x "$BINARIES_DIR/claude"

if [[ "$PLATFORM" == "darwin" ]]; then
    echo "Re-signing claude binary with ad-hoc signature for macOS app bundling..."
    codesign --remove-signature "$BINARIES_DIR/claude" 2>/dev/null || true
    codesign --sign - --force "$BINARIES_DIR/claude"
fi

echo "Claude Code binary downloaded to $BINARIES_DIR/claude"

"$BINARIES_DIR/claude" --version
