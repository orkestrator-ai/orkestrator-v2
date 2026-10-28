# A locally built preview worker outlives an upgrade

Checked against `main` at `863b57821` (2026-10-27). Code items done on
2026-10-28 against `main` at `6a6009a09`. Packaged backend upgrade qualification
passed on 2026-10-28 using a disposable Docker daemon (see qualification).

"Prepare isolated preview worker" (`transcript_artifact_prepare_worker`)
builds the worker image from the context the backend ships and records its
id in `<data dir>/artifact-preview-worker/image-pin.json`
(`preview-worker-prepare.ts`). At every later startup, `auto` isolation
inspected `orkestrator-artifact-preview-worker:1` and `resolveWorkerImage`
(`runtime.ts`) swapped the tag for the pinned id when that id was present.
Nothing compared the image with the context the running backend ships. After
an upgrade that changes the worker bundle, a renderer bundle, the Dockerfile
or the lockfile, container previews kept running the old worker until the
user prepared it again, and nothing prompted them to. Both sides speak
`PREVIEW_WORKER_PROTOCOL` 1, so nothing failed; the new worker's fixes and
bundles just never arrived.

## Current state

- Found on 2026-10-27 while binding the published image pin to its build
  context ([0053](0053-rich-transcripts.md)). The published route was already
  checked against the shipped context's digest at startup and at preparation
  (`publishedMatchesContext`, `preview-worker-context-digest.ts`).
- 2026-10-28: the local route is checked too.
  - Preparation hashes the context once, labels the built image with
    `orkestrator.artifact-preview-worker.context=<digest>`, and records
    `contextDigest` in the data-directory pin. `build.sh` does the same for a
    source checkout's `image-pin.json`.
  - At startup a packaged backend (one that ships
    `artifact-runtime/worker-context/`) running `auto`, with no
    `ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE` and no published image selected,
    reads the context label of the image it would run
    (`localWorkerContext` in `runtime.ts`). A missing or different
    label makes the worker outdated: isolation falls back to `process`, a
    warning is logged, and `capabilities().workerPreparation` reports
    `outdated: true` with preparation available. The card and draft
    inspector then offer "Prepare isolated preview worker" and say the worker
    was prepared by an earlier version.
  - Preparing again switches to `container` without a restart, and the next
    start uses the new image directly.
  - Startup removes owner-scoped orphan containers before constructing the
    runner, including when an outdated image selects process isolation.
  - An explicit `container` setting keeps running the outdated image, with a
    warning and the same flag.
  - The shipped context is hashed at most once per start, shared with the
    published-image check.
- Tests: `runtime-prepare.test.ts` ("a locally prepared worker after an
  upgrade") covers another context, a pre-label image, an explicit
  `container` setting, a missing image, an explicit image, a source checkout
  and an unhashable context, all against a fake Docker CLI. `ArtifactPdf.test.tsx`
  covers the card's wording. Without the `runtime.ts` change, three of the
  new backend cases fail.
- Review follow-up tests use distinct old/rebuilt image ids and check the
  preparation result, persisted pin, runner configuration and restart. They
  also cover replacing an outdated local worker with a matching published
  pull and clearing `outdated` across restart. A shell contract test executes
  `build.sh` and the real digest CLI against fake staging/Docker boundaries,
  checking its context label, pin metadata and temporary-context cleanup.

## Outstanding work

### Code

1. ~~Record the context digest in the local pin, and label locally built
   images with `orkestrator.artifact-preview-worker.context` as published
   images are.~~ Done 2026-10-28 (also in `build.sh`).
2. ~~At startup, when the backend ships a context and the local pin's digest
   differs (or is missing), treat the container worker as not prepared.~~
   Done 2026-10-28. The image's label is the check (see decisions); `auto`
   selects process isolation and capabilities report `outdated: true` with
   preparation available. An explicit `container` setting and
   `ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE` keep their behaviour.
3. ~~Decide what a source checkout does.~~ Decided 2026-10-28: keep trusting
   its pin, unchecked (see decisions).

### Qualification

- Reproducible command (after the normal backend build has supplied release
  assets):

  ```bash
  mise run test:logged -- --name preview-upgrade-live -- bun scripts/qualify-preview-worker-upgrade.ts
  ```

  This bundles the current backend into a temporary package with shipped
  `artifact-runtime/worker-context`, launches its real gateway outside the
  checkout, and uses a throwaway HOME/data directory, ephemeral ports and a
  private Docker tag. It seeds a real local worker using the previous
  version's unlabelled build invocation and pin format. The first upgrade
  must prompt even if the worker bytes did not change. A Docker wrapper
  redirects only the default tag to the private tag; Docker inspection,
  builds, owner recovery and worker execution remain real. Cleanup stops
  only the backend/container it created and removes its private tag.
- To reproduce with a disposable daemon, as in the successful run:

  ```bash
  qual_daemon_id=$(docker run --detach --rm --privileged --env DOCKER_TLS_CERTDIR= --publish 127.0.0.1::2375 docker:29.9-dind-rootless)
  trap 'docker container stop "$qual_daemon_id" >/dev/null' EXIT
  qual_daemon_host="tcp://$(docker port "$qual_daemon_id" 2375/tcp)"
  for attempt in {1..100}; do
    docker --host "$qual_daemon_host" version >/dev/null 2>&1 && break
    sleep 0.2
  done
  docker --host "$qual_daemon_host" version >/dev/null
  DOCKER_HOST="$qual_daemon_host" mise run test:logged -- --name preview-upgrade-live -- bun scripts/qualify-preview-worker-upgrade.ts
  ```

  The daemon has its own image store and no host Docker socket mount. Its
  anonymous storage is removed when the recorded container is stopped.
- 2026-10-28 run: startup selected process isolation, capabilities exposed
  `outdated: true` with preparation available, and the owned orphan was
  removed. Preparing through the gateway built a different image id,
  persisted its context digest, and applied the matching image label. A
  fresh packaged backend reused that pin with container isolation and no
  outdated flag. Recorded Docker launch vectors used the new id before and
  after restart. Both real Mermaid requests rendered successfully in the
  disposable daemon, before and after restart. The logged harness passed
  in 180.4 seconds, and its parent shell stopped the daemon.
  `ArtifactPdf.test.tsx` separately verifies the visible preparation wording.
- The initial attempt against the host daemon failed with
  `renderer_unavailable: The preview worker stopped unexpectedly`. Captured
  Docker stderr shows `runc` receiving `SIGSEGV` in
  `cyphar.com/go-pathrs/internal/libpathrs._Cfunc_pathrs_reopen`, then
  `OCI runtime start failed: container process is already dead`. No core
  entry or OOM-kill evidence was available. Its underlying cause is not
  established; no host runtime settings were changed. The same harness then
  passed with the isolated daemon. Host-failure evidence:
  `/tmp/orkestrator-test-run.FGuAIJ`. The desktop installer itself was not
  exercised; qualification uses the packaged backend bundle and release
  assets outside the checkout, through the real gateway.

### Review validation

- Passed: the runtime, preparation and scratch owner tests, the build-script
  contract test, `ArtifactPdf.test.tsx`, backend and repository-script type
  checks, lint of the changed source files, and `mise run format:check`.
- The DOM diagnostic guard completed on rerun (27.1 s):
  `ArtifactPdf.test.tsx` is no longer an offender. Seven unchanged files from
  the preparation run still fail it. Evidence:
  `/tmp/orkestrator-test-run.aKutwS`.
- Repeated the recorded `mise run test:browser` with private fixture ports
  (`ORKESTRATOR_E2E_PORT=18385`, `ORKESTRATOR_PUBLIC_E2E_PORT=18386`). The
  ownership check passed, but the run had 148 failures, largely navigation
  timeouts; Vite also logged `source.listen is not a function` from the
  untouched native event adapter. It was interrupted after 20.5 minutes:
  112 passed, 59 skipped, 5 interrupted and 680 not run. Evidence:
  `/tmp/orkestrator-test-run.aIRzK9`. This is not a passing browser run.
- Repeated the recorded `mise run test:full`; its bridges group was marked
  incomplete by the no-output watchdog, and its root group finished with
  3,570 passes and five failures (including a DOM guard timeout). Aggregate
  execution then reached the logged runner's 30-minute deadline with the
  workspace group unfinished; 541 seconds had been spent in the shared-host
  queue. The Codex protocol lockfile check passed. Evidence is retained in
  `/tmp/orkestrator-test-run.wOg95K` and its child group logs in
  `/tmp/orkestrator-test-run.saoqcn`. The aggregate is not green.

## Constraints and rationale

- Hashing the shipped context at startup costs one read of about 8 MiB. It
  happens only when the backend would otherwise run a local or published
  worker, and at most once per start.
- Do not rebuild automatically at startup: a build can take minutes and pulls
  the base image, so it stays an explicit user action.

## Open questions

None left. Whether to remove a stale image is decided below.

## Assumptions and decisions

### What decides that a local worker is current

- **Options.** (a) The `contextDigest` recorded in the data-directory pin.
  (b) The `orkestrator.artifact-preview-worker.context` label on the image
  that would run (the pinned id, or the tag when no pin applies). (c) Both,
  requiring them to agree.
- **Choice: (b)**, with the digest still recorded in the pin.
- **Why.** The label is part of the content-addressed image, so it cannot
  drift from the id a pin names, and it also covers an unpinned tag (a pin
  that was deleted, or an image built by hand). The pin's digest alone would
  trust any image the tag happened to name. Checking both adds a second
  source of truth that, for an id-pinned image, always agrees with the label.
- **Pros.** One Docker call (bounded to 5 s), the same check the published
  route makes on pulled images, and no new file format to trust.
- **Cons.** One extra `docker image inspect` at startup when the tag is
  present. The pin's `contextDigest` is only informational (diagnostics,
  parity with `published-image.json`).

### What happens on a mismatch

- **Options.** (a) Fall back to process isolation and offer preparation again
  with wording that says why. (b) Keep running the old worker and only log a
  warning. (c) Rebuild automatically at startup.
- **Choice: (a)** under `auto`. An explicit `container` setting keeps
  running the outdated image, with a warning and `outdated: true`.
- **Why.** (b) is the silent failure this todo is about. (c) is ruled out by
  the constraint above. (a) uses the existing prepare action and its
  no-restart switch. Under an explicit `container` setting the operator has
  asked for the container boundary; dropping to process would turn
  interactive previews off without being asked.
- **Pros.** The user sees the cause and the one action that fixes it. No
  build happens without being asked.
- **Cons.** After the upgrade, until the user prepares again, interactive
  previews are off (as on a fresh install). Images prepared before this
  change carry no label, so the first upgrade that includes it prompts once
  even if the worker context did not change.

### How it is shown

- **Options.** (a) A new `outdated` flag on `ArtifactWorkerPreparationStatus`
  and card wording that uses it. (b) Reuse `reason` while `idle`. (c) Log
  only.
- **Choice: (a)**, plus a startup warning in the log.
- **Why.** `reason` means "why preparation is unavailable or failed", and
  here preparation is available. A log line alone is not visible to the
  user. The flag is optional, so older clients ignore it and keep the
  generic wording.
- **Pros.** The card says what happened; the protocol stays additive.
- **Cons.** One more optional protocol field.

### A source checkout

- **Options.** (a) Trust the `build.sh` or data-directory pin as before. (b)
  Stage the context at every startup to hash it. (c) Stage lazily on the
  first container job.
- **Choice: (a).**
- **Why.** A source checkout ships no context, and staging one costs a Bun
  build at every backend start, test profiles included. (c) would change
  isolation in the middle of a running backend, after `auto` has chosen.
  Developers already rebuild with `build.sh` after changing the worker, and
  `build.sh` now records the digest and labels the image, so the same check
  applies if that image is later used by a packaged backend.
- **Pros.** No startup cost in development; the behaviour there is
  unchanged.
- **Cons.** A dev profile that ran "Prepare" keeps that image after worker
  changes until it is prepared again or rebuilt.

### A shipped context that cannot be hashed

- **Options.** (a) Treat the local worker as outdated. (b) Use it as before.
  (c) Fail preparation.
- **Choice: (b)**, and preparation still builds, without the context label
  and without `contextDigest` in the pin.
- **Why.** Hashing fails only for a context with entries staging never
  writes (symlinks, sockets), so the install is already damaged. (a) would
  turn container previews off, and offer a preparation that cannot produce a
  labelled image, on every start. The published route stays conservative
  (an unhashable context never matches a published pin), because there the
  image comes from a registry rather than this host.
- **Pros.** No new failure mode for a damaged install.
- **Cons.** Such an install is not protected from a stale worker.

### Removing the stale image after re-preparation (the open question)

- **Options.** (a) Leave it for Docker's own pruning. (b) Run
  `docker image rm <old id>` (without `--force`) after a successful build.
- **Choice: (a).**
- **Why.** Re-preparation moves the tag, so the old image becomes dangling
  and `docker image prune` removes it. Its unique layers are the worker
  bundle, renderer bundles and npm install; the Playwright base layers are
  shared with the new image. Removing it would add a deletion to a flow that
  so far only builds, and could race with the old runner's queued jobs while
  it drains (up to 60 s).
- **Pros.** No deletion, no race.
- **Cons.** The old image's unique layers stay on disk until pruned.

## Related

- [0053-rich-transcripts.md](0053-rich-transcripts.md) (the published pin's
  context binding).
- [Preview worker](../../architecture/transcript-artifacts-runtime.md#preview-worker).
