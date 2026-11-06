# Resume history remount exceeds the test deadline

- **ID:** 1603
- **Status:** resolved
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

### Resolution — 2026-11-06

- **Root cause:** the cost of the test itself. Both cases render more than 512 rows four times (open, archive, reopen, show archived). Each render takes about 1 s of happy-dom work on a loaded host. Timed per phase at load averages of 20-27, the cases took 3.4-5.8 s in total against Bun's 5 s default, and each Testing Library query costs about 100 ms over the 8,700-node list. There is no race: the work is CPU-bound and nothing could be awaited instead.
- **Reproduced:** yes. The unchanged case failed alone at 5,269 ms at a host load average of 30.
- **Fix:** in `NativeResumeSessionDialog.test.tsx` the two parameterized cases get a 60 s test budget (`LARGE_LIST_TEST_TIMEOUT_MS`), and their large-list `findBy*` and `waitFor` calls get 20 s. Row counts and assertions are unchanged. The 512/513 boundary still comes from the backend cap.
- **Verification:** `mise run test:logged -- --name n1653-stress -- bun --cwd=apps/web test src/components/chat/NativeResumeSessionDialog.test.tsx --rerun-each=6` passed 282 tests with 0 failures, at a load average of about 20-30.
- Same test and cause as [1653](1653-resume-dialog-archived-restore-timeout.md); resolved by the same change.
