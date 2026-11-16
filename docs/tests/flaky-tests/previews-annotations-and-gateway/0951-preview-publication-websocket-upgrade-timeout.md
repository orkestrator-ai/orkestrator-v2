# Preview publication WebSocket upgrade test timed out under aggregate load

- **ID:** 0951
- **Status:** resolved
- **Date observed:** 2026-10-26
- **Test:** `PreviewPublicationManager (private HTTPS origins) > application WebSockets upgrade through the published origin with the session`
- **File:** `apps/backend/src/preview-publication.test.ts:300`
- **Change under test:** todo 0145 (Claude Linux sandbox probe), which touches neither this owner nor its subject.
- **Original command:** `mise run test` on macOS, Bun 1.4.4, branch `todo-0145-claude-linux-sandbox-39a58b878dd6` (head `4c54d788e`), with other worktrees validating on the host (load average about 21).
- **Aggregate result:** timed out after 5,000 ms (5097.45 ms reported) in the backend workspace group, alongside 0950 and 0621 in the same run.
- **Unchanged owner rerun:** `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-publication.test.ts --parallel=1` passed (13 pass, 0 fail).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.pHWGe9` (the run's failure artifacts).
- **Hypothesis:** host load stretched the test past Bun's five-second default. Unproven; no implementation, assertion, timeout or skip changed.

## Investigation — 2026-11-10

Still open; not reproduced. Bun times `beforeEach` separately from the test
body (checked with a 3 s hook and a 3 s body under the 5 s default), so the
per-test `certificates()` RSA key generation (0.13–1.06 s each at host load
about 58) is not what crossed the deadline. Alone the test takes about 0.27 s
with its hook, and it passed 30 of 30 under 12 unpinned burners
(`mise run test:logged -- --name b39-0951-contention -- bun scripts/test-under-contention.ts --burners 12 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-publication.test.ts --parallel=1 --rerun-each=30 -t "application WebSockets upgrade"`).
The test's upgrade promise resolves only when the response contains the
fixture marker and has no `end`/`close` handler, so a refused or closed
upgrade waits for the 5 s deadline rather than failing with the response
text; adding that handler would show the cause on the next recurrence.

## Resolution (2026-11-15)

- **Class:** default budget (A).
- **Root cause:** the case timed out at Bun's 5 s default under load average about 21; it takes about 0.27 s alone.
- **Fix:** `tests/default-test-timeout.ts` (a 60 s per-test and hook hang watchdog in both shared preloads, replacing Bun's 5 s default). The upgrade promise in `apps/backend/src/preview-publication.test.ts` now also rejects on socket `close` with the response text, so a refused upgrade fails at once with evidence instead of waiting out the budget. The file's `until` poll (200 × 5 ms) and the certificate-reload poll (400 × 10 ms) are now 30 s hang watchdogs.
- **Reproduced:** no — the unchanged code passed under the same contention; the evidence is the removed deadline, not a reproduced failure, which is weaker.
- **Stress:** `mise run test:logged -- --name b-cont -- bun scripts/test-under-contention.ts --core 2 --burners 6 -- bash -c 'cd apps/backend && bun test src/preview-tunnel-server.test.ts src/preview-publication.test.ts src/core/previews/local-discovery.test.ts src/core/previews/terminal-roots.test.ts --preload ../../tests/setup-node.ts --parallel=1 --rerun-each=3'` passed (59.7 s).
