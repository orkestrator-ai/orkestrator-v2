#!/bin/bash
# Download Bun binary for bundling with the app

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/binaries"

# Pin the bundled Bun to the same version as the container runtime
# (docker/Dockerfile `FROM oven/bun:<version>-debian`) so the host bridge and
# the in-container bridge run on an identical runtime. tests/unit/version-drift
# enforces this match; bump both together.
BUN_VERSION="1.3.14"

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
PLATFORM="darwin"

# Download URL
BUN_FILENAME="bun-${PLATFORM}-${BUN_ARCH}"
BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_FILENAME}.zip"

echo "Downloading Bun v${BUN_VERSION} for ${PLATFORM}-${BUN_ARCH}..."

# Create binaries directory if it doesn't exist
mkdir -p "$BINARIES_DIR"

# Download and extract
TEMP_DIR=$(mktemp -d)
curl -fsSL "$BUN_URL" -o "$TEMP_DIR/bun.zip"
unzip -q "$TEMP_DIR/bun.zip" -d "$TEMP_DIR"

# Copy the binary
cp "$TEMP_DIR/${BUN_FILENAME}/bun" "$BINARIES_DIR/bun"
chmod +x "$BINARIES_DIR/bun"

# Cleanup
rm -rf "$TEMP_DIR"

# Re-sign the binary with an ad-hoc signature.
# The official bun binary is signed by the bun team (Developer ID) with the
# hardened runtime flag. When it is embedded inside a Tauri app bundle that
# uses a *different* signing identity (ad-hoc or another Developer ID),
# macOS kills the process with SIGKILL (exit 137) because the team
# identifiers don't match. Stripping the original signature and applying a
# fresh ad-hoc signature resolves the mismatch.
if [[ "$PLATFORM" == "darwin" ]]; then
    echo "Re-signing bun binary with ad-hoc signature for macOS app bundling..."
    codesign --remove-signature "$BINARIES_DIR/bun" 2>/dev/null || true
    codesign --sign - --force "$BINARIES_DIR/bun"
fi

echo "Bun binary downloaded to $BINARIES_DIR/bun"

# Verify it works
"$BINARIES_DIR/bun" --version
