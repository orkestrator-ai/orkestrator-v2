# Coordinator adapters main merge validation

- **ID:** 0724
- **Status:** environmental
- **Date observed:** 2026-10-24
- **Merge parents:** feature `8e7b0149c2a3fcf881ea5a04eea0d5c9393d6125` and main `0014505caeed69395b3cc996dd541fcc6df12c23`.
- **Common ancestor:** `a5d78cfcd54907a13973463d4bd08497fd025c90`.
- **Original command:** `ORKESTRATOR_TEST_AREA_BASE=$(git merge-base HEAD MERGE_HEAD) mise run test:logged -- --name merge-tests -- mise run test`.
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1; one root worker and two backend workers, Bun 1.4.3 on macOS arm64. Other worktrees were validating concurrently. One observed host load snapshot was 110.60/133.49/96.04; contention is a hypothesis, not a demonstrated root cause.

The complete original conflict list contained only
`docs/tests/flaky-tests/environments-and-containers/0192-firewall-bootstrap-shell-timeout.md`.
Both appended histories were retained in full. The original NUL-delimited
path list and merge parents were saved before staging in this worktree's Git
metadata under `merge-conflict-records/<ours>-<theirs>/`.
Validation assessed the whole combined delta from the common ancestor,
including automatically merged backend, bridge, protocol and renderer changes.
No source, assertions, deadlines or skips were changed during resolution or triage.

## Static checks and aggregate outcome

- `mise run test:logged -- --name merge-format -- mise run format:check`: passed.
- `mise run test:logged -- --name merge-lint -- mise run lint`: passed.
- `mise run test:logged -- --name merge-typecheck -- mise run typecheck`: passed.
- Codex protocol regeneration: passed.
- Root/support: 3,375 passed, eight failed across 3,383 tests; 1,063.0 s logged.
- The outer logged aggregate hit its 1,800-second deadline and terminated the remaining backend process tree (exit 1). The backend has no final counts; its two reported failures are listed below. Overall validation is incomplete.
- Completed workspace packages: web 9,336 passed / 10 skipped / six failed; CLI 225 passed / two failed; desktop 1,231 passed / 14 skipped; protocol 1,835 passed; public web 41 passed; toolchain 91 passed.
- Bridges ended incomplete after 516.3 s: no output for 300 seconds triggered the watchdog, which terminated ACP. Codex reported 2,308 passed / 40 skipped; Cursor 789 passed; Pi 606 passed / one skipped; Claude 1,608 passed / five skipped / two failed. ACP has no final counts.

## Failures and complete owning-file reruns

Every rerun used `mise run test:logged`, `--parallel=1` and `--only-failures`.
Root owners used `bun test ./<path>`. Web and backend owners used
`bun --cwd=apps/web test ./src/...` and `bun --cwd=apps/backend test ./src/...`.
CLI and Claude owners additionally named `--preload ../../tests/setup-node.ts`.
Labels were `merge-owner-<area>`, except `merge-claude-owner`,
`merge-firewall-owner` and `merge-artifact-engine-owner`.

| Owner | Aggregate failure and duration | Complete owner rerun |
| --- | --- | --- |
| `tests/unit/firewall-policy.test.ts` | container firewall policy > GitHub ranges come from a fresh backend seed, else live, else this container's cache [5008.03ms] | Failed alone: 21 passed, 3 failed (52.7 s). |
| `tests/unit/test-diagnostic-bounds.test.ts` | bounded test diagnostics > never passes a DOM-producing query result directly to toBeNull [30050.80ms] | Passed unchanged alone (28.9 s). |
| `tests/unit/runtime-env-wiring.test.ts` | container runtime environment wiring > Codex setup copies the complete allowlist, secures auth, and excludes plugin runtime state [5043.80ms] | Passed unchanged alone (16.0 s). |
| `tests/unit/disk-report.test.ts` | disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts [5031.08ms] | Passed unchanged alone (6.1 s). |
| `tests/unit/preview-latency-baseline.test.ts` | baseline orchestration > releases private-origin attachments after handoff failure (att-malformed) [579.40ms] | Failed alone: 26 passed, 1 failed (2.7 s). |
| `tests/unit/components/GitHubCloneIntegration.test.tsx` | GitHub picker to project registration > handles a missing destination through the real add_project handler [2487.49ms] | Passed unchanged alone (8.7 s). |
| `tests/unit/components/GitHubCloneIntegration.test.tsx` | GitHub picker to project registration > handles a empty destination through the real add_project handler [1893.61ms] | Passed unchanged alone (8.7 s). |
| `tests/unit/components/GitHubCloneIntegration.test.tsx` | emits exactly one error toast through useProjects after dialog unmount [1511.16ms] | Passed unchanged alone (8.7 s). |
| `apps/web/src/lib/chat/rich-markdown/incremental-parse.test.tsx` | incremental parse reuse > a long streamed answer parses each completed segment once [5335.24ms] | Passed unchanged alone (14.0 s). |
| `apps/web/src/hooks/useTerminal.test.tsx` | useTerminal reconnect behavior > cancels a queued reconciliation retry when the connection generation is disposed [473.19ms] | Passed unchanged alone (2.5 s). |
| `apps/web/src/App.test.tsx` | App Docker availability > polls every 60 seconds and disables then re-enables container functionality [1035.71ms] | Passed unchanged alone (9.4 s). |
| `apps/web/src/components/pull-requests/ProjectPullRequestsView.test.tsx` | project host opens, focuses, closes and restores tabs across projects [5133.64ms] | Passed unchanged alone (3.0 s). |
| `packages/cli/tests/fix-command.test.ts` | runFix > passes OpenCode its prompt flag and pinned environment [5003.35ms] | Passed unchanged alone (5.2 s). |
| `packages/cli/tests/client-waits.test.ts` | waiting through a lost submission response > submission and an absent-key lookup share one deadline [333.11ms] | Passed unchanged alone (7.5 s). |
| `apps/web/src/lib/transcript-scroll/transcript-scroll-controller.test.ts` | transcript reading ownership > one departure scroll captures a settled anchor and restores it across a width reflow [343.83ms] | Passed unchanged alone (0.5 s). |
| `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx` | AgentNativeTab commands > typing after the sigil filters a maximal list without fetching, refreshing or scanning [4449.79ms] | Passed unchanged alone (7.7 s). |
| `apps/backend/src/core/review-validation-worker.test.ts` | cooperative parallel groups do not multiply queue or execution deadlines [3639.61ms] | Passed unchanged alone (49.6 s). |
| `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts` | executable document policy in chromium > (unnamed) [5001.89ms] | Passed unchanged alone (122.9 s); unavailable Firefox/WebKit coverage remains skipped. |
| `bridges/claude-bridge/src/services/command-changes.test.ts` | Bash command change measurement > a denied call's window is closed and does not taint the next one [1012.04ms] | Passed unchanged alone (4.5 s). |
| `bridges/claude-bridge/src/services/command-changes.test.ts` | Bash command change measurement > an overlapping Edit marks the Bash measurement approximate [1003.60ms] | Passed unchanged alone (4.5 s). |

The fifteen unchanged owners that passed alone establish intermittent behavior
for their failures; the aggregate itself remains non-green. The firewall and
preview-latency owners also failed alone, so this run does not independently
confirm a flake for either. The preview owner failed `att-malformed` with
`get_preview_services: timed out` (138.29 ms). The firewall owner timed out
three different cases at the unchanged five-second deadline: stored domains,
policy 2 host ports, and policy 3 address/protocol/port tuples.

## Isolated browser limitation

`mise run test:logged -- --name merge-browser -- mise run test:agent:browser:isolated`
started profile `qa-browser-9b9620da-0a1` and reached test 56 of 83 before its
15-minute limit (926.1 s including startup and cleanup). It reported:

- `browser-gateway.spec.ts:2410`: narrow 390 px host-maintenance rehydration could not find the project-navigation button within five seconds.
- `design-canvas.spec.ts:13`: deep design-file selection did not reach the persisted pane layout within five seconds.

Both owners are unchanged by the merge delta. They were not rerun separately,
so neither is claimed as a confirmed flake here. The suite is incomplete,
not a successful browser qualification. The runner stopped and reset the
profile, removing its disposable state. Live-provider and Docker scenarios
remained opt-in; Firefox/WebKit were unavailable in the artifact-engine owner.

## Exact owner commands

```bash
mise run test:logged -- --name merge-owner-diagnostics -- bun test ./tests/unit/test-diagnostic-bounds.test.ts --parallel=1 --only-failures
mise run test:logged -- --name merge-owner-runtime-env -- bun test ./tests/unit/runtime-env-wiring.test.ts --parallel=1 --only-failures
mise run test:logged -- --name merge-owner-disk -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures
mise run test:logged -- --name merge-owner-preview-latency -- bun test ./tests/unit/preview-latency-baseline.test.ts --parallel=1 --only-failures
mise run test:logged -- --name merge-owner-github -- bun test ./tests/unit/components/GitHubCloneIntegration.test.tsx --parallel=1 --only-failures
mise run test:logged -- --name merge-owner-incremental -- bun --cwd=apps/web test ./src/lib/chat/rich-markdown/incremental-parse.test.tsx --parallel=1 --only-failures
mise run test:logged -- --name merge-owner-terminal -- bun --cwd=apps/web test ./src/hooks/useTerminal.test.tsx --parallel=1 --only-failures
mise run test:logged -- --name merge-owner-app -- bun --cwd=apps/web test ./src/App.test.tsx --parallel=1 --only-failures
mise run test:logged -- --name merge-owner-pull-requests -- bun --cwd=apps/web test ./src/components/pull-requests/ProjectPullRequestsView.test.tsx --parallel=1 --only-failures
mise run test:logged -- --name merge-owner-scroll -- bun --cwd=apps/web test ./src/lib/transcript-scroll/transcript-scroll-controller.test.ts --parallel=1 --only-failures
mise run test:logged -- --name merge-owner-commands -- bun --cwd=apps/web test ./src/components/native-agent/AgentNativeTab.commands.test.tsx --parallel=1 --only-failures
mise run test:logged -- --name merge-owner-cli-fix -- bun --cwd=packages/cli test --preload ../../tests/setup-node.ts ./tests/fix-command.test.ts --parallel=1 --only-failures
mise run test:logged -- --name merge-owner-cli-waits -- bun --cwd=packages/cli test --preload ../../tests/setup-node.ts ./tests/client-waits.test.ts --parallel=1 --only-failures
mise run test:logged -- --name merge-owner-review-worker -- bun --cwd=apps/backend test ./src/core/review-validation-worker.test.ts --parallel=1 --only-failures
mise run test:logged -- --name merge-claude-owner -- bun --cwd=bridges/claude-bridge test --preload ../../tests/setup-node.ts ./src/services/command-changes.test.ts --parallel=1 --only-failures
mise run test:logged -- --name merge-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures
mise run test:logged -- --name merge-artifact-engine-owner -- bun --cwd=apps/backend test ./src/core/transcript-artifacts/content-server.engines.test.ts --parallel=1 --only-failures
```

## Evidence

All run directories below are under the host temporary directory:

- Aggregate outer log: `orkestrator-test-run.hPr1g6/merge-tests.log.gz`.
- Aggregate group logs: `orkestrator-test-run.30brjq/*.log.gz` (partial workspace output retained after the outer deadline).
- Browser log: `orkestrator-test-run.GlXsEy/merge-browser.log.gz`.
- Firewall owner: `orkestrator-test-run.9YhRz5/merge-firewall-owner.log.gz`.
- Preview-latency owner: `orkestrator-test-run.x2F7SN/merge-owner-preview-latency.log.gz`.
- Sanitized browser artifacts: `output/agent-testing/qa-browser-9b9620da-0a1/browser/`.

Passing logs are removed by the logged runner. The exact owner rerun labels and
results above preserve their outcomes. Existing cases 0192, 0259, 0160, 0082,
0352, 0227, 0507 and the CLI deadline case 0692 carry related history.

## Triage 2026-10-25

Environmental: one load snapshot was 110.60/133.49/96.04 on 18 cores and the outer runner hit its 1,800-second deadline. Fifteen unchanged failing owners passed alone. The firewall owner's failures are the mbp3 host condition recorded in [0632](../environments-and-containers/0632-firewall-policy-probe-budget.md); preview latency is tracked in 0771.
