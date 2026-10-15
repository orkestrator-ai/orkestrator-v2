# Terminal history normalization exceeds the aggregate deadline

- **ID:** 0213
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `terminal history > normalizes lines, CRLF, Unicode, and ANSI across transport chunks and pages`
- **Owning file:** `apps/backend/src/core/terminal-history.test.ts`.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`, with the testing guide's macOS GNU-tool PATH.
- **Worker configuration:** workspace group reserved four worker slots; root used one worker, bridges two, and protocol one. Other validations were active on the host.
- **Failure:** the 5000 ms deadline expired at 5002.14 ms; late work then read `previousCursor` from a null history page after fixture cleanup.
- **Evidence:** `/tmp/orkestrator-test-run.BYvvBs/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Aggregate counts:** backend 7712 passed, 39 skipped, 5 failed across 424 files in 518.91 seconds; root 2945 passed, 1 skipped, 1 failed. Bridge and protocol groups passed.
- **Isolated rerun:** `mise run test:logged -- --name terminal-history-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/terminal-history.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 7.9 seconds).

Concurrent fixture I/O is a possible cause, not a confirmed diagnosis. The
OpenCode auth-status change does not touch terminal history. No test deadline,
assertion or skip was changed.
