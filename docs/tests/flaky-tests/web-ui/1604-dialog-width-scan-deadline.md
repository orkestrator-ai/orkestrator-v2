# Dialog width source scan exceeds the test deadline

- **ID:** 1604
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `DialogContent width > keeps callers on size or --modal-max-width rather than max-w classes`.
- **File:** `apps/web/src/components/ui/dialog.test.tsx:321`.
- **Original command:** `mise run test`, the exact held-history review preparation rerun, with two isolated web workers.
- **Failure:** the source-scan test exceeded its 5000 ms deadline after 5343.46 ms.
- **Web group:** 11,165 passed, ten skipped and one failed; the full aggregate finished in 952.9 s including 287.2 s queued.
- **Complete unchanged owner:** `mise run test:logged -- --name current-dialog-width -- bun test --cwd apps/web ./src/components/ui/dialog.test.tsx --parallel=1 --only-failures` passed, exit zero in 6.3 s.
- **Evidence:** `/tmp/orkestrator-test-run.NettPR/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log` (compressed after aggregate completion).

The source scan passed when the complete owner ran by itself. Shared-host
contention is a possible explanation; no root cause is established. No dialog
implementation, assertion, deadline or skip changed. The aggregate also
reported failures in unchanged backend and root owners and remains non-green.
