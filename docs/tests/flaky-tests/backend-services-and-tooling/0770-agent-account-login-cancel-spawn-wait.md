# Agent-account login cancellation misses its spawned child under load

- **ID:** 0770
- **Status:** resolved
- **Date observed:** 2026-10-24
- **Owner:** `apps/backend/src/core/agent-accounts.test.ts`
- **Test:** `agent accounts > cancellation during login startup still reaches the spawned process`
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test` on node mbp3 (todo 0038 branch rebased onto `a5d78cfcd`). The host load average was 27–30, with two other branches' full suites running at the same time.
- **Failure:** `expect(child).toBeDefined()` received `undefined` at line 296 (905.04 ms): the test polls for the spawned login child for at most 100 iterations of `Bun.sleep(1)` (about 100 ms) before asserting.
- **Complete unchanged owner rerun:** `mise run test:logged -- --name agent-accounts -- bun test --cwd apps/backend ./src/core/agent-accounts.test.ts` passed, exit 0 (3.2 s logged).
- **Evidence:** host temporary artifact `orkestrator-test-run.iAgzh8/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** the ~100 ms spawn wait is shorter than login startup under heavy host contention; the test and `agent-accounts.ts` arrived with `main` (#1213) and are untouched by this branch. No implementation, assertion, timeout or skip changed.
- **Other failures in the same aggregate:** the existing OpenCode CLI version mismatch (mbp3 has 1.19.4, the conformance test expects 1.19.0) and four `tests/unit/firewall-policy.test.ts` timeouts already tracked as 0192/0632.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** the bounded poll `for (let n = 0; n < 100 && !child; n += 1) await Bun.sleep(1);` is still at `agent-accounts.test.ts:296`. The failure took 905 ms, so all 100 sleeps ran out before the spawn. The owner passed alone today (38/38, 5.4 s; Bun 1.4.4).
- **Next step:** resolve a promise from `spawnImpl` and await it with a bounded deadline, instead of counting sleeps.

## Resolution (2026-11-10)

- **Root cause:** the test waited for the fake login child with a count of
  100 `Bun.sleep(1)` calls. `startAgentAccountLogin` loads the account store,
  prepares the account home and writes the browser shim before it spawns,
  and on a loaded host that took longer than the loop, so `child` was still
  `undefined`. Nothing in the product raced.
- **Fix:** `agent-accounts.test.ts` resolves a deferred from `spawnImpl` and
  waits for it, or for the start to settle without a spawn, with
  `Promise.race`; the assertion is unchanged.
- **Reproduced:** yes — with a temporary `await Bun.sleep(500)` before
  `beginAgentAccountLogin` in `agent-accounts.ts`, the unchanged test (a
  scratch copy of `HEAD`'s owner) failed with `expect(received).toBeDefined()
  / Received: undefined` (420.83 ms); the fixed test passed under the same
  delay (`bun test --preload ../../tests/setup-node.ts
  ./src/core/agent-accounts.test.ts -t "cancellation during login startup"`
  from `apps/backend`). The delay and the scratch copy were removed.
- **Stress:** `mise run test:logged -- --name fixed-accounts -- bun
  scripts/test-under-contention.ts -- bun test --cwd apps/backend --preload
  ../../tests/setup-node.ts ./src/core/agent-accounts.test.ts
  --rerun-each=5` passed (macOS, unpinned burners, host load ~35 to 55).
  A longer run, `mise run test:logged -- --name fixed-accounts-10 -- bun
  scripts/test-under-contention.ts -- bun test --cwd apps/backend --preload
  ../../tests/setup-node.ts ./src/core/agent-accounts.test.ts
  --rerun-each=10`, also passed.
