# OpenCode agent-tool background reconcile still pending after 150 ms

- **ID:** 0320
- **Status:** resolved
- **Date observed:** 2026-10-17
- **File:** `apps/backend/src/core/commands-agent-tools.test.ts` (removed with OpenCode 1.x on 2026-11-11; `git show 5f4e27b1c:apps/backend/src/core/commands-agent-tools.test.ts`).
- **Test:** `OpenCode agent-tool configuration > reconciles in the background and memoizes a healthy generation`.
- **Original command:** `mise run test` on a shared 18-slot host (other environments held every slot at start; workspace/root/bridges/protocol reserved 4/1/2/1), with an isolated `dev:test` profile running a live Grok check.
- **Failure:** after a real `setTimeout(150)` (line 173), `__testing.openCodeAgentToolsConfigurationCount()` was still 1, not 0 (line 174), at 174.00 ms. The background reconcile had not settled within the fixed wait.
- **Suite result:** backend reported four failures; the other three were known five-second timeouts (0162, 0165, 0211). Bridges and protocol passed; root had the Pi staging timeout (0178).
- **Owning-file rerun:** `bun test src/core/commands-agent-tools.test.ts` (from `apps/backend`) passed unchanged: 20 passed in 2.44 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.ZPvgI1/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Assessment:** the case waits on a real 150 ms timer for background work, which the testing guide's controlled-timer rule forbids; under host load the reconcile can take longer. A fix would await the reconcile (or drive it with a controlled clock) instead of sleeping. The change under test (closing the session a resume replaces) does not touch agent-tool configuration. No implementation, assertion, timeout or skip changed.

## Local preview discovery review — 2026-10-25

`mise run test:logged -- --name preview-repository -- mise run test` repeated the fixed-wait failure at `commands-agent-tools.test.ts:195`: configuration count was one instead of zero after the 150 ms wait (212.06 ms test duration). The backend used two isolated Bun workers alongside other repository/browser validation on the shared host. The complete unchanged owner passed separately with `mise run test:logged -- --name preview-agent-tools-owner -- bun test --cwd apps/backend ./src/core/commands-agent-tools.test.ts --parallel=1 --only-failures` (exit 0, 2.2 s). No agent-tool implementation, assertion, wait, or skip changed. Evidence: `orkestrator-test-run.0vNQwf/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.

## Pending rename review — 2026-10-28

Preparation's `mise run test` repeated the count-one failure at line 195 (181.76 ms). Evidence: `.orkestrator/review-artifacts/review-validation-fabbd29e-2cbf-4f6a-94fa-442f4bb48d78/validation-07.stdout.txt`. The unchanged owner passed with `mise run test:logged -- --name recorded-failure-owners -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/change-tracking/measurement-retention.test.ts ./src/core/commands-agent-tools.test.ts --parallel=1 --only-failures`; after batching the retention fixture, both files passed (26 tests, 5.3 s). No agent-tool implementation, assertion, wait, timeout or skip changed.

## Todo 0732 main merge — 2026-10-28

`mise run test:logged -- --name merge-default-tests -- mise run test`
merged `d3842173e` into `f521032b1`. Default workspace/root/bridges/protocol
workers were 6/1/2/1; host admission queued the groups for about 389 s.
The backend reported 9,967 pass, 87 skip and two failures across 656 files
(322.08 s). Root, bridges, protocol and the other workspace packages passed;
the aggregate remained non-green (927.4 s including admission).
Evidence: `orkestrator-test-run.LxnFHE/summary.json` and
`workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
under the host temporary directory; outer logged-run artifacts are in
`orkestrator-test-run.cjGI8A`.

The background reconcile count remained one instead of zero at line 195
(213.03 ms). The complete unchanged owner passed with
`mise run test:logged -- --name merge-agent-tools-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-agent-tools.test.ts --parallel=1 --only-failures`
(exit 0, 3.4 s). This repeats the fixed-wait race above; no agent-tool
implementation, assertion, timeout or skip changed.

## PR auto-merge branch — 2026-10-31

- **Original command:** `mise run test:logged -- --name backend-workspace -- bun run --cwd apps/backend test:workspace` (two workers), on branch `auto-merge-toggle-811626194e15-r1`.
- **Failure:** `expect(agentTools().configurationCount()).toBe(0)` at `commands-agent-tools.test.ts:195` received a non-zero count (193.16 ms). Backend package: 11,794 tests across 805 files, two failures (this case, plus `session-title-runners.test.ts`, which needs the pinned `binaries/codex` this worktree does not have).
- **Complete unchanged owner:** `mise run test:logged -- --name agent-tools-alone -- bun --cwd=apps/backend test --preload ../../tests/setup-node.ts ./src/core/commands-agent-tools.test.ts --parallel=1` passed (2.6 s).
- **Evidence:** `orkestrator-test-run.aPuQa7` below the host temporary directory.
- **Assessment:** confirms recurrence. The branch does not touch agent-tool configuration; nothing changed in the test.


## Safe error formatting second review — 2026-11-02

Preparation ran `mise run test` at `de952cc0accc820c6d57425323428cc993794a54`.
The backend used three isolated workers and reported 13,006 passed, 97 skipped,
and five failed across 870 files (440.83 s). Original evidence is preserved at
`.orkestrator/review-artifacts/review-validation-b03e0cc0-820a-4723-8d36-20d1666dfe82/validation-04.stdout.txt`.

This case observed configurationCount() remained one rather than zero at line 195 (194.70 ms).

The complete unchanged owner passed on the fix branch as part of
`mise run test:logged -- --name r5-round2-recorded-owners -- bun test --cwd apps/backend ./tests/container-readiness.test.ts ./src/core/commands-agent-tools.test.ts ./tests/codex-subagent-cards.test.ts ./src/core/nodes/node-files.test.ts ./src/core/design/browser-profiles.test.ts --parallel=1 --only-failures`
(exit zero, 14.2 s; passing per-file counts were not retained by the runner).

A detached `origin/main` worktree at `9dbd7f1cc9981789ab352056bea84a1007c99959`
used its own `mise exec -- bun install --frozen-lockfile` dependencies.
Its complete owner check was `mise run test:logged -- --name r5-round2-main-agent-tools -- bun test --cwd apps/backend ./src/core/commands-agent-tools.test.ts --parallel=1 --only-failures` (failed, 20 passed and one failed (3.9 s)).
Result: the identical line-195 assertion received one after the 150 ms wait. Failure evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.ozqrnq/`.

The same failure on main establishes independence from this branch. The owner
and implementation are unchanged relative to main. No assertion, delay, skip,
or unrelated implementation was changed; the existing flake remains open.

### Exact aggregate rerun outcome

`mise run test:logged -- --name r5-round2-default-suite -- mise run test`
finished with exit 1 (919.0 s, including about 663 s of admission wait).
Workspace, root and protocol groups passed. All five original backend assertion
failures passed in this run. The sole failing group was bridges: the Codex
catalogue disposal assertion recorded in case 0791. No root-cause fix to these
existing timing cases is claimed. Final status evidence is
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.kkqsTX/summary.json`;
compressed group logs are in that same directory. The enclosing log is
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.TLjndR/r5-round2-default-suite.log.gz`.


## Task 1202 review repair — 2026-11-02

Original command: `ORKESTRATOR_TEST_ALLOW_CONCURRENT=1 mise run test:logged -- --name address-default-suite-concurrent -- mise run test`, workspace/root/bridge/protocol grants 6/1/2/1.
Group evidence: `orkestrator-test-run.WXZCOJ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/`.

Aggregate saw configuration count 1 after 150 ms (173.90 ms). Complete branch owner repeated it (291.54 ms; 20 pass/1 fail, 8.5 s); complete detached-main owner at 38d55ee14 passed (8.5 s). No failure independence is claimed from a passing main run. Branch artifact v0aFCH.

The complete owner was rerun with `mise run test:logged -- --name address-opencode-tools-rerun -- bun test --cwd apps/backend ./src/core/commands-agent-tools.test.ts --parallel=1 --only-failures`. No implementation, assertion, wait, timeout or skip was changed. This recurrence remains open.

A bounded detached-main repeat reproduced the identical count assertion:
`mise run test:logged -- --name address-main-opencode-repeat -- bun test --cwd apps/backend ./src/core/commands-agent-tools.test.ts --parallel=1 --only-failures --test-name-pattern 'reconciles in the background' --rerun-each=20`
failed (19 pass/1 fail, 231.21 ms failing case, 9.0 s total). Main evidence:
`orkestrator-test-run.QsTCer/address-main-opencode-repeat.log.gz`.

Final aggregate counts: desktop 1,580 pass / 16 skip / 2 fail; backend
13,138 pass / 97 skip / 3 fail; web 11,230 pass / 10 skip / 7 fail; root
3,418 pass / 3 fail. Bridges and Codex protocol verification passed.
The aggregate exited 1 after 1,152.1 seconds; no watchdog or output limit fired.

## Coordinator node-mail fixes — 2026-11-02

The unintended package-wide `mail-focused` invocation documented in case 2883 repeated the same count mismatch at 160.53 ms: expected 0, received 1 at commands-agent-tools.test.ts:195. That run used two workers and was stopped after 399.8 s, so it has no final suite counts. Artifact: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.573vpq/mail-focused.log.gz`.

The unchanged complete owner passed alone in 3.4 s with `mise run test:logged -- --name agent-tools-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-agent-tools.test.ts --parallel=1 --only-failures`. The implementation and fixed waits were unchanged. Status remains open.

## CI repair on main — 2026-11-03

`mise run test:logged -- --name full-suite-2 -- mise run test` on the CI-repair branch (rebased on `ee6208bad`, default worker grants) repeated the count mismatch at commands-agent-tools.test.ts:195 (expected 0, received 1; 220.21 ms). Backend 13,591 pass / 2 fail (the other is case 3101); web 11,517 pass / 0 fail; root, bridges and Codex protocol passed. The branch does not touch the owner or its implementation.

The unchanged owner passed alone three times in a row (2.0 s each) with `mise run test:logged -- --name oc-N -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-agent-tools.test.ts --parallel=1 --only-failures`. Status remains open.

## Gateway login batch — 2026-11-04

`mise run test` on the gateway login branch (based on `4e3caa079`, default worker grants, an iOS simulator build running at the same time) repeated the count mismatch at commands-agent-tools.test.ts:195 (expected 0, received 1; 224.80 ms). Backend 14,097 pass / 1 fail (this case); web 11,797, protocol 4,496, desktop 1,672, CLI 465, toolchain 126, web-public 41, root 3,529 and every bridge passed with no failures. The branch does not touch the owner or its implementation. Artifact: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.IsbJvf/`.

The unchanged owner passed alone three times in a row (2.2 to 2.5 s) with `mise run test:logged -- --name opencode-agent-tools-N -- bun --cwd=apps/backend test src/core/commands-agent-tools.test.ts --only-failures --parallel=1`. Status remains open.

### Resolution — 2026-11-06

- **Root cause:** the test slept a fixed 150 ms and then expected the background reconcile, whose fixture response is delayed 75 ms, to have finished. On a loaded host the response, the reconcile or the timer ran late. `schedule()` registers the cleanup that drops the in-flight entry (`task.finally`) before it chains the returned outcome (`task.then`), so the outcome promise settles only after the entry is gone. That promise is the completion signal the test should await.
- **Reproduced:** yes. With the fixture response delayed to 400 ms, the unchanged test failed with configuration count 1, not 0, as in the aggregate.
- **Fix:** `commands-agent-tools.test.ts` now awaits the outcome, then asserts zero configurations, one outcome and one request. The memoized second `schedule()` also awaits its returned promise instead of a 25 ms sleep, and it now also asserts that no reconcile was started. No assertion was removed and no product code changed.
- **Verification:** with the 400 ms delay (temporary), the fixed test passed. `mise run test:logged -- --name n0320-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-agent-tools.test.ts --rerun-each=20` passed 420 tests with 0 failures.

## Test removed (2026-11-11)

Test removed with OpenCode 1.x (2026-11-11). No surviving test runs this case;
the resolution above stays as history.
