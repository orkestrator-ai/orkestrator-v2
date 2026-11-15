# Consolidation subprocess-bounds fake CLI never records its pid under load

- **ID:** 9820
- **Status:** open
- **Date observed:** 2026-11-15

Tests: `subprocess bounds > a claude CLI that ignores SIGTERM times out, is
killed and leaves no directory` and `subprocess bounds > a codex CLI that
ignores SIGTERM times out, is killed and leaves no directory` in
`apps/backend/src/core/multi-review-evaluation-drivers.test.ts`.

Observed on `static-html-reports-776fd527af5f-r1` at `c9c14eef6` (a merge of
`origin/main` at `b6044774c` into the branch), merge base `b6044774c`. The
branch changes no backend code: its diff against `origin/main` is
`apps/web-public/`, `apps/web/vite-plugin-renderer-security.ts`, its test,
`apps/web/src/components/chat/rich/static-html-frame-source.ts`,
`e2e/public-site/` and documentation, none of which this test's imports
reach. No group index entry matched either test; this is a new observation,
not a counted recurrence.

Original command:
`mise run test:logged -- --name review-default-tests-rerun -- mise run test`
on macOS (load average about 8.5 when the run finished). Both cases failed in
about 405 ms at line 306 with `ENOENT: no such file or directory, open
'<tmp>/mre-drivers-test-*/pid'`: `runConsolidation` had already returned
`{ ok: false, failure: "timed out" }` (the 300 ms `timeoutMs`), but the fake
CLI had not written its `pid` file. The backend group counted 2 fail out of
18,621 tests across 1,309 files (245.5 s).

The aggregate runner reran the unchanged owning file alone: 22 pass, 0 fail
in 3.1 s. The fake writes `cwd` and `pid` as the first lines of a `/bin/sh`
script, so a plausible but unconfirmed cause is that under load the shell had
not reached those lines before the 300 ms timeout killed its process group.
If that is it, the product behaviour is correct (a CLI that has not started
is still timed out and killed) and the test's premise, that the fake records
its pid within 300 ms, is what fails. Not shown. No deadline, assertion or
implementation changed. Evidence: `orkestrator-test-run.DsnGMR` under the
host temporary directory.
