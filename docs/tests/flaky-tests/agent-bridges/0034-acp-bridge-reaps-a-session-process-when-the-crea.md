# `ACP bridge > reaps a session process when the creating HTTP client disconnects` (`bridges/acp-bridge/src/acp-http.test.ts`)

- **ID:** 0034
- **Status:** resolved
- **Date observed:** 2026-08-25
- **Original command:** `bun run test` (complete concurrent cross-platform
  suite).
- **Worker configuration:** `scripts/test-all.ts` ran the workspace,
  root/agent-support, bridges, and protocol-lockfile groups concurrently; this
  failed in the bridges group.
- **Failure:** `Timed out waiting for ACP state: ""` from
  `acp-test-harness.ts:160` after 5,054.57 ms.
- **Suite counts:** bridges group — 3,111 passed, 11 skipped, 2 failed; 3,124
  tests across 115 files in 60.65 s.
- **Isolated rerun:** `bun test ./src/acp-http.test.ts` from
  `bridges/acp-bridge` -> 6 passed, 0 failed, 40 `expect()` calls in 0.519 s;
  the target passed in 68.36 ms.
- **Hypothesis:** the case waits for a real bridge child process to observe the
  disconnected creator and reap its session. Its isolated runtime is two
  orders of magnitude below the fixed aggregate deadline, while the sibling
  reservation test failed at the same five-second boundary in the same run.
  This was initially consistent with group-level process starvation.
- **Recurrence (setup-terminal retry-loop fix, 2026-08-25):** the same test
  timed out after 5,049.72 ms in a `bun run test` bridges group with 3,111
  passed, 11 skipped, and 2 failed across 115 files. The isolated rerun
  `bun test ./src/acp-http.test.ts ./src/acp-server.test.ts --only-failures`
  from `bridges/acp-bridge` -> 15 passed, 0 failed, 68 `expect()` calls in 1.23
  s.
- **Bun 1.4 reproduction:** `bun test bridges/acp-bridge/src/acp-http.test.ts`
  reproduced the timeout in isolation at 5,043.46 ms (5 passed, 1 failed).
- **Root cause:** the repository preload replaces the Web APIs with Happy DOM's
  implementations. This test passed a Happy DOM `AbortSignal` to `Bun.fetch`;
  Bun 1.4 validates the signal's native brand, rejects before sending the
  request, and leaves the lifecycle-file wait polling an empty file until
  timeout.
- **Fix:** preserve Bun's native fetch and abort constructors before Happy DOM
  registration, then use that matched pair for the aborting ACP integration
  request.
- **Verification:** `bun test bridges/acp-bridge/src/acp-http.test.ts` passed 6
  tests with 40 assertions in 589 ms under Bun 1.4.0. The subsequent complete
  `bun run test` passed all four concurrent groups in 87.3 s.
- **Recurrence (recurring-processes step 10, 2026-09-25):** failed with the
  same `Timed out waiting for ACP state: ""` in two ways, neither the fixed
  Happy DOM signal defect. (1) Deterministically when run from inside an
  Orkestrator agent environment: the spawned bridge inherits the ambient
  `ORKESTRATOR_AGENT_MCP_URL`/`ORKESTRATOR_AGENT_MCP_TOKEN`/
  `ORKESTRATOR_PARENT_PID`, and the fake agent never starts. It fails the same
  way against the unmodified `acp-server.ts`; with those variables unset it
  passes alone in 1.2 s. The harness does not scrub them. (2) Once in a
  `--parallel=2` bridge run with the variables unset, at host load average
  35–41, and not in a later identical run; the file passed alone.
  It failed the same way again in the bridges group of `mise run test:changed`
  (variables unset; acp-bridge 408 passed, 1 failed), and
  `bun test ./src/acp-http.test.ts` then passed alone. In every failure the
  wait that expired is the one for the fake agent's `start:` line, which comes
  *before* the client disconnects, so the disconnect-detection change is not
  on the failing path.


## Main merge recurrence — 2026-10-18

- **Command:** `mise run test:logged -- --name merge-15f6cd-acp-rerun -- bun run --cwd bridges/acp-bridge test:bridge` after the full suite's ACP package stalled. Package used one isolated Bun worker.
- **Failure:** `Timed out waiting for ACP state: ""` after 6208.18 ms. ACP reported 622 passed, 3 skipped and 2 failed across 627 tests in 328.01 seconds.
- **Other failure:** the generalization hook timeout recorded in 0219.
- **Owning-file rerun:** `mise run test:logged -- --name merge-15f6cd-acp-owners -- bun test --cwd bridges/acp-bridge ./src/acp-http.test.ts ./src/acp-generalization.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 6.6 seconds.
- **Evidence:** `orkestrator-test-run.KPQz1y/merge-15f6cd-acp-rerun.log.gz` below the host temporary directory.
- **Disposition:** reopened as an intermittent recurrence; no source, assertion, timeout or skip changed. The older Happy DOM diagnosis is retained as history, not asserted for this observation.

## Review-fix validation recurrence — 2026-10-23

- **Command:** `mise run test:logged -- --name review-focused -- bun test ./bridges/acp-bridge/src/acp-http.test.ts ./bridges/cursor-bridge/src/models.test.ts ./bridges/codex-bridge/src/engine/app-server-tool-history.test.ts ./bridges/codex-bridge/src/engine/app-server-engine.test.ts ./bridges/claude-bridge/src/routes/session-selection-pricing.test.ts --parallel=4 --only-failures`.
- **Failure:** the existing disconnect test timed out waiting for the fake
  agent's `start:` line (`Timed out waiting for ACP state: ""`, 5256.87 ms).
  The focused run reported 292 passed and 1 failed in 15.8 seconds; all new
  regression cases passed.
- **Owning-file rerun:** `mise run test:logged -- --name acp-http-isolated -- bun test ./bridges/acp-bridge/src/acp-http.test.ts --parallel=1 --only-failures`
  passed unchanged in 9.4 seconds.
- **Evidence:** `orkestrator-test-run.txlhBC/review-focused.log.gz` below the
  host temporary directory.
- **Disposition:** existing intermittent failure; no assertion, timeout, skip,
  or production disconnect behavior changed.

## Resolution (2026-11-15)

- **Root cause:** a test race, not a disconnect defect. The test set
  `ACP_RPC_TIMEOUT_MS: "100"`, and the bridge starts that timer when it sends
  `initialize` right after spawning the fake agent. When the fake agent's
  module graph took longer than 100 ms to load (a loaded host), the bridge
  timed out `initialize` and killed the agent before it appended `start:`,
  so the wait for `start:` read an empty file until its deadline: the recorded
  `Timed out waiting for ACP state: ""`. The 100 ms timeout also meant the RPC
  timeout, not the client disconnect, could reap the session. Separately, the
  harness passed the ambient `ORKESTRATOR_AGENT_MCP_URL`/`_TOKEN` and the
  backend's `ORKESTRATOR_PARENT_PID` to every test bridge (the 2026-09-25
  recurrence's deterministic failure inside an agent environment).
- **Fix:** `bridges/acp-bridge/src/acp-http.test.ts` sets the RPC timeout to
  one hour, so the client disconnect is the only way the hung session can be
  reaped and the `start:` wait always ends on the agent's own line.
  `bridges/acp-bridge/src/acp-test-harness.ts` (`spawnBridge`) removes the
  agent MCP variables and points `ORKESTRATOR_PARENT_PID` at the test process,
  and its waits are hang watchdogs on real signals: 60 s per state wait, 90 s
  for the child's own `server.listening` line, 180 s per test.
- **Reproduced:** yes. A temporary `Bun.sleepSync(500)` before the fake agent
  writes `start:` (`testing/fake-agent-context.ts`) made the unchanged test
  fail with `Timed out waiting for ACP state: ""`. With the fix and the same
  injected delay it passed 3 of 3 (`--rerun-each=3`). Contention alone
  (6 burners, `--rerun-each=5`) did not reproduce it with the old value.
- **Stress:** `mise run test:logged -- --name stress-acp-http-transcript -- bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts ./src/acp-http.test.ts ./src/acp-transcript.test.ts -t "reaps a session process|bounds an aggregate interactive transcript" --rerun-each=3`:
  this test passed 3 of 3. (The run's three failures were 9853's file, second
  in a non-isolated process, whose shared-bridge `beforeAll` got Bun's own 5 s
  budget; see the note in 0039.)
