# A locally built preview worker outlives an upgrade

Checked against `main` at `863b57821` (2026-10-27).

"Prepare isolated preview worker" (`transcript_artifact_prepare_worker`)
builds the worker image from the context the backend ships and records its
id in `<data dir>/artifact-preview-worker/image-pin.json`
(`preview-worker-prepare.ts`). At every later startup, `auto` isolation
inspects `orkestrator-artifact-preview-worker:1` and `resolveWorkerImage`
(`runtime.ts`) swaps the tag for the pinned id when that id is present.
Nothing compares the image with the context the running backend ships. After
an upgrade that changes the worker bundle, a renderer bundle, the Dockerfile
or the lockfile, container previews keep running the old worker until the
user prepares it again, and nothing prompts them to. Both sides speak
`PREVIEW_WORKER_PROTOCOL` 1, so nothing fails; the new worker's fixes and
bundles just never arrive.

## Current state

- Found on 2026-10-27 while binding the published image pin to its build
  context ([0053](0053-rich-transcripts.md)). The published route is now
  checked against the shipped context's digest at startup and at preparation
  (`publishedMatchesContext`, `preview-worker-context-digest.ts`); the local
  route is not.
- Found by reading the code. No upgrade was run to show it.

## Outstanding work

### Code

1. Record the context digest in the local pin, and label locally built
   images with `orkestrator.artifact-preview-worker.context` as published
   images are.
2. At startup, when the backend ships a context and the local pin's digest
   differs (or is missing), treat the container worker as not prepared:
   `auto` selects process isolation and capabilities report preparation as
   available, so the card offers "Prepare isolated preview worker" again. An
   explicit `container` setting and `ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE` keep
   their current behaviour.
3. Decide what a source checkout does: it has no shipped context, and staging
   one at startup costs a Bun build. Keep `build.sh`'s pin as it is, or stage
   lazily on the first container job.

### Qualification

- Upgrade a packaged install whose worker was prepared under the previous
  version and confirm previews fall back to process isolation with the
  prepare action offered, then run in the container again after preparing.

## Constraints and rationale

- Hashing the shipped context at startup costs one read of about 8 MiB; it
  is already done when a published pin is present.
- Do not rebuild automatically at startup: a build can take minutes and pulls
  the base image, so it stays an explicit user action.

## Open questions

- Should a stale image be removed (`docker image rm`) after a successful
  re-preparation, or left for Docker's own pruning?

## Related

- [0053-rich-transcripts.md](0053-rich-transcripts.md) (the published pin's
  context binding).
- [Preview worker](../../architecture/transcript-artifacts-runtime.md#preview-worker).
