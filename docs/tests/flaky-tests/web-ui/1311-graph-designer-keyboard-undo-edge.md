# Graphs designer builds the design bake-off on the canvas, compiles it clean and saves it

- **ID:** 1311
- **Status:** open
- **Date observed:** 2026-10-29
- **Test:** `Graphs designer builds the design bake-off on the canvas, compiles it clean and saves it`
- **File:** `e2e/agent-testing/graph-designer-editing.spec.ts:223`
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=graphs-213 ORKESTRATOR_AGENT_TEST_RUN_ID=graphs-213 mise run test:logged -- --name graphs-213-designer-e2e -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts graph-designer.spec.ts graph-designer-editing.spec.ts --workers=1`, against an isolated `dev:test --fixture --no-agent-credentials --agent-platforms codex` profile, run right after `graph-designer-mock.spec.ts` on the same profile (branch `graphs-213-mock`, item 213).
- **Failure:** After Control+Z the canvas still showed the same edge count (`expect.poll(draftEdgeCount).toBe(withBriefs - 1)`: expected 1, received 2) within the five-second poll.
- **Suite counts:** one passed (`graph-designer.spec.ts`), one failed.
- **Isolated rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=graphs-213 ORKESTRATOR_AGENT_TEST_RUN_ID=graphs-213 mise run test:logged -- --name graphs-213-editing-e2e -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts graph-designer-editing.spec.ts --workers=1` passed the complete unchanged owning file (17.7 s) on the same profile.
- **Evidence:** `orkestrator-test-run.rkSCrN` below the host temporary directory; artifacts under `output/agent-testing/graphs-213/browser/artifacts/` (not committed).
- **Hypothesis:** The window-level undo shortcut only acts when the key event's target is inside the designer or the document body; right after the "Connect to…" dialog closes, focus may still be in transit, so the keypress is ignored. Not confirmed; no assertion, timeout or skip changed.

- **Recurrence (2026-10-30):** The experimental-graphs review preparation
  repeated the same edge-count failure. Explicitly focusing the designer's
  Connect button before Undo passed once in the complete isolated suite and
  once in the focused graph-spec run, but the next complete isolated run
  failed the same assertion even after `toBeFocused()` passed. Focus alone
  therefore does not establish the cause; that attempted test change was
  reverted. The assertions and timeout remain unchanged. Evidence:
  `orkestrator-test-run.ukaJle/isolated-browser-final.log.gz` under the host
  temporary directory and
  `output/agent-testing/qa-browser-733773a3-88d/browser/artifacts/`.

- **Recurrence (2026-11-03):** The environment-terminology branch
  (`rename-environment-kinds-fbee095fc40a-r1` at `804d5c74e`) failed the
  same edge-count assertion (expected 1, received 2) in
  `mise run test:agent:browser:isolated` during review preparation
  (`output/agent-testing/qa-browser-95759210-821/`, 44 passed, 3 failed,
  94 skipped). The unchanged spec then passed with `--workers=1
  --retries=0` against a fresh disposable `dev:test --fixture` profile, both
  on that branch and on a detached `origin/main` at `b0dcf1660`, run
  together with `graph-designer.spec.ts` and `graph-run-view.spec.ts`
  (4 passed, 2 failed, 1 skipped on each; the two failures are tracked in
  to-do 2922, task 4). The branch changes no graph code.


## Background-message recovery review — 2026-11-05

On `49f025562`, the unchanged graph editing case failed keyboard undo at
`graph-designer-editing.spec.ts:227` (expected one edge, received two after the
5-second poll). The broad run used one worker and credential-free profile
`review-refusal-recovery`:

```sh
ORKESTRATOR_AGENT_TEST_PROFILE=review-refusal-recovery ORKESTRATOR_AGENT_TEST_RUN_ID=review-refusal-recovery mise run test:logged -- --name repair-browser -- mise run test:agent:browser
```

The run was intentionally interrupted for narrower validation: 34 passed,
3 failed, 50 skipped, 1 interrupted, 58 not run (563.6 seconds).
Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.LOCmhO/repair-browser.log.gz`.

After restarting the profile for the committed source fingerprint, the complete
unchanged owner passed alone (one worker, 19.8 seconds):

```sh
ORKESTRATOR_AGENT_TEST_PROFILE=review-refusal-recovery ORKESTRATOR_AGENT_TEST_RUN_ID=refusal-graph-owner mise run test:logged -- --name repair-graph-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/graph-designer-editing.spec.ts
```

Artifacts: `output/agent-testing/refusal-graph-owner/browser/`.
No graph implementation, assertion, timeout or skip was changed; the cause
remains unconfirmed.

## Recurrence, beelink, 2026-11-06

In run 6 of the to-do 4222 task 3 qualification (`mise run test:agent:browser:isolated`,
credential-free Codex profile, branch based on `main` at `e6c3da899`, one worker,
load average about 60, with this work's Docker network churn), the case failed at a new
step: `expect(locator).toHaveText("QA design bake-off")` on
`[data-graph-designer] [data-graph-designer-title]` (line 363), element not found after
5 s. Its trace has no `net::ERR_NETWORK_CHANGED`, so it is not flake 2340. The same case
passed in the other six full runs of the suite that night (runs 1 to 5 and 7). It was not
rerun alone. The cause remains unconfirmed.

## Recurrence, dead-code removal review (7571), 2026-11-13

Branch `remove-dead-bridge-be98778b92d1-r1` (base `17d28238c`, head
`c89a22b10`) failed the case at a new step in review preparation's
`mise run test:agent:browser:isolated`: line 311 expected acknowledgement
buttons for both `build` and `pr` but received only `build`. A teardown
`ArtifactBoundError` then followed, because the failure's `trace.zip` exceeded
the 64 MiB sanitization limit. The address stage reproduced it with the
complete unchanged owner alone (one worker) on a disposable credential-free
profile:

```sh
NODE_ENV= mise run dev:test --profile graph-ack-7571 --fixture --headless --no-agent-credentials --agent-platforms codex
NODE_ENV= ORKESTRATOR_AGENT_TEST_PROFILE=graph-ack-7571 ORKESTRATOR_AGENT_TEST_RUN_ID=graph-ack-7571-b bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/graph-designer-editing.spec.ts --workers=1
```

Three runs of that command on head `bbac0b251` gave pass (22.5 s), fail and
pass (21.8 s); the failure had the same trace-size error. The failed run's
`04-taint-pending.png` shows compile reporting `input-unbound
describe-pr.brief` ("nothing feeds it"). So one canvas connection, probably
`approve|outlet:approved` → `describe-pr|in:brief` at line 288, did not land,
and no taint reached `pr`. This is the same family as the undo symptom above:
a canvas edge gesture that silently has no effect. The branch changes no graph
designer, canvas or graph compiler code. No assertion, timeout or skip was
changed. Artifacts: `output/agent-testing/graph-ack-7571-b/browser/` (not
committed).
