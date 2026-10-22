# `ACP bridge > announces overflow when earlier stream chunks leave no room for the marker` (`bridges/acp-bridge/src/acp-http.test.ts:191`)

- **ID:** 0035
- **Status:** resolved
- **Date observed:** 2026-08-24
- **Original command:** `bun run test:logged -- --name final6 -- bun run test` (complete concurrent cross-platform suite)
- **Worker configuration:** `scripts/test-all.ts` ran the workspace, root/agent-support, bridges, and protocol-lockfile groups concurrently; the failure was inside the bridges group, 2,833 tests across 99 files in 68.71 s.
- **Failure:** `Timed out waiting for ACP state: false` thrown from `waitFor` in `acp-test-harness.ts:160`, reached through `spawnBridge` (`acp-test-harness.ts:212`) at `acp-http.test.ts:191` (duration: 15,004.97 ms). The failure is in the harness's bridge startup wait, not in the overflow assertion the case exists to make.
- **Suite counts:** bridges group — 2,821 passed, 11 skipped, 1 failed; 9,324 `expect()` calls.
- **Isolated rerun:** `bun test bridges/acp-bridge/src/acp-http.test.ts` → 6 passed, 0 failed, 40 `expect()` calls in 0.81 s.
- **Attribution:** observed while adding `bridges/cursor-bridge`, a separate package. The change touches no ACP bridge source, and the ACP suite's own files are unmodified, so the two share only host capacity.
- **Hypothesis:** `spawnBridge` boots a real bridge process plus a fake agent and polls it for readiness against a 15-second budget. The bridges group now starts one more package's processes alongside the existing ones, so under contention the spawn can miss that window while the bridge is still coming up — the `false` in the message is the readiness predicate never turning true, not a bad response. A recurrence should time the harness's spawn-to-healthy interval under load before widening the budget, since a genuine startup regression would look identical from the outside.
