# Run a container-isolated preview worker with the stored document text

## Task analysis

Analysed 2026-11-11 against `main` at `498b68766`, while doing to-do 5780
task 2 (retired 2026-11-11;
`git show 498b68766:docs/todo/transcripts-and-observation/5780-find-inside-static-documents.md`)
on rkmbp (macOS), where the Docker daemon was not running.

### Tasks

1. **Verify a static document in a prepared worker image and read its `search-text`**: the text step ran only in process isolation. Status: open.

### 1. Verify a static document in a prepared worker image and read its `search-text`

**Problem.** Static verification now reads the document's text for Find in the
preview worker (`staticHtmlDocumentText`, called from `runStatic` in
`preview-jobs.ts`) and the backend stores it as the publication's `search-text`
representation. That step has run with real Chromium only in process isolation,
under Bun. Container isolation, the production default where Docker is
available, runs the staged Node bundle inside the worker image, and nobody has
run it there.

**Context.** The worker bundle includes the function
(`preview-worker-context-digest.test.ts` pins it), and the staged context's
digest moved from `sha256:5b9f98e0…` to `sha256:fbed1f2f…`, so an install with
a prepared image is asked to prepare it again. `page.evaluate` serializes the
function from the bundle, so the risk is narrow: a bundling or Node difference
that leaves the function referring to something outside its body would make the
read throw, which the worker swallows, and the document would quietly get no
stored text (Find then covers it once shown, as before).

**Investigation.** `preview-static-search-text.test.ts` passed with real
Chromium in a process-isolated runner (two cases, 10.2 s), and
`static-html-document-text.test.ts` pins the copy to the frame's walk. The
container cases of the transcript-artifact suites skip without Docker or a
prepared image. Not attempted here: `docker info` could not reach a daemon.

**Decisions.**

- **How to qualify the container path?**
  - **Prepare the image (`docker/artifact-preview-worker/build.sh` or "Prepare isolated preview worker"), verify a static document with `ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION=container` on an isolated `dev:test` profile, and read `search-text` with the `orkestrator` CLI or Find (recommended).**
    - Pros: the exact bundle and runtime users get; no billed turn (publish through the artifact tools against a fake model or the CLI).
    - Cons: needs a host with a running Docker daemon and an image build.
  - **Add a container case to `preview-static-search-text.test.ts` gated like `preview-print.test.ts`'s.**
    - Pros: repeatable wherever the slow tier has an image.
    - Cons: skipped on every host without one, so it proves nothing until it runs somewhere.

## Related

- [`rich-transcripts.md`](../../architecture/rich-transcripts.md#static-document-presentation): how the text is read, stored and searched.
- [`transcript-artifacts-runtime.md`](../../architecture/transcript-artifacts-runtime.md): worker isolation, image preparation and the context digest.
