# A click inside a sandboxed frame leaves the element capture `selecting` under CI load

- **ID:** 10073
- **Status:** open
- **Date observed:** 2026-11-26
- **Test:** `element targets inside iframes, in Chromium > a click inside a sandboxed frame captures only the frame element, unsupported`
- **File:** `apps/desktop/tests/browser-preview-frame-targets.integration.test.ts`
- **Host:** GitHub Actions `ubuntu-latest`, job `Tests (workspace)` of CI run
  45725309461, Bun 1.4.4.
- **Observing head:** `8950e12e2` (`main`, a push).
- **Observing branch base:** `8950e12e2` (a push to `main`).

## Observation

The workspace shard ran `mise run test:full` (`bun scripts/test-all.ts`, the
workspace group: web, desktop, web-public, cli, protocol and toolchain). It
reported 25888 pass, 1 fail and 50 skip; desktop had 2506 pass and 1 fail.
This case failed after 5161.78 ms at line 198 in the harness's `selected`
helper, which polls the capture status until it leaves `selecting`:

```
not selected: {"v":1,"captureId":"capture-13","nonce":"nonce-1","mode":"element","status":"selecting"}
```

The click inside the sandboxed frame never produced a selection before the
poll gave up, so the capture was still `selecting`.

The runner's automatic rerun of the owning file alone passed (4.7 s, "PASSED
ALONE … likely a load flake"). Locally on 2026-11-26 (beelink2, Linux,
headless) `bun test tests/browser-preview-frame-targets.integration.test.ts`
from `apps/desktop` passed: 13 pass, 0 fail.

## Recurrence on PR #2583 (2026-11-28)

- **Host:** GitHub Actions `ubuntu-latest`, job `Tests (workspace)`
  ([job 140803162068](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/46088355590/job/140803162068)) of CI run 46088355590.
- **Observing head:** `bc22606c2` (PR #2583).
- **Observing branch base:** `36cdf8860`.
- **Failing command:** `ORKESTRATOR_TEST_GROUPS=workspace mise run test:full`,
  with one workspace scheduler slot and one Bun worker for the desktop task
  (`1x PARALLEL`). The workspace group reported 25892 pass, 1 fail and 50 skip.
- **Recurrence check:**
  `mise run flaky:recurrence -- 10073 --base 36cdf8860 --registry-ref origin/main`
  answered "open. Record the failure as a recurrence".

The same case failed at line 198 after 5169.12 ms, again in the `selected`
helper, with the same status:

```
not selected: {"v":1,"captureId":"capture-13","nonce":"nonce-1","mode":"element","status":"selecting"}
```

The runner reran the owning file alone with one worker slot, and it passed in
5.6 s. The failure duration again matches the length of the status poll, so
this adds no evidence about whether the click was delivered late or missed the
frame.

## Assessment

The cause is unconfirmed. The test's duration (5.16 s) is about the length of
the `until` poll, so either the click's handler in the page had not run when
the poll ended, or the click missed the frame. Under a loaded runner the
headless Chromium page may take longer than the poll allows to deliver the
click to the sandboxed frame. Nothing in the run's output says which.

## Next step

Reproduce under contention (`bun scripts/test-under-contention.ts` with the
file and `--rerun-each`), and on failure record the capture status timeline
and whether the frame received the `mousedown`. Raise the poll only if the
page work is shown to be genuinely slow, and say so beside the budget.
