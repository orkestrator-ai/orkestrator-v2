# File read streaming leftovers

## Task analysis

Analysed 2026-11-05 against `main` at `5467f6ccb`. These are what was left when batch E-0580 of the efficiency report (part 0580, ST-21: "Whole files cross RPC as base64, branch reads spawn twice, and usage reports parse every row") was finished and its report file deleted. It is still in history: `git show 5467f6ccb:docs/reports/efficiency-logging-database/0580-st-21-file-rpc-and-usage-report.md` reads it, and the commit before its deletion on this branch ends with its outcome table.

### Tasks

1. **Live evidence for the streamed file reads** (report part 0580, task 1): show in a real browser that file viewer images and detached-transcript media load from the content origin, and fall back when they cannot. Status: open.
2. **How often large files are read this way** (report part 0580, Needs verification): make the measurement possible, by finding whether the gateway's metrics give per-command response bytes for the three base64 readers or adding a content-free size histogram for them. Status: open (reading it on a working profile over a few days is in 7568: 5800 task 2).
3. **The base64 readers that remain** (report part 0580, task 1, "move large-file readers"): decide whether transcript images should move to stream URLs too. Status: blocked (waits on 7568: 5800 task 2).

### 1. Live evidence for the streamed file reads

**Problem.** Task 1 of the report is built and unit tested, but nothing has shown it working against a real backend and content listener. A renderer that cannot reach the content origin, a CSP gap or a capability revoked too early would show as a broken image only in a real browser.

**Context.** `transcript_media_open_stream` now also accepts an absolute host path with no `environmentId`, confined to the readable roots `read_file_base64` uses (`readableHostFileRoots`, `apps/backend/src/core/readable-host-roots.ts`; `openReadable` in `transcript-artifacts/media-stream.ts`). The file viewer's image tab and its live image diff preview load through `loadEnvironmentImage` (`apps/web/src/lib/environment-image-source.ts`), which opens an environment-scoped stream when `mediaStreamingAvailable` says the origin is reachable and revokes it on unmount, otherwise reading base64 as before. `FilePreview` streams a detached transcript's host media instead of reading base64. The renderer CSP already allows `img-src` and `media-src` over `http:`/`https:` (`packages/protocol/src/renderer-content-security-policy.ts`).

**Investigation.** Proved by tests only: `readable-host-roots.test.ts` (the stream admits exactly what `read_file_base64` admits, refuses a path outside the roots, a path beside a custom worktree and a symbolic link out, and re-applies the roots on every served request), `media-stream.test.ts` ("readable-roots media streams": real content listener, ranged bytes, 404 once the roots change), `environment-image-source.test.ts` and `FilePreview.media-stream.test.tsx`. No `dev:test` profile was run for this batch, so the browser path, the reload path and an inactive tab returning to an open image are unobserved.

**Decisions.**

- **How to verify?**
  - **A `dev:test` profile with `--fixture`: open a PNG over 8 MiB and an SVG in the file viewer of a local and a container fixture environment, check the `<img>` source is the content origin for the PNG and a data URL for the SVG, reload, switch environments and back, and confirm the stream closes when the tab closes (recommended).**
    - Pros: the real listener, CSP and capability lifetime; no provider turn needed.
    - Cons: the container case needs the Docker fixture.
  - **Add a Playwright case to the browser suite.**
    - Pros: repeatable.
    - Cons: the suite has no fixture image over the inline bound today; more to maintain for an occasional read.

### 2. How often large files are read this way

**Problem.** The report's impact was reasoned, not measured: nobody knows how often whole files cross the command channel as base64, or how large they are.

**Context.** `read_file_base64`, `read_environment_file_base64` and `read_container_file_base64` stay registered for small reads and older clients (the report's recommended "add a route" option). Their payloads are bounded by `MAX_BINARY_FILE_BYTES` (10 MiB).

**Investigation.** None live. The gateway counts invokes but not by payload size per command.

**Decisions.**

- **How to measure?**
  - **Read the gateway's per-command invoke counts and response bytes on a working profile for a few days, if the metrics expose them; otherwise add a content-free size histogram for these three commands (recommended).**
    - Pros: real usage; tells task 3 whether moving more readers is worth it.
    - Cons: a histogram is new metrics surface.
    - Agent part: the metrics check or the histogram, proved on a `dev:test` profile; the few days on a working profile are in the manual-test checklist (7568: 5800 task 2).
  - **Leave it.**
    - Pros: no work; the large readers named in the report have moved.
    - Cons: task 3 stays a guess.

### 3. The base64 readers that remain

**Problem.** Some renderer readers still take whole files as base64: an unpinned transcript image resolved by `media-resolver.ts` (`read_file_base64` for a host path, `read_container_file_base64` for a container path), `readBinaryFile` in `apps/web/src/lib/backend/kanban.ts`, and the base64 fallbacks kept for older backends.

**Context.** The resolver returns `data:` URLs that its callers cache (`image-preview-cache.ts`), size and decode (`imageDimensionsFromDataUrl`, `FilePreview`'s download), so moving it to capability URLs changes more than a fetch. Pinned images (`transcript_media_pin`) and PDF previews (read in process by the backend, never crossing the channel) are not affected. Server-side reads by `commands-pdf.ts` and `web-annotation-migration.ts` call the commands in process.

**Investigation.** Not started; waits on task 2's numbers from a working profile (7568: 5800 task 2).

**Decisions.**

- **Which readers to move next?**
  - **None until task 2 shows they matter (recommended).**
    - Pros: no churn in the cached `data:` URL paths.
    - Cons: an occasional large unpinned image still crosses as base64.
  - **Move unpinned live image reads in the resolver to stream URLs.**
    - Pros: removes the base64 cost for the remaining large images.
    - Cons: the image cache, dimension probe and download paths must learn a second URL kind.

## Related

- to-do 1202 efficiency follow-ups, task 7 (retired 2026-11-10)
- Efficiency report, E (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`)
- [version-compatibility.md](../../architecture/version-compatibility.md#register): the environment-less stream fallback row
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 2: reading the base64 reader sizes on a working profile over a few days) moved there on 2026-11-10.
