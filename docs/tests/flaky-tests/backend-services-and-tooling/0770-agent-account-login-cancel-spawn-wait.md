# Agent-account login cancellation misses its spawned child under load

- **ID:** 0770
- **Status:** open
- **Date observed:** 2026-10-24
- **Owner:** `apps/backend/src/core/agent-accounts.test.ts`
- **Test:** `agent accounts > cancellation during login startup still reaches the spawned process`
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test` on node mbp3 (todo 0038 branch rebased onto `a5d78cfcd`). The host load average was 27–30, with two other branches' full suites running at the same time.
- **Failure:** `expect(child).toBeDefined()` received `undefined` at line 296 (905.04 ms): the test polls for the spawned login child for at most 100 iterations of `Bun.sleep(1)` (about 100 ms) before asserting.
- **Complete unchanged owner rerun:** `mise run test:logged -- --name agent-accounts -- bun test --cwd apps/backend ./src/core/agent-accounts.test.ts` passed, exit 0 (3.2 s logged).
- **Evidence:** host temporary artifact `orkestrator-test-run.iAgzh8/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** the ~100 ms spawn wait is shorter than login startup under heavy host contention; the test and `agent-accounts.ts` arrived with `main` (#1213) and are untouched by this branch. No implementation, assertion, timeout or skip changed.
- **Other failures in the same aggregate:** the existing OpenCode CLI version mismatch (mbp3 has 1.19.4, the conformance test expects 1.19.0) and four `tests/unit/firewall-policy.test.ts` timeouts already tracked as 0192/0632.
