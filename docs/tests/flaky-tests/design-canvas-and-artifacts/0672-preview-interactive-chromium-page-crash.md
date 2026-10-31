# Interactive preview resource-escape page crashed on CI

- **ID:** 0672
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `interactive preview in Chromium > resource escape > the sink detects requests from a deliberately unrestricted page`
- **File:** `apps/backend/src/core/transcript-artifacts/preview-interactive.test.ts:346`
- **Original command:** CI `main` run 39684874636 (`f228a6aa`), job "Unit and integration tests", `mise run test` on `ubuntu-latest` (four cores; one Bun worker per package).
- **Failure:** `error: setContent: Page crashed` at line 346. The run also failed
  the Linux worktree-watcher cases fixed in `fix(ci): stop the Linux watcher
  crash and two fixture races keeping main red`; this case is unrelated to them.
- **Isolated rerun:** `mise run test:logged -- --name preview-interactive-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/preview-interactive.test.ts --parallel=1 --only-failures`
  passed unchanged on macOS arm64 (16.2 s) on 2026-10-22. Not rerun on Linux.
- **Hypothesis:** none established. A Chromium renderer crash on a four-core
  runner under the backend package's load is plausible but unproven; the other
  red runs since 2026-10-20 did not repeat it.

## CI recurrences, 2026-10-24 and 2026-10-25

- CI `main` runs 40081231733 (2026-10-24) and 40189950916
  (#1248, 2026-10-25) failed the same case with `setContent: Page crashed` at
  `preview-interactive.test.ts:364` (14.8 s and 22.9 s). That is 2 of the 44
  failing `main` runs from 2026-10-23 to 2026-10-25; the same backend package
  passed it in the others.
- The runner image is now Ubuntu 26.04 (kernel 7.0, four cores, 16 GB), seen
  in the todo 0030 probe run 40193653132, where this case passed.
- **Next step:** unchanged. Capture Chromium's crash reason (Playwright
  `page.on("crash")` plus the browser's stderr) in the test's failure output so
  the next recurrence says why.

## Masked on CI, and diagnostics added — 2026-10-31 (todo 0030)

- From 2026-10-29 (#1425) every CI `main` run failed this file's process
  cases, and about 30 other real-Chromium preview cases, deterministically:
  the private test TMPDIR put Chromium's `SingletonSocket` at 113 bytes, past
  Linux's 108-byte limit, and the worker reported it as "could not start with
  its sandbox enabled". That is fixed (the preview tests make worker scratch in
  the parent TMPDIR), so CI can show this case again. No `Page crashed` appeared
  in the 27 failing `main` runs read from 2026-10-28 to 2026-10-31.
- The control case now launches Chromium with `--enable-logging
  --log-file=<tmp>` and, on failure, reports the page's `crash` event with the
  host's free memory and load average, and the last 40 lines of Chromium's log.
  Checked by forcing a renderer crash locally (`chrome://crash` before
  `setContent`): the failure printed the crash event, memory, load and log
  tail.
- **Next step:** read that output at the next CI recurrence.

