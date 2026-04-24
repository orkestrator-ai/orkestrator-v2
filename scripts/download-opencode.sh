#!/bin/bash
# Download OpenCode binary for bundling with the app

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/binaries"

# OpenCode version to download — should match @opencode-ai/sdk version in package.json
OPENCODE_VERSION="1.14.22"

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)
        OPENCODE_ARCH="x64"
        ;;
    arm64|aarch64)
        OPENCODE_ARCH="arm64"
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

# Download URL
OPENCODE_FILENAME="opencode-${PLATFORM}-${OPENCODE_ARCH}"
OPENCODE_URL="https://github.com/sst/opencode/releases/download/v${OPENCODE_VERSION}/${OPENCODE_FILENAME}.zip"

echo "Downloading OpenCode v${OPENCODE_VERSION} for ${PLATFORM}-${OPENCODE_ARCH}..."

# Create binaries directory if it doesn't exist
mkdir -p "$BINARIES_DIR"

# Download and extract
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
curl -fsSL "$OPENCODE_URL" -o "$TEMP_DIR/opencode.zip"
unzip -q "$TEMP_DIR/opencode.zip" -d "$TEMP_DIR"

# Copy only the binary (skip .map files)
cp "$TEMP_DIR/opencode" "$BINARIES_DIR/opencode"
chmod +x "$BINARIES_DIR/opencode"

# Re-sign the binary with an ad-hoc signature.
# Same reasoning as bun: when embedded inside a Tauri app bundle that uses a
# different signing identity, macOS kills the process with SIGKILL (exit 137)
# because the team identifiers don't match.
if [[ "$PLATFORM" == "darwin" ]]; then
    echo "Re-signing opencode binary with ad-hoc signature for macOS app bundling..."
    codesign --remove-signature "$BINARIES_DIR/opencode" 2>/dev/null || true
    codesign --sign - --force "$BINARIES_DIR/opencode"
fi

echo "OpenCode binary downloaded to $BINARIES_DIR/opencode"

# Verify it works
"$BINARIES_DIR/opencode" --version
