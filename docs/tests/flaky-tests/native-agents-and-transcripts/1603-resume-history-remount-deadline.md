# Resume history remount exceeds the test deadline

- **ID:** 1603
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `NativeResumeSessionDialog > keeps archived history restorable after reopening with %s live rows` (two parameterized cases).
- **File:** `apps/web/src/components/chat/NativeResumeSessionDialog.test.tsx`.
- **Original command:** `mise run test` during review preparation, with two isolated web workers.
- **Failure:** both cases exceeded their 5000 ms deadline (5806.02 ms and 6835.11 ms); an unmounted-root error followed the first timeout.
- **Web group:** 11,148 passed, ten skipped and four failed across 11,162 tests in 736 files (803.26 s).
- **Complete unchanged owner:** `mise run test:logged -- --name prior-resume-failure -- bun test --cwd apps/web ./src/components/chat/NativeResumeSessionDialog.test.tsx --parallel=1 --only-failures` passed, exit zero in 13.8 s.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-b8f98852-001a-4729-aa23-7e07f56c9ac5/validation-04.stdout.txt`.

The owner was rerun while held-history reconciliation was being repaired in a
separate hook path. No resume-dialog implementation, assertion, deadline or
skip changed. Shared-host scheduling is a possible explanation; the result
does not establish a root cause or make the original aggregate green.

## Agent mail review validation — 2026-11-01

- **Original command:** `mise run test:logged -- --name repair-root-tests -- mise run test`.
  The default runner reserved workspace/root/bridges/protocol slots 5/1/2/1;
  web used two isolated workers and backend used three. Component browser and
  isolated-profile browser checks also ran on this host.
- **Aggregate:** exit 1 after 907.5 s. Web reported 11,276 passed, ten skipped
  and twelve failed across 11,298 tests in 746 files.
- **Evidence:** `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.8VTwNj/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Failure:** The archived-history remount case exceeded 5000 ms at 5532.82 ms.
- **Complete unchanged owner:** `mise run test:logged -- --name repair-resume-owner -- bun test --cwd apps/web ./src/components/chat/NativeResumeSessionDialog.test.tsx --parallel=1 --only-failures` passed, exit 0, in 13.7 s. Passing raw output was removed by the bounded logger.
- **Assessment:** recurrence of the existing intermittent failure; no owning
  implementation, assertion, timeout or skip changed. Shared-host contention
  remains a hypothesis, and the aggregate remains non-green.
