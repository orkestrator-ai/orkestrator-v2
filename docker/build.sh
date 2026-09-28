#!/bin/bash
# Build the Orkestrator environment image from the repository root.
#
#   docker/build.sh [tag]        (default: orkestrator-v2:latest)
#
# The Dockerfile copies workspace manifests, bridges and patches from the
# repository root, so that is the build context. The contract arguments stamp
# the capability label the image build then verifies against the installed
# scripts, and the source revision it records in the manifest.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:-orkestrator-v2:latest}"
cd "$REPO_ROOT"

# Word splitting is intended: the helper prints `--build-arg NAME=value` pairs.
# shellcheck disable=SC2046
docker build $(bun scripts/docker-image-build-args.ts) \
    --tag "$TAG" \
    --file docker/Dockerfile \
    .

echo ""
echo "Built $TAG"
echo "Smoke-test it with: bash docker/tests/final-image-smoke.sh $TAG"
