# Resolved: Cursor SDK mocks in a shared-process run (2026-09-10)

- **ID:** 0004
- **Status:** resolved
- **Original command:** `mise exec -- bun test bridges/cursor-bridge/src`
  (no worker isolation), 316 passed / 13 failed in 10.76 seconds.
- **Owners and failures:** `agent-session.test.ts`: `configures one JSONL store
  below the bridge state directory` received an empty constructor-call array;
  `rewindSessionHistory > uses the selected message run id instead of its bounded
  transcript position` reported no checkpoint; `ensureAgent > two concurrent
  callers share one attach` received a different store instance.
  `credentials.test.ts`: both stored-login `resolveCredential` cases, four
  `authStatus` cases, the `beginLogin` case, and the `runLogin` case used another
  suite's credential implementation. All eleven failed within 1 ms.
- **Isolated reruns:** `mise exec -- bun test
  bridges/cursor-bridge/src/agent-session.test.ts` passed 32 tests in 441 ms;
  `mise exec -- bun test bridges/cursor-bridge/src/credentials.test.ts` passed
  21 tests in 346 ms.
- **Root cause:** `agent-session.test.ts`, `credentials.test.ts`, and
  `initial-run.test.ts` each replaced `@cursor/sdk` process-wide. In a
  non-isolated directory run, whichever owner first evaluated the cached
  production singleton fixed its store and SDK bindings for later owners;
  later mock replacements then made the already-loaded owners observe a
  different suite's implementation.
- **Fix:** the credential, Agent, model, store, and platform surfaces now use
  explicit test injection. The three owners restore those dependencies after
  their suite and no longer call `mock.module("@cursor/sdk")`, so module-cache
  order cannot select another owner's fake.
- **Additional deterministic fix:** two diagnostics assertions came from the
  inherited `ORKESTRATOR_BRIDGE_DEBUG=1`, which intentionally overrides the
  provider-specific flag those tests changed. The owner now saves, controls,
  and restores the effective global flag; it passes all eight cases with the
  inherited flag still set. These failures were environmental, not flakes.
- **Verification:** the original shared-process shape, `env -u
  ORKESTRATOR_BRIDGE_DEBUG mise exec -- bun test bridges/cursor-bridge/src
  --only-failures`, now passes 342 tests across all 17 owners in 10.18 seconds.
  The three affected owners also pass 70 tests with `--parallel=3` in 8.55
  seconds. No assertion was removed or relaxed.
- **Aggregate-environment hardening:** the runner also removes global and
  provider-specific bridge diagnostic flags from every child environment, so a
  live development profile cannot alter the authoritative suite's assertion
  inputs. Before the dependency-injection fix, `env -u
  ORKESTRATOR_BRIDGE_DEBUG mise exec -- bun test
  ./bridges/cursor-bridge/src --parallel=4` passed 329 tests across all 17
  owners in 8.96 seconds.
