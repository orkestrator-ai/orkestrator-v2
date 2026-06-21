#!/usr/bin/env bash
# Sign the macOS app bundle properly (inside-out, no --deep).
#
# `codesign --deep` re-signs every nested binary with a single ad-hoc
# identity, stripping original developer signatures and hardened-runtime
# flags. macOS then kills those binaries with SIGKILL (exit 137).
#
# The correct approach: sign each Mach-O binary individually from the
# inside out, then seal the outer app bundle last.

set -euo pipefail

APP_PATH="${1:?Usage: codesign-app.sh <path/to/App.app>}"
IDENTITY="${CODESIGN_IDENTITY:--}"  # ad-hoc by default; set env to override

if [ ! -d "$APP_PATH" ]; then
  echo "Error: $APP_PATH does not exist" >&2
  exit 1
fi

echo "Signing $APP_PATH (identity: $IDENTITY)"

# Strip any existing signatures first to start clean.
# This avoids "sealed resource is missing or invalid" errors from a prior
# app signature conflicting with our re-signing.
echo "  Stripping existing signatures..."
codesign --remove-signature "$APP_PATH" 2>/dev/null || true

# Collect all Mach-O binaries and native modules inside the bundle.
BINARIES=()
while IFS= read -r -d '' f; do
  if file "$f" | grep -q "Mach-O"; then
    BINARIES+=("$f")
  fi
done < <(find "$APP_PATH/Contents" -type f \( -perm +111 -o -name "*.dylib" -o -name "*.node" \) -print0)

echo "Found ${#BINARIES[@]} Mach-O binaries to sign"

# Sign each binary individually with hardened runtime (inside-out).
for bin in "${BINARIES[@]+"${BINARIES[@]}"}"; do
  # Skip the main executable — it gets signed with the outer bundle.
  if [[ "$bin" == "$APP_PATH/Contents/MacOS/"* ]]; then
    continue
  fi
  echo "  Signing: ${bin#"$APP_PATH/"}"
  codesign --force --sign "$IDENTITY" --options runtime "$bin"
done

# Sign any embedded frameworks / bundles (none currently, but future-proof).
while IFS= read -r -d '' fw; do
  echo "  Signing framework: ${fw#"$APP_PATH/"}"
  codesign --force --sign "$IDENTITY" --options runtime "$fw"
done < <(find "$APP_PATH/Contents/Frameworks" -maxdepth 1 -name "*.framework" -print0 2>/dev/null || true)

# Sign the outer app bundle last (seals everything including all resources).
echo "  Signing app bundle"
codesign --force --sign "$IDENTITY" --options runtime "$APP_PATH"

echo "Verifying signature..."
if codesign --verify --deep --strict "$APP_PATH" 2>&1; then
  echo "Signature OK"
else
  echo "Verification failed — showing details:"
  codesign -vvvv "$APP_PATH" 2>&1 || true
  exit 1
fi
