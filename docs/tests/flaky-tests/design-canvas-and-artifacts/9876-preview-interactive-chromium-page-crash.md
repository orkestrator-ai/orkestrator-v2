# Interactive preview resource-escape page crashed on CI

- **ID:** 9876
- **Status:** resolved
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

## Polling-window diagnostics — 2026-10-31 (review follow-up)

- A crash after `setContent` previously reached the polling deadline and failed
  a bare request assertion after the Chromium log had been deleted. The poll
  now stops on a crash, and both a crash and incomplete control requests throw
  inside the diagnostic handler's scope, before cleanup.
- Verified on Linux with temporary fault injection in the control case: added
  a never-requested control path to keep polling active, then scheduled
  `page.goto("chrome://crash")` 100 ms after `setContent` returned. The expected
  failure printed the crash event, free/total memory, load and actual Chromium
  log lines (0.8 s; artifact `/tmp/orkestrator-test-run.E3vXOJ`). With only the
  never-requested path, the expected timeout named that path, reported
  `no crash event` and printed the log tail (10.4 s; artifact
  `/tmp/orkestrator-test-run.LXYBKZ`). Both injections were removed afterwards.
- Both checks used `mise run test:logged -- --name <injection-name> -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./src/core/transcript-artifacts/preview-interactive.test.ts
  --test-name-pattern 'the sink detects requests from a deliberately unrestricted page'
  --parallel=1 --only-failures`, with names `preview-polling-crash-injection`
  and `preview-polling-timeout-injection`, respectively. The complete owning
  file passed without fault injection. The CI crash's underlying cause remains
  unconfirmed.

## CI recurrence (2026-11-03)

Failed in the `Tests (backend)` shard on `main` at
[`a44641cbc`](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41737163492/job/126269206874),
at `preview-interactive.test.ts:393`, the only backend failure of that run
(17,062 passed, 1 failed). The owning file passed alone on 2026-11-04 on the Linux
worktree host (`bun test --cwd apps/backend ./src/core/transcript-artifacts/preview-interactive.test.ts --parallel=1 --only-failures`,
exit zero, 12.2 s).

## CI recurrence and resolution — 2026-11-08 / 2026-11-09

**Recurrence.** CI pull-request run 42535048007 (#1991, `inline-login-card`),
job "Tests (backend)" 128897384518, failed only this case at
`preview-interactive.test.ts:393` (12,354.99 ms; 20,580 passed, 1 failed).
`mise run flaky:recurrence -- 9876 --base a49fd2815` answered "open".
Observed from branch `fix-ci-failures-46b27b2ba576-r1`, base `a49fd2815`.

**What the diagnostics showed.** The error was `setContent: Page crashed`
with the call log `waiting until "load"`; free memory 14.5 of 16.8 GB, load
4.4. The Chromium log tail shows the escape script had already run by
23:33:32.93 (the sink's `/script` evaluated, the font decode and the
EventSource MIME refusal logged), and nothing after it until the renderer
crash at 23:33:44.55, about 12 s later. The page navigates itself away
before its `load` can fire (form submit, a `location.href` redirect, a
popup), so `setContent` was still waiting for `load` when the renderer hung
and then crashed.

**Root cause (test).** The control case waited for the `load` event of a page
built to navigate away, although what it asserts is only that the sink saw
each request class. Why Chromium's renderer hangs and crashes in that state
on the loaded runner is not established; the case no longer depends on it.

**Fix.** `setContent` now waits only for `commit`, the polling loop decides
as before, and a crash fails the case only when a control request is still
missing (the failure then names the missing paths, the crash and the
`setContent` error, plus the existing memory, load and log tail). The
assertions on the control paths are unchanged.

**Verification.**

- Reproduced before the fix: temporary fault injection in the sink (no answer
  for `/bg`, `/form`, `/after-redirect`, `/popup`, `/iframe`, so `load`
  never fires) plus `page.goto("chrome://crash")` 2 s after the start page
  failed with the CI signature, `setContent: Page crashed` /
  `waiting until "load"` (2.5 s).
- With the fix and the same injection: passed (0.5 s). With the crash moved
  to 1 ms (before any request), it still failed, naming every missing path,
  the crash and the `setContent` error. Injections removed afterwards.
- The complete owning file passed unchanged through `mise run test:logged --
  --name preview-interactive -- bun test --cwd apps/backend --preload
  ../../tests/setup-node.ts
  ./src/core/transcript-artifacts/preview-interactive.test.ts --parallel=1
  --only-failures` (exit 0, Linux).
