# Voice chat slow-reply fixture is not started when released

- **ID:** 9927
- **Status:** resolved
- **Date observed:** 2026-11-10
- **Test:** `agent voice chat tools > a slow reply is heard later with listen`.
- **File:** `apps/backend/src/core/control-mcp/agent-voice-chat.test.ts:324`.
- **Observed base:** `60afa4b715bd465d441d28a4cb9a513928d2ccb8`.
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`.
- **Workers:** default aggregate plan; workspace group used six slots, root one,
  bridges two and protocol one.
- **Failure:** `TypeError: finish is not a function` at `finish("Nothing is failing.")`;
  duration 206.37 ms. Backend: 17,682 passed, 1 failed, 151 skipped across 1,211
  files (639.90 s). Web: 14,330 passed, 0 failed, 10 skipped across 984 files
  (485.34 s). Other aggregate groups passed; aggregate exit 1 (709.1 s).
- **Failure artifacts:**
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.OKeiWm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  and wrapper `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.BNpXlp/review-default-tests.log.gz`.
- **Owning-file rerun:** `mise run test:logged -- --name findings-voice-chat-alone -- bun test --cwd apps/backend ./src/core/control-mcp/agent-voice-chat.test.ts --parallel=1 --only-failures`
  passed unchanged (logged runner 5.5 s).
- **Hypothesis:** the test waits 20 ms for the reply, then invokes a resolver
  assigned only when the asynchronous reply handler starts. The pending answer
  establishes that the reply has not finished, but does not establish that the
  handler has started. The undefined callback demonstrates that readiness gap;
  no product cause has been established.
- **Scope:** this Notes-tab branch does not edit the voice chat owner or its test.
  It does edit the imported storage facade and pane-layout code, so the failure
  is left for verification rather than excused as unrelated solely from the pass.
  No assertion, budget, or product behavior was changed to hide it.

## Resolution (2026-11-15)

- **Root cause:** The test assigned the reply resolver only when the reply handler started, so a slow start left `finish` undefined. Commit `784094ec4` (2026-11-10) creates the resolver before the harness (`Promise.withResolvers`); the observed base `60afa4b71` predates it.
- **Fix:** Already fixed by `784094ec4`. Also, both `listen` calls that waited 1 s for a reply to settle now use the tool's maximum wait (`AGENT_VOICE_CHAT_LIMITS.waitMaxMs`); `listen` returns as soon as the reply settles, so this is a bound, not a sleep. `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only.
- **Reproduced:** no — the resolver gap is already gone in the current test. Under the contention runner the unchanged file, run as the second file of a non-isolated run (so on Bun's 5 s budget), timed out `a slow reply is heard later with listen` 3 of 5 times; the changed file passed 5 of 5 isolated under the same runner.
- **Stress:** `mise run test:logged -- --name repro-be-after -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --burners 6 -- bun test --preload ../../tests/setup-node.ts ./tests/commands-environment.test.ts ./src/core/control-mcp/agent-voice-chat.test.ts ./src/core/container-host-reachability.test.ts -t "pending rename|slow reply|cannot be written|remediation" --rerun-each=5 --parallel=1'` passed (every selected case 5 of 5) at host load about 80; the owners also passed in the wider contention runs of 2026-11-15.
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
