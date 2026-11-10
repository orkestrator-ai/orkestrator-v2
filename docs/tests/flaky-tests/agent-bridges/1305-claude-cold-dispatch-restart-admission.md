# Claude cold dispatch after bridge restart

- **ID:** 1305
- **Status:** resolved
- **Observed:** 2026-10-29
- **Test:** `a restarted Claude bridge answers a cold dispatch from disk without registering the session`
- **File:** `apps/backend/tests/claude-cold-dispatch-restart.test.ts:132`

During todo 0248 review repair, `mise run test` (wrapped by
`mise run test:logged -- --name review-tests-rerun -- mise run test`) failed
this unchanged backend test with HTTP 503 instead of the expected 202, after
11,049.23 ms. The backend used four parallel workers and reported 10,193
passed, two failed, and 10,282 total tests across 668 files in 225.87 seconds.
The other backend failure was the setup-terminal process-root timeout.
The root group also caught an intermediate, subsequently corrected ESM fixture
in the new private-TMPDIR integration test; that was an implementation error,
not a flake.

The complete unchanged owner passed alone (exit 0, 1.4 seconds):

```sh
mise run test:logged -- --name cold-dispatch-owner -- bun test --cwd apps/backend tests/claude-cold-dispatch-restart.test.ts --parallel=1 --only-failures
```

The aggregate failure evidence is in test-run artifact `orkestrator-test-run.ewImG3`
(`workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`).
Concurrent aggregate and browser work was active on the host. The failure is
consistent with delayed cold dispatch admission under load; its root cause is
not established. No production bridge behavior, assertion or deadline was changed.

The final exact `mise run test` rerun completed with this test passing in the
four-worker backend group (10,194 passed, one failed, 10,282 total). Its only
remaining failure was the setup-terminal timeout already present in preparation.
The root, bridge and protocol groups passed. Final artifact: `orkestrator-test-run.U0qClx`.

## Resolution (2026-11-10)

- **Status:** resolved, with
  [1308](1308-claude-cold-dispatch-resend-503.md), which has the full root
  cause and evidence.
- **Root cause:** the 503 was the restarted bridge's prompt claim timing out
  on a preference lock that the killed bridge had created but not yet named
  itself in. An ownerless lock is only recoverable once 30 s stale.
- **Fix:** `bridges/claude-bridge/src/services/session-preferences.ts`
  publishes every lock and recovery marker with its owner already in it
  (staging file plus hard link, `createOwnedFile`).
- **Reproduced:** yes — an empty lock left beside the preference file before
  the restart gives this test's exact 503; the new unit test fails on the old
  lock code with a self-killing writer and passes with the fix.
- **Stress:** 8 of 8 fresh-process runs of the owner under contention (see
  1308).
