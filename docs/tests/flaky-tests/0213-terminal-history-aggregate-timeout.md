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

## Additional observation on 2026-10-15

- Test: `terminal history > normalizes lines, CRLF, Unicode, and ANSI across transport chunks and pages`
- Owner: `apps/backend/src/core/terminal-history.test.ts`
- Original command: `mise run test`
- Worker configuration: four aggregate groups running concurrently; the backend package ran inside the workspace group.
- Failure: default 5000ms timeout, observed duration 5001.09ms (last frame `terminal-history.test.ts:297`).
- Evidence: `/tmp/orkestrator-test-run.qhT3jO/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Isolated rerun: `bun test ./src/core/terminal-history.test.ts` from `apps/backend` passed unchanged: 25 pass, 0 fail in 6.75 seconds.

Hypothesis: the case drives real transport chunks and pages and sits close to
the default 5-second deadline even alone (the whole file takes 6.75 seconds), so
host load from the concurrent groups pushes it over. The test source was
neither changed nor skipped. The branch under test
(`chore-2026-10-14-cleanup-follow-ups`) does not touch terminal history.

## Grok-trust PR-stage merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name pr-stage-full -- mise run test`, on `verify-grok-trust-claude-parked-retry` merged with `origin/main` at `607d12e2`, host load average about 27.
- **Failure:** `normalizes lines, CRLF, Unicode, and ANSI across transport chunks and pages` timed out at 5002.96 ms. The workspace group had three failures in total (8821 backend tests passed); root, bridges and the protocol lockfile groups passed.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.rEfkv1/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/terminal-history.test.ts` from `apps/backend` passed unchanged: 25 pass, 0 fail in about 8 seconds.
- **Assessment:** an unchanged owning-file pass confirms a recurrence. The branch does not touch this code. No source, assertion, timeout or skip changed.
