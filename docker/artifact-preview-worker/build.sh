#!/usr/bin/env bash
# Builds the artifact preview worker image and records its content-addressed id.
# Usage: docker/artifact-preview-worker/build.sh [image-tag]
#
# After the build, image-pin.json (git-ignored; host-local, because local image
# ids are not reproducible across hosts) maps the tag to the built image id.
# The backend then runs that exact id instead of the mutable tag, and falls back
# to the tag with a warning when the pin is missing or the id is gone. A
# published image is pinned instead by setting
# ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE=<name>@sha256:<registry digest> (see
# `docker buildx imagetools inspect <name>:<tag>` after pushing).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tag="${1:-orkestrator-artifact-preview-worker:1}"
context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT
bun "$here/stage-context.ts" "$context" >/dev/null
docker build --pull=false -t "$tag" "$context"
id="$(docker image inspect --format '{{.Id}}' "$tag")"
case "$id" in
  sha256:*) ;;
  *) echo "unexpected image id: $id" >&2; exit 1 ;;
esac
printf '{\n  "tag": "%s",\n  "id": "%s"\n}\n' "$tag" "$id" > "$here/image-pin.json"
echo "$tag $id"
