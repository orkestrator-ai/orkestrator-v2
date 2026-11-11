# File read streaming leftovers

## Task analysis

Analysed 2026-11-11 against `main` at `14df96544` (first analysed 2026-11-05 against `5467f6ccb`). These are what was left when batch E-0580 of the efficiency report (part 0580, ST-21: "Whole files cross RPC as base64, branch reads spawn twice, and usage reports parse every row") was finished and its report file deleted. It is still in history: `git show 5467f6ccb:docs/reports/efficiency-logging-database/0580-st-21-file-rpc-and-usage-report.md` reads it, and the commit before its deletion on this branch ends with its outcome table.

### Tasks

1. **Live evidence for the streamed file reads** (report part 0580, task 1): show in a real browser that file viewer images and detached-transcript media load from the content origin, and fall back when they cannot. Status: open (the local environment, the reload, tab close, fallback and the environment-less stream were observed on 2026-11-11; the container environment and a detached transcript's audio or video in the renderer remain).
2. **How often large files are read this way** (report part 0580, Needs verification): make the measurement possible, by finding whether the gateway's metrics give per-command response bytes for the three base64 readers or adding a content-free size histogram for them. Status: done (the histogram landed and was read on a `dev:test` profile on 2026-11-11; reading it on a working profile over a few days is in 7568: 5800 task 2).
3. **The base64 readers that remain** (report part 0580, task 1, "move large-file readers"): decide whether transcript images should move to stream URLs too. Status: blocked (waits on 7568: 5800 task 2).

### 1. Live evidence for the streamed file reads

**Problem.** Task 1 of the report is built and unit tested, but nothing had shown it working against a real backend and content listener. A renderer that cannot reach the content origin, a CSP gap or a capability revoked too early would show as a broken image only in a real browser.

**Context.** `transcript_media_open_stream` also accepts an absolute host path with no `environmentId`, confined to the readable roots `read_file_base64` uses (`readableHostFileRoots`, `apps/backend/src/core/readable-host-roots.ts`; `openReadable` in `transcript-artifacts/media-stream.ts`). The file viewer's image tab and its live image diff preview load through `loadEnvironmentImage` (`apps/web/src/lib/environment-image-source.ts`), which opens an environment-scoped stream when `mediaStreamingAvailable` says the origin is reachable and revokes it on unmount, otherwise reading base64 as before. `FilePreview` streams a detached transcript's host media (audio and video only) instead of reading base64. The renderer CSP already allows `img-src` and `media-src` over `http:`/`https:` (`packages/protocol/src/renderer-content-security-policy.ts`). A capability lives 15 minutes idle and 2 hours at most, and at most 256 are held (`media-stream-route.ts`).

**Investigation.**

- Unit and integration tests: `readable-host-roots.test.ts`, `media-stream.test.ts` ("readable-roots media streams"), `environment-image-source.test.ts` and `FilePreview.media-stream.test.tsx`.
- 2026-11-11, beelink2 (Linux, headless Chromium 158 through Playwright 1.65.0), `dev:test` profile `file-stream-5800` started with `--fixture --fixture-environments local --no-agent-credentials --agent-platforms codex --headless` and `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`; no provider turn. A 9,691,771-byte random-pixel PNG (1750×1750) and a 160-byte SVG were written to `qa-media/` in `fixture-local`'s worktree and opened from the Files panel's All files tab:
  - The PNG's `<img>` loaded from the content origin (`http://localhost:<port>/m/<capability>`, a different site from the page's `127.0.0.1`) and decoded at 1750×1750. A plain GET of that URL answered 200 with all 9,691,771 bytes; `Range: bytes=0-99` answered 206 `bytes 0-99/9691771`.
  - The SVG loaded as a `data:image/svg+xml` URL (120×120) through `read_environment_file_base64`.
  - No Content Security Policy error was logged.
  - Switching to the SVG tab and back kept the same capability, still served: a file viewer tab stays mounted while inactive and releases only on unmount or a file change, as designed.
  - After a page reload the restored PNG tab opened a new capability and loaded it. The capability opened before the reload was still served: the unload runs no React cleanup, so it lapses with its idle lifetime rather than being revoked.
  - Closing the PNG tab sent `transcript_media_close_stream`; the capability then answered 404.
  - With every request to the content origin aborted in the page, the PNG fell back to a `data:image/png` URL and still decoded at 1750×1750 (one `read_environment_file_base64` answer of 12,922,377 bytes).
  - The environment-less stream, invoked directly through the gateway with the PNG's absolute path and no `environmentId`: 206 for `bytes=0-99`, 206 `bytes 0-8388607/9691771` for an open-ended range (the 8 MiB response cap), 404 after `transcript_media_close_stream`, and refused for `~/.bashrc`, outside the readable roots.
  - Screenshots (not committed): the streamed PNG and the inline SVG in the file viewer, and the PNG after fallback.
- Not observed:
  - **The container environment.** This host's account cannot reach the host Docker daemon (`permission denied` on `/var/run/docker.sock`; the app shows "Docker Permission Required"), and the disposable daemon (`mise run docker:disposable`) can only copy an image in from that daemon, so the workspace image would have to be built inside it from nothing. The container path differs from the local one only in passing `containerId` to the stream.
  - **A detached transcript's audio or video in `FilePreview`.** The backend half (the environment-less stream) is observed above. A transcript rendered with no transcript scope and carrying an audio or video file part was not produced on the profile.
  - **An environment switch.** The profile had one fixture environment; the tab switch and the reload above cover an image leaving and returning to view.

**Decisions.**

- **How to verify?**
  - **A `dev:test` profile with `--fixture`: open a PNG over 8 MiB and an SVG in the file viewer of a local and a container fixture environment, check the `<img>` source is the content origin for the PNG and a data URL for the SVG, reload, switch environments and back, and confirm the stream closes when the tab closes (recommended; the local half done 2026-11-11).**
    - Pros: the real listener, CSP and capability lifetime; no provider turn needed.
    - Cons: the container case needs the Docker fixture, which needs a host whose account can use Docker.
  - **Add a Playwright case to the browser suite.**
    - Pros: repeatable.
    - Cons: the suite has no fixture image over the inline bound today; more to maintain for an occasional read.
- **Should a capability opened before a reload be revoked at unload?**
  - **No: leave it to its idle lifetime (recommended).**
    - Pros: bounded already (15 minutes idle, 2 hours at most, 256 entries); an unload handler cannot reliably finish a command anyway.
    - Cons: an unguessable URL to a file the user opened stays readable for up to 15 minutes after the page left.
  - **Send `transcript_media_close_stream` from a `pagehide` handler.**
    - Pros: revokes sooner in the common case.
    - Cons: best effort only, and one more unload path to keep correct.

### 2. How often large files are read this way

**Problem.** The report's impact was reasoned, not measured: nobody knows how often whole files cross the command channel as base64, or how large they are.

**Context.** `read_file_base64`, `read_environment_file_base64` and `read_container_file_base64` stay registered for small reads and older clients (the report's recommended "add a route" option). Their payloads are bounded by `MAX_BINARY_FILE_BYTES` (10 MiB), about 13.4 MiB once encoded.

**Investigation.** The gateway's `commands` block of `/__orkestrator/metrics` already kept, per command, the invoke `count`, `responseBytes` (a sum) and `failures`, for invokes from the desktop window as well as browsers, since both go through `/__orkestrator/invoke`. A sum cannot tell many small reads from a few large ones, so on 2026-11-11 a content-free histogram was added: `base64FileReads` in the same metrics document (`apps/backend/src/gateway-file-read-sizes.ts`, recorded from `GatewayMetricsStore.recordInvoke`). For each of the three commands it holds the successful answers' `count`, `maxBytes` and `buckets` of answer size (`upTo64KiB`, `upTo256KiB`, `upTo1MiB`, `upTo4MiB`, `upTo8MiB`, `upTo16MiB`, `over16MiB`). It holds sizes only, in memory, so it covers the backend's current uptime. Tests: `gateway-file-read-sizes.test.ts` and "keeps a size histogram of the whole-file base64 readers' answers" in `apps/backend/tests/gateway-support-extra.test.ts`. On the `file-stream-5800` profile above it read all zeros at start; after the run it held `read_environment_file_base64` count 8, seven SVG reads in `upTo64KiB` and the 12,922,377-byte fallback in `upTo16MiB`.

**Decisions.**

- **How to measure?**
  - **Read the gateway's per-command invoke counts and response bytes on a working profile for a few days, if the metrics expose them; otherwise add a content-free size histogram for these three commands (recommended; the histogram was added).**
    - Pros: real usage; tells task 3 whether moving more readers is worth it.
    - Cons: a histogram is new metrics surface.
    - Agent part: done. The few days on a working profile are in the manual-test checklist (7568: 5800 task 2).
  - **Leave it.**
    - Pros: no work; the large readers named in the report have moved.
    - Cons: task 3 stays a guess.

### 3. The base64 readers that remain

**Problem.** Some renderer readers still take whole files as base64: an unpinned transcript image resolved by `media-resolver.ts` (`read_file_base64` for a host path, `read_container_file_base64` for a container path), `readBinaryFile` in `apps/web/src/lib/backend/kanban.ts`, and the base64 fallbacks kept for older backends.

**Context.** The resolver returns `data:` URLs that its callers cache (`image-preview-cache.ts`), size and decode (`imageDimensionsFromDataUrl`, `FilePreview`'s download), so moving it to capability URLs changes more than a fetch. Pinned images (`transcript_media_pin`) and PDF previews (read in process by the backend, never crossing the channel) are not affected. Server-side reads by `commands-pdf.ts` and `web-annotations/migration.ts` call the commands in process, so they never reach the gateway's histogram.

**Investigation.** Not started; waits on task 2's numbers from a working profile (7568: 5800 task 2).

**Decisions.**

- **Which readers to move next?**
  - **None until task 2 shows they matter (recommended).**
    - Pros: no churn in the cached `data:` URL paths.
    - Cons: an occasional large unpinned image still crosses as base64.
  - **Move unpinned live image reads in the resolver to stream URLs.**
    - Pros: removes the base64 cost for the remaining large images.
    - Cons: the image cache, dimension probe and download paths must learn a second URL kind.

## Assumptions and decisions

### Task 1: a throwaway browser script rather than a new spec

Followed the recommended verification: a Playwright script against the profile, kept out of the repository, rather than a case in the browser suite. The evidence above names what it checked.

### Task 1: the capability left after a reload is not a defect

It is bounded by the idle lifetime and the entry cap, and revoking at unload cannot be made reliable. Recorded as a decision above rather than changed.

### Task 2: a histogram rather than the existing totals alone

The existing per-command totals give an average only; the question for task 3 is whether reads of several MiB happen, which needs a distribution. The histogram is limited to the three commands, keyed by a fixed list, so no other command name or argument can reach it.

## Related

- to-do 1202 efficiency follow-ups, task 7 (retired 2026-11-10)
- Efficiency report, E (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`)
- [version-compatibility.md](../../architecture/version-compatibility.md#register): the environment-less stream fallback row
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 2: reading the base64 reader sizes on a working profile over a few days) moved there on 2026-11-10.
