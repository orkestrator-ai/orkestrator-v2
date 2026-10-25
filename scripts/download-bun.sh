#!/bin/bash
# Download Bun binary for bundling with the app

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/binaries"

# Mirror the mise-managed Bun version in the packaged desktop runtime and the
# container base (docker/Dockerfile `FROM oven/bun:<version>-debian`) so every
# bridge runs on an identical release. tests/unit/version-drift enforces all
# three pins.
BUN_VERSION="1.4.4"
BUN_DARWIN_AARCH64_SHA="c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510"
BUN_DARWIN_X64_SHA="50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e"
BUN_LINUX_AARCH64_SHA="baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e"
BUN_LINUX_X64_SHA="bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c"

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)
        BUN_ARCH="x64"
        ;;
    arm64|aarch64)
        BUN_ARCH="aarch64"
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

# Platform
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
BUN_FILENAME="bun-${PLATFORM}-${BUN_ARCH}"
BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_FILENAME}.zip"
case "${PLATFORM}-${BUN_ARCH}" in
    darwin-aarch64) BUN_SHA="$BUN_DARWIN_AARCH64_SHA" ;;
    darwin-x64) BUN_SHA="$BUN_DARWIN_X64_SHA" ;;
    linux-aarch64) BUN_SHA="$BUN_LINUX_AARCH64_SHA" ;;
    linux-x64) BUN_SHA="$BUN_LINUX_X64_SHA" ;;
    *) echo "Unsupported Bun target: ${PLATFORM}-${BUN_ARCH}" >&2; exit 1 ;;
esac

echo "Downloading Bun v${BUN_VERSION} for ${PLATFORM}-${BUN_ARCH}..."

# Create binaries directory if it doesn't exist
mkdir -p "$BINARIES_DIR"

# Download and extract
TEMP_DIR=$(mktemp -d)
curl -fsSL "$BUN_URL" -o "$TEMP_DIR/bun.zip"
printf '%s  %s\n' "$BUN_SHA" "$TEMP_DIR/bun.zip" | shasum -a 256 -c -
unzip -q "$TEMP_DIR/bun.zip" -d "$TEMP_DIR"

# Copy the binary
cp "$TEMP_DIR/${BUN_FILENAME}/bun" "$BINARIES_DIR/bun"
chmod +x "$BINARIES_DIR/bun"

# Cleanup
rm -rf "$TEMP_DIR"

# Re-sign the binary with an ad-hoc signature.
# The official bun binary is signed by the bun team (Developer ID) with the
# hardened runtime flag. When it is embedded inside an Electron app bundle that
# uses a *different* signing identity (ad-hoc or another Developer ID),
# macOS kills the process with SIGKILL (exit 137) because the team
# identifiers don't match. Stripping the original signature and applying a
# fresh ad-hoc signature resolves the mismatch.
if [[ "$PLATFORM" == "darwin" ]]; then
    echo "Re-signing bun binary with ad-hoc signature for macOS app bundling..."
    codesign --remove-signature "$BINARIES_DIR/bun" 2>/dev/null || true
    codesign --sign - --force "$BINARIES_DIR/bun"
    codesign --verify --verbose "$BINARIES_DIR/bun"
fi

echo "Bun binary downloaded to $BINARIES_DIR/bun"

# Verify the downloaded artifact runs and is exactly the requested release.
DOWNLOADED_BUN_VERSION=$("$BINARIES_DIR/bun" --version)
if [[ "$DOWNLOADED_BUN_VERSION" != "$BUN_VERSION" ]]; then
    echo "Downloaded Bun version $DOWNLOADED_BUN_VERSION does not match expected $BUN_VERSION" >&2
    exit 1
fi
echo "$DOWNLOADED_BUN_VERSION"
