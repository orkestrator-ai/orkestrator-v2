#!/usr/bin/env bash
# Publishes the artifact preview worker image and records its registry digest
# in published-image.json (checked in), which packaged backends read: when a
# digest is recorded, `transcript_artifact_prepare_worker` pulls exactly
# <image>@<digest> instead of building the shipped context, and a present
# image is preferred over the local tag.
#
# Usage (maintainer only; requires `docker login <registry>` beforehand):
#   docker/artifact-preview-worker/publish.sh <repository> [tag]
#   e.g. docker/artifact-preview-worker/publish.sh ghcr.io/orkestrator-ai/artifact-preview-worker 1
#
# Steps: stage the context exactly like build.sh, build a multi-architecture
# image (linux/amd64 and linux/arm64, matching the pinned Playwright base
# index) with buildx and push it, read the pushed manifest-list digest back
# from the registry, then rewrite published-image.json. Commit that file.
# Set ORKESTRATOR_PREVIEW_WORKER_PLATFORMS to override the platform list.
# Nothing here runs automatically; no credentials are read or stored.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository="${1:?usage: publish.sh <repository> [tag]}"
tag="${2:-1}"
platforms="${ORKESTRATOR_PREVIEW_WORKER_PLATFORMS:-linux/amd64,linux/arm64}"

if ! [[ "$repository" =~ ^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]{1,5})?(/[a-z0-9]+([._-][a-z0-9]+)*)+$ ]]; then
  echo "invalid repository: $repository" >&2
  exit 2
fi
if ! [[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "invalid tag: $tag" >&2
  exit 2
fi

context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT
bun "$here/stage-context.ts" "$context" >/dev/null
docker buildx build --pull=false --platform "$platforms" \
  --label orkestrator.artifact-preview-worker=1 \
  --tag "$repository:$tag" --push "$context"

digest="$(docker buildx imagetools inspect "$repository:$tag" --format '{{json .Manifest}}' \
  | bun -e 'const m = JSON.parse(await Bun.stdin.text()); process.stdout.write(m.digest ?? "")')"
case "$digest" in
  sha256:*) ;;
  *) echo "could not read the pushed digest" >&2; exit 1 ;;
esac

published_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
REPOSITORY="$repository" TAG="$tag" DIGEST="$digest" PUBLISHED_AT="$published_at" \
  bun -e '
    const file = process.argv[1];
    const current = JSON.parse(await Bun.file(file).text());
    const next = {
      $comment: current.$comment,
      image: process.env.REPOSITORY,
      tag: process.env.TAG,
      digest: process.env.DIGEST,
      publishedAt: process.env.PUBLISHED_AT,
    };
    await Bun.write(file, JSON.stringify(next, null, 2) + "\n");
  ' "$here/published-image.json"
echo "$repository@$digest"
