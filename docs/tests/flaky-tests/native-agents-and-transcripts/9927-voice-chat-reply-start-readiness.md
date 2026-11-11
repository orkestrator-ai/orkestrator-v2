# Voice chat slow-reply fixture is not started when released

- **ID:** 9927
- **Status:** open
- **Date observed:** 2026-11-10
- **Test:** `agent voice chat tools > a slow reply is heard later with listen`.
- **File:** `apps/backend/src/core/control-mcp-agent-voice-chat.test.ts:324`.
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
- **Owning-file rerun:** `mise run test:logged -- --name findings-voice-chat-alone -- bun test --cwd apps/backend ./src/core/control-mcp-agent-voice-chat.test.ts --parallel=1 --only-failures`
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
