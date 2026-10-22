# `Pi ACP background discovery > does not re-adopt a settled child's directory for the next unnamed launch` (`bridges/acp-bridge/src/acp-cursor-background.test.ts:1200`)

- **ID:** 0047
- **Status:** resolved
- **Date observed:** 2026-08-25
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran workspace, root/agent-support, bridges, and protocol-lockfile groups concurrently; the bridges group used two Bun workers.
- **Failure:** The lookup for the `cursor-subagent-2` transcript part returned `undefined`, so `toMatchObject({ agentState: "active" })` failed.
- **Suite counts:** complete suite: 14,821 passed, 13 skipped, 2 failed; bridges group: 2,892 passed, 11 skipped, 1 failed.
- **Isolated rerun:** `bun test bridges/acp-bridge/src/acp-cursor-background.test.ts --only-failures` → 34 passed, 0 failed, in 2.67 seconds.
- **Hypothesis:** The test confirms `working` activity with five immediate probes and then reads the transcript once. Child discovery and transcript projection are separate asynchronous updates, so aggregate bridge contention can expose `working` before the new child card has been projected. A recurrence should poll for the `cursor-subagent-2` part with the existing bounded diagnostic rather than weakening its required `active` state.
