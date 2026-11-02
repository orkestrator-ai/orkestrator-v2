# Remove the preview worker's published-image pull route

## Task analysis

Analysed 2026-11-02 against `main` at `16b3f9e8`.

### Tasks

1. **Remove the pull route from preparation and startup**: `transcript_artifact_prepare_worker` and runtime startup stop reading `published-image.json` and only ever build the shipped context. Status: open.
2. **Decide the `method` field of the preparation status**: what happens to `"pull"` in `ArtifactWorkerPreparationStatus.method`. Status: open (depends on 1).
3. **Remove the pin file and its tooling**: `published-image.json`, `write-pin.ts`, `publish.sh`, the backend build's pin copy and notice, and their tests. Status: open (depends on 1).
4. **Update the docs**: the runtime guide, the release guide and 0053's remaining pin-related verification item. Status: open (depends on 1 and 3).
5. **Remove the leftovers on GitHub**: the `preview-worker-pin/cfbafc5d238e4eb3232bf` branch and, if nothing else uses it, the `artifact-preview-worker` GHCR package. Status: open (needs the user's approval; outward-facing).

### 1. Remove the pull route from preparation and startup

**Problem.** Preparing the container preview worker has two routes: pull a published image named in `published-image.json`, or build the context the backend ships. The pull route has never run (the pin has held `null` since #1103), the workflow that would have filled it was removed on 2026-11-02, and the code for it is the most complex part of preparation.

**Context.** The worker image is `mcr.microsoft.com/playwright:<version>` plus an `npm ci` of `playwright-core` and a few copied bundles (`docker/artifact-preview-worker/Dockerfile`). Both routes download the large Playwright base image, so a pull saves only the `npm ci` and the copies, once per install per worker change. Pulling also trusts a registry image where building trusts only the bytes the install shipped.

**Investigation.** The pull route lives in `apps/backend/src/core/transcript-artifacts/preview-worker-prepare.ts`: `PublishedWorkerImage` and `readPublishedWorkerImage` (`:47`, `:87`), `publishedMatchesContext` (`:210`), `PublishedSkipReason` (`:171`) and the pull branch with its label check (`:277`-`:304`). `runtime.ts` reads the pin at startup (`:420`), prefers a locally present published image when it matches the shipped context (the block after `:440`), and logs `publishedSkipped` reasons (`:716`). `resolvePublishedPinFile` looks in `artifact-runtime/`, beside the backend and in the repository checkout (`preview-worker-prepare.ts:80`-`:82`). The context digest (`preview-worker-context-digest.ts`) and the `orkestrator.artifact-preview-worker.context` label are **not** pull-only: locally built images carry the label, and startup compares it with the shipped context to report an outdated worker. They must stay.

**Decisions.**

- **How much of preparation to change?**
  - **Delete the pull branch, the published-image startup preference and the skip reasons; keep the build route, the host-local `image-pin.json`, the context digest and the label check (recommended).**
    - Pros: one route left, the one every install already uses; the outdated-worker detection keeps working.
    - Cons: touches `runtime.ts` startup selection, which `runtime-prepare.test.ts` covers in detail, so those tests need careful pruning rather than deletion.
  - **Leave the code and only delete the pin file, so the route is unreachable.**
    - Pros: smallest change.
    - Cons: keeps dead, security-relevant code (a registry pull) that readers must still reason about.

### 2. Decide the `method` field of the preparation status

**Problem.** `ArtifactWorkerPreparationStatus.method` in `packages/protocol/src/transcript-artifact-commands.ts:78` is `"build" | "pull" | null`. After task 1 the backend never reports `"pull"`.

**Context.** `packages/protocol` is shared with renderers, and a remote client may run a different version from its backend ([version compatibility](../../architecture/version-compatibility.md)).

**Investigation.** No renderer code branches on `method === "pull"` (searched `apps/web/src`); the field is reported for display and tests.

**Decisions.**

- **Narrow the type or keep `"pull"`?**
  - **Keep `"pull"` in the union with a comment that current backends never send it (recommended).**
    - Pros: no compatibility risk with older backends that could still report it; no renderer change.
    - Cons: one dead value in the contract until the support window passes.
  - **Narrow to `"build" | null` now.**
    - Pros: the type says exactly what is sent.
    - Cons: a newer renderer talking to an older backend could receive a value its type does not allow.

### 3. Remove the pin file and its tooling

**Problem.** Once nothing reads the pin, the file, its writer, the manual publish script and the build step that ships it are dead weight, and the build prints a "no published image" notice on every run.

**Context.** `apps/backend/scripts/build.ts:122`-`:141` copies `published-image.json` into `dist/artifact-runtime/` and prints `Preview worker: no published image for build context …`. `docker/artifact-preview-worker/write-pin.ts` writes the pin; `publish.sh` builds, pushes and calls it. `turbo.json`'s `@orkestrator/backend#build` inputs include `docker/artifact-preview-worker/**`, which must stay because the build stages the worker context from there.

**Investigation.** Tests that exist only for the pin: `preview-worker-pin-writer.test.ts`, and the published-image cases in `runtime-prepare.test.ts` (around `:138`, `:334`, `:450`, `:538`). `preview-worker-context-digest.test.ts` asserts that `publish.sh` labels images with the context label; with `publish.sh` gone that assertion goes, and `build.sh`'s labelling is already covered by `preview-worker-build-script.test.ts`.

**Decisions.**

- **Keep `publish.sh` as an escape hatch?**
  - **Delete it with `write-pin.ts` (recommended).**
    - Pros: no tooling for a route that no longer exists; nothing to keep in step with the Dockerfile.
    - Cons: re-adding publishing later means writing it again (this file and git history describe how).
  - **Keep it, unused.**
    - Pros: nothing to rewrite if publishing comes back.
    - Cons: a script that writes a file nothing reads, and a supply-chain path left documented.

### 4. Update the docs

**Problem.** The docs still describe the pin as a working, if unused, route.

**Context.** `docs/architecture/transcript-artifacts-runtime.md` ("Preparing the worker on demand" and "Publishing"), `docs/development/releasing.md` (the preview worker paragraph), and 0053's remaining Needs verification item about the context digest matching across hosts, which only mattered for pins.

**Investigation.** On 2026-11-02 the Publishing paragraph and the release guide were rewritten to say no workflow publishes and installs build locally; they point here. The "Preparing the worker on demand" paragraph still describes both routes.

**Decisions.**

- **Where should the remaining description live?**
  - **Rewrite "Preparing the worker on demand" as a single build route, delete the Publishing paragraph and the release-guide paragraph, and remove 0053's digest-stability item (recommended).**
    - Pros: the docs match the code; nothing tells a releaser about a pin.
    - Cons: none beyond the edit.
  - **Keep a short historical note about the removed route.**
    - Pros: explains old logs that mention `context_mismatch` or `pull_failed`.
    - Cons: history belongs in git; the note would go stale.

### 5. Remove the leftovers on GitHub

**Problem.** The removed workflow force-pushed a pin branch on its last run, and earlier runs published images to GHCR that nothing will pull.

**Context.** `git ls-remote --heads origin 'preview-worker-pin/*'` lists `preview-worker-pin/cfbafc5d238e4eb3232bf` on 2026-11-02. The package is `ghcr.io/orkestrator-ai/orkestrator-v2/artifact-preview-worker`; its visibility and versions could not be read from this session (the token lacks `read:packages`).

**Investigation.** Deleting a remote branch or a registry package is outward-facing and not reversible from the repository, so agents must not do it without the user's approval (AGENTS.md, Orkestrator section).

**Decisions.**

- **Delete or keep?**
  - **Ask the user, then delete the branch and the package once task 1 has merged (recommended).**
    - Pros: no clutter; no public image that looks supported.
    - Cons: needs a maintainer with package admin rights.
  - **Keep them.**
    - Pros: no action needed.
    - Cons: an orphaned branch and public image with no owner.

## Current state

- The `publish-preview-worker` workflow and its step test (`preview-worker-publish.test.ts`) were removed on 2026-11-02, with the workflow assertions in `tests/unit/ci-workflows.test.ts` and `preview-worker-context-digest.test.ts`.
- `published-image.json` holds `null`; every install builds the worker from its shipped context.
- The pull route, pin file, `write-pin.ts` and `publish.sh` are still in the tree.

## Constraints and rationale

- Keep the context digest and the image label: outdated-worker detection after an upgrade depends on them, independently of publishing.
- Never let preparation pull an image by name at runtime; building the shipped context is the only route that trusts nothing beyond the install's own files.

## Related

- [0053-rich-transcripts.md](0053-rich-transcripts.md): task 1 there (publish the image) was dropped in favour of this file.
- [Preview worker](../../architecture/transcript-artifacts-runtime.md#preview-worker) in the runtime guide.
