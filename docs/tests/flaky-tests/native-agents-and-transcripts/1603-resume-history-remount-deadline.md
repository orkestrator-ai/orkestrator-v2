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
