# Terminal history normalization test times out under aggregate load

- **ID:** 0213
- **Status:** open

Observed: 2026-10-15

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
