#!/usr/bin/env bash
# Publishes the artifact preview worker image by hand and records its
# registry digest in published-image.json (checked in), which packaged
# backends read: when the pin's context digest equals the digest of the
# context a backend ships, `transcript_artifact_prepare_worker` pulls exactly
# <image>@<digest> instead of building that context.
#
# The publish-preview-worker workflow does the same on every main push that
# changes the context and opens a pull request with the new pin; use this
# script only when that workflow cannot run.
#
# Usage (maintainer only; requires `docker login <registry>` beforehand):
#   docker/artifact-preview-worker/publish.sh <repository> [tag]
#   e.g. docker/artifact-preview-worker/publish.sh ghcr.io/orkestrator-ai/orkestrator-v2/artifact-preview-worker
#
# Steps: stage the context exactly like build.sh and compute its digest
# (context-digest.ts), build a multi-architecture image (linux/amd64 and
# linux/arm64, matching the pinned Playwright base index) labelled with that
# digest with buildx and push it (tag defaults to ctx-<digest hex>), read the
# pushed manifest-list digest back from the registry, then rewrite
# published-image.json. Commit that file.
# Set ORKESTRATOR_PREVIEW_WORKER_PLATFORMS to override the platform list.
# Nothing here runs automatically; no credentials are read or stored.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository="${1:?usage: publish.sh <repository> [tag]}"
platforms="${ORKESTRATOR_PREVIEW_WORKER_PLATFORMS:-linux/amd64,linux/arm64}"

if ! [[ "$repository" =~ ^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]{1,5})?(/[a-z0-9]+([._-][a-z0-9]+)*)+$ ]]; then
  echo "invalid repository: $repository" >&2
  exit 2
fi

context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT
bun "$here/stage-context.ts" "$context" >/dev/null
context_digest="$(bun "$here/context-digest.ts" "$context")"
case "$context_digest" in
  sha256:*) ;;
  *) echo "could not compute the context digest" >&2; exit 1 ;;
esac
tag="${2:-ctx-${context_digest#sha256:}}"
if ! [[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "invalid tag: $tag" >&2
  exit 2
fi
docker buildx build --pull=false --platform "$platforms" \
  --label orkestrator.artifact-preview-worker=1 \
  --label "orkestrator.artifact-preview-worker.context=$context_digest" \
  --tag "$repository:$tag" --push "$context"

digest="$(docker buildx imagetools inspect "$repository:$tag" --format '{{json .Manifest}}' \
  | bun -e 'const m = JSON.parse(await Bun.stdin.text()); process.stdout.write(m.digest ?? "")')"
case "$digest" in
  sha256:*) ;;
  *) echo "could not read the pushed digest" >&2; exit 1 ;;
esac

bun "$here/write-pin.ts" "$repository" "$tag" "$digest" "$context_digest" >/dev/null
echo "$repository@$digest"
