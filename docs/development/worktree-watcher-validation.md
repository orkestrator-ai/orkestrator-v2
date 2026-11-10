# Worktree-watcher validation evidence

Observed 2026-11-10 on macOS arm64, Bun 1.4.4 (`38afee6c8`), mise 2026.9.17. This records validation evidence, not a full-suite pass or a claim that unrelated failures are caused by the watcher change. The isolated-owner triage used no production profile, production credentials, production backend service or live agent.

## Snapshots and outcome

| Snapshot | Evidence |
| --- | --- |
| Captured review base | `8d0ae2764e0a5875144d15ee0f526608e6c1c1e8` (`origin/main` when review started); merge base `08d3da4a23cfe2ecc34fba663ca27e765f7924a9` is the recurrence-check base. Later ref movement does not change this scope. |
| Rollback commit | `ccf46a4d4ac5a967bd160bac655d84d5e1a7145f`, `chore(review): capture worktree watcher review snapshot`; clean empty rollback commit because work was already committed. |
| Coverage follow-up | `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`; original complete-command attempt and most isolated reruns below. |
| Corrected source | `8948619686981e7b237f879192ac6ffc86b227c6`; proof-readiness fixture repair, explicit initial-hint wait, and the affected retry-contract test correction. Three late unchanged-owner reruns use this head. |

The original aggregate exited **1** after **2468.77 s** (inner group orchestration 2467.4 s). Workspace failed/incomplete on the **no-progress watchdog**; backend supplied names but no final pass/fail/skip/error totals. Root and bridges completed non-green. The subsequent final-source aggregate attempt exited **75** on **capacity admission**, before any test group executed. No final-head full-suite pass is claimed.

## In-scope repairs and final verification

- Permission/coverage regressions were added at `310f4fd7a`.
- Real macOS ignore-proof tests previously raced fixture readiness; the delayed reproduction, repair and stress evidence live in [case 9919](../tests/flaky-tests/environments-and-containers/9919-worktree-watcher-ignore-proof-readiness.md).
- The new unreadable-child test's fixed delay was replaced with an explicit initial-plan hint wait, keeping initial unknown-path hint coalescing outside the asserted event. This removes the extra source-guard finding without raising its baseline.
- The affected older `diff-stats-service.test.ts` expected immediate qualified-coverage retry reset. Its corrected parameterized contract covers 0, `WATCHER_STABLE_MS - 1`, and `WATCHER_STABLE_MS`, retaining 60 s backoff before stability and returning to 30 s at the threshold.

### Supplied source-byte checks

These are the primary worker's observed results; the snapshot limitations are intentional.

| Command / label | Actual snapshot and result |
| --- | --- |
| `mise run test:logged -- --name watcher-budget-contract -- bun test --cwd apps/backend ./tests/diff-stats-service.test.ts ./src/core/worktree-snapshots.test.ts ./src/core/worktree-watcher-split.test.ts --parallel=1 --only-failures` | Passed 6.2 s in the isolated checkout while HEAD was `33faa9c5` and the retry-test correction was uncommitted. The source bytes became 894; this is **not immutable-894 evidence**. |
| `mise run test:logged -- --name watcher-retry-final-check -- mise run check` | Passed 26.5 s after 894 committed, in the isolated checkout. Format, lint and typechecking; passing raw logs removed. |
| `mise run test:logged -- --name watcher-retry-final-build -- mise run build` | Passed 8.7 s after 894 committed, in the isolated checkout. Passing raw logs removed. |
| `watcher-final-linux` | Passed 8.4 s at `33faa9c5`: Bun 1.4.4, Docker dev image `56a1f7a4d5a2`, uid 1000, network disabled/capabilities dropped, no credentials. Real-watcher source/dependencies stayed identical through 894. Exact canonical invocation/result remains pending below. |

### Canonical final committed snapshot — pending

After committing this report and the registry observations, the primary worker will write the observed immutable HEAD, exact commands/configuration, exit statuses, artifact paths and JUnit counts to the git-ignored receipt `output/agent-testing/watcher-final-verification.json`. That receipt and the completion transcript carry the post-report canonical outcomes; this committed report will not be edited to imply that its resulting HEAD was tested beforehand.

| Planned check | Status |
| --- | --- |
| `mise run check`, through `test:logged` | Pending; exact invocation and result belong in the receipt. |
| `mise run build`, through `test:logged` | Pending; exact invocation and result belong in the receipt. |
| Focused watcher/diff-stats owners plus source-guard and registry/claim checks, through `test:logged` with JUnit | Pending; exact file arguments and report paths belong in the receipt. |
| Credential-free Linux bundle/real-watcher qualification | Pending; exact build/run arguments, image, identity and result belong in the receipt. |

No result or SHA has been invented here. No further full-suite retry is planned after the failed/incomplete original run and the capacity-only final-source attempt.

## Aggregate commands, configuration and artifacts

1. `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=7200000 mise run test:logged -- --name coverage-full-final -- mise run test` at `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`: exit 1, 2468.77 s. Four default-tier groups; workspace six slots (web two/backend four), root one, bridges two, protocol one. The first groups waited about 797 s for capacity. The default tier excludes slow files; tests are not release/iOS/live-agent/browser qualification.
2. `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=7200000 mise run test:logged -- --name coverage-complete-head -- mise run test`: the queued orchestration began earlier, but the primary worker verified no group admission before clean `8948619686981e7b237f879192ac6ffc86b227c6` was captured. All four groups returned infrastructure status 75, outputBytes=0, after approximately 1800 s admission wait; outer duration 1803.3 s. The supplied outer watchdog was two hours and did not extend the separate 30-minute capacity wait. **No tests ran.**

The aggregate sanitizes inherited bridge diagnostic flags, `NODE_ENV`, and stamped build commit before its groups; owner reruns below use the repository-pinned runtime and normal package preloads, with no extra environment overrides. All owner reruns use one isolated worker and retain a JUnit report. No identical aggregate command was rerun at an unchanged head.

| Evidence | Path |
| --- | --- |
| Original outer | `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.LbfszS/coverage-full-final.log.gz` and `summary.json` |
| Original groups | `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.dH765N/*.log.gz` and `summary.json` |
| Final-source capacity-only outer | `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.zFdHur/coverage-complete-head.log.gz` |
| Final-source capacity-only groups | `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.CUMovT/summary.json` (all four status 75, zero output bytes) |
| Isolated owner reports | `/private/tmp/ork-watcher-failure-triage.0oarZv/*.xml`; machine-readable commands/results in `rerun-results.json`; available original rows in `original-aggregate-final.json` |

Private temporary artifacts are bounded retained evidence, not committed fixtures. Passing logged raw output was deleted; JUnit, not guessed totals, supplies isolated counts. No skip/todo count is invented where a runner did not report one.

## Original aggregate package results

| Group/package | Pass | Skip | Fail | Execution / status |
| --- | ---: | ---: | ---: | --- |
| Root and agent support | 4274 | 25 | 4 | 4303 tests / 235 files; 1215.05 s |
| Web | 14336 | 10 | 2 | 14348 tests / 984 files; 1247.22 s |
| Backend | not reported | not reported | not reported | Named failures below; workspace no-progress watchdog; no closing counts |
| Protocol | 5776 | 2 | 0 | 5778 tests / 319 files; 56.77 s |
| Desktop | 2011 | 16 | 0 | 2027 tests / 135 files; 58.51 s |
| Web-public | 41 | not reported | 0 | 41 tests / 4 files; 3.04 s |
| Toolchain | 137 | not reported | 0 | 137 tests / 5 files; 9.29 s |
| CLI | 516 | 2 | 0 | 518 tests / 36 files; 31.80 s |
| Codex bridge | 2427 | 63 | 0 | 2490 tests / 117 files; 56.23 s |
| Pi bridge | 706 | 1 | 2 | 709 tests / 48 files; 60.33 s |
| Cursor bridge | 900 | not reported | 0 | 900 tests / 55 files; 70.49 s |
| Claude bridge | 1896 | 9 | 0 | 1905 tests / 101 files; 74.89 s |
| ACP bridge | 557 | 3 | 0 | 560 tests / 54 files; 129.99 s |
| Codex protocol lockfile | — | — | — | Passed; committed generated artifacts match the pinned binary |

## Every distinct available aggregate failure name

Repeated output and unexpanded parameter labels are preserved as names, not interpreted as a backend test total. The raw stream has 79 distinct failure output rows across 34 package/files; the table deduplicates identical names and lists reported durations. This does not hide the two Pi parameter rows or assert how many repeated backend lines represent distinct parameter rows.

| File | Actual test name | Reported failure / message | Observed duration(s), ms |
| --- | --- | --- | --- |
| `tests/unit/firewall-egress-filter.test.ts` | init-firewall.sh with name checks > redirects TCP to allowed tuples and every DNS query to the daemon, and lets only marked traffic leave | Test deadline 30,000 ms exceeded. | 30439.41 |
| `tests/unit/firewall-egress-filter.test.ts` | init-firewall.sh with name checks > the daemon counts refusals beside the report, and the boot's own checks are not counted | Test deadline 30,000 ms exceeded. | 30437.33 |
| `tests/unit/source-guards.test.ts` | source guards over the repository > no file has more findings than the baseline allows, and the baseline is not stale | sleep-before-negative-assertion: watcher split test has 4 findings; baseline allows 3 (lines 415, 591, 634, 657). | 18039.97 |
| `e2e/agent-testing/container-fake-claude-install.test.ts` | interrupted install followed by another install keeps the first backup | Test deadline 5,000 ms exceeded. | 5035.05 |
| `apps/backend/src/core/coordinator-mail-attachments.test.ts` | send_message with attachments, to an environment on this node > a retry with the same requestId neither delivers nor copies again | Test deadline 5,000 ms exceeded. | 5088.10 |
| `apps/backend/src/core/user-commands.test.ts` | interactive commands > cancel stops the whole command and clears its prompt | Test deadline 5,000 ms exceeded. | 8595.58 |
| `apps/backend/src/core/user-commands.test.ts` | interactive commands > no more than four commands run at once in one tab | Test deadline 5,000 ms exceeded. | 8916.39 |
| `apps/backend/src/core/nodes/node-seed-worktree.test.ts` | FL-03/FL-04/FL-05 seed files in a leaf environment's worktree > without a seed copy a missing selected file still fails as before | Test deadline 5,000 ms exceeded. | 5027.12 |
| `apps/backend/src/core/nodes/node-seed-worktree.test.ts` | command-only selected seed files reach a worktree with an empty leaf selection | Test deadline 5,000 ms exceeded. | 5011.19 |
| `apps/backend/src/core/coordinator-status-wakes-pr.test.ts` | pull request status wakes > a PR wakes once per state change until merge (hidden: %s) | Test deadline 5,000 ms exceeded. | 5007.84 |
| `apps/backend/tests/agent-mail-store-size-bench.test.ts` | agent mail store size benchmark > rejects malformed, empty, missing and nonpositive sizes | Test deadline 5,000 ms exceeded. | 5002.03 |
| `apps/backend/src/core/coordinator-status-wakes-pr.test.ts` | pull request status wakes > a state that recurs after a fix wakes again; re-observing one episode does not | Test deadline 5,000 ms exceeded. | 5007.16 |
| `apps/backend/src/core/coordinator-status-wakes-pr.test.ts` | pull request status wakes > Merge and Cleanup: a merge recorded just before the worker is deleted still wakes once | Test deadline 5,000 ms exceeded. | 5007.90 |
| `apps/backend/src/core/coordinator-status-wakes-pr.test.ts` | pull request status wakes > a follow that already ended still records the merge when its worker is deleted | Test deadline 5,000 ms exceeded. | 5038.32 |
| `apps/backend/tests/claude-state-signal-integration.test.ts` | hook writers serialize counters and retain a completed turn without any config | Test deadline 5,000 ms exceeded. | 5001.87 |
| `apps/backend/tests/commands-container-exec.test.ts` | Electron backend command registry > gives an image without the helper the token-bearing rewrite, idempotently | Test deadline 5,000 ms exceeded. | 5002.52 |
| `apps/backend/tests/commands-container-exec.test.ts` | Electron backend command registry > GitHub credential helper > answers Git from the token file and keeps the token out of the config | Test deadline 5,000 ms exceeded. | 5259.27 |
| `apps/backend/tests/commands-container-exec.test.ts` | Electron backend command registry > GitHub credential helper > never hands the token to another host or over plain HTTP | Test deadline 5,000 ms exceeded. | 5152.94 |
| `apps/backend/tests/commands-container-exec.test.ts` | Electron backend command registry > GitHub credential helper > an empty token removes the helper and the SSH rewrite | Test deadline 5,000 ms exceeded. | 5013.03 |
| `apps/backend/tests/commands-container-exec.test.ts` | Electron backend command registry > GitHub credential helper > the fixture is not answered by the runner's checkout or environment | Test deadline 5,000 ms exceeded. | 6692.15 |
| `apps/backend/tests/commands-container-exec.test.ts` | Electron backend command registry > GitHub credential helper > removes a token-bearing rewrite an older image or backend left behind | Test deadline 5,000 ms exceeded. | 5010.37 |
| `apps/backend/tests/commands-container-exec.test.ts` | Electron backend command registry > GitHub credential helper > keeps working after setup clears credential.helper, on either order | Test deadline 5,000 ms exceeded. | 5010.00 |
| `apps/backend/tests/commands-container-exec.test.ts` | Electron backend command registry > GitHub credential helper > replaces a GitHub helper copied from a host config | Test deadline 5,000 ms exceeded. | 5883.06 |
| `apps/backend/src/core/change-tracking/acceptance-storage.test.ts` | acceptance: storage durability, retention and representation > H11: crashes around object publication, ledger commit and outbox drain recover without dangling references | Test deadline 5,000 ms exceeded. | 5009.50 |
| `apps/backend/tests/commands-container-exec.test.ts` | Electron backend command registry > GitHub credential helper > a session whose GitHub credential is withheld gets nothing from it | Test deadline 5,000 ms exceeded. | 5164.35 |
| `apps/backend/tests/commands-container-exec.test.ts` | Electron backend command registry > GitHub credential helper > takes a token out of an origin left by an earlier clone | Test deadline 5,000 ms exceeded. | 5190.49 |
| `apps/backend/tests/commands-environment-image-download.test.ts` | start waits for an automatic missing-image pull outside start admission | Test deadline 5,000 ms exceeded. | 5009.02 |
| `apps/backend/src/core/change-tracking/acceptance-turns.test.ts` | acceptance: fencing > H12: strict checkpoints hold a dispatch whose start fence was replaced | Test deadline 5,000 ms exceeded. | 5017.60 |
| `apps/backend/tests/commands-environment-image-download.test.ts` | start checks a pending tombstone after the download and lets queued deletion finish | Test deadline 5,000 ms exceeded. | 5005.34 |
| `apps/backend/tests/commands-environment.test.ts` | Electron backend command registry > preserves unusual Git paths and binary stats in NUL-delimited output | Test deadline 5,000 ms exceeded. | 5006.30 |
| `apps/backend/tests/commands-environment.test.ts` | Electron backend command registry > rejects a local HEAD that git did not report as a commit sha | Temporary Git fixture push failed with SIGTERM and null exit code; intended HEAD-validation assertion was not reached. | 518.58 |
| `apps/backend/src/core/preview-listener-ownership.test.ts` | LoopbackListenerOwnership on this host > attributes a real 127.0.0.1 listener and refuses another environment | Expected attribution this-environment; received unchecked (lines 451/491). | 2138.15 |
| `apps/backend/src/core/preview-listener-ownership.test.ts` | LoopbackListenerOwnership on this host > attributes a real :: listener and refuses another environment | Expected attribution this-environment; received unchecked (lines 451/491). | 2129.59 |
| `apps/backend/src/core/preview-listener-ownership.test.ts` | LoopbackListenerOwnership on this host > same-port listeners on loopback and a different interface keep distinct owners | Expected attribution this-environment; received unchecked (lines 451/491). | 2150.11 |
| `apps/backend/tests/commands-files.test.ts` | Electron backend command registry > does not block local untracked scanning on a named pipe | Test deadline 5,000 ms exceeded. | 5003.01 |
| `apps/backend/src/core/coordinator-worker-turns.test.ts` | the Work panel's request details > a delegation keeps a bounded summary and selection, and one without them still opens | Test deadline 5,000 ms exceeded. | 5016.87 |
| `apps/backend/src/core/coordinator-worker-turns.test.ts` | the wake sound's signal > a delivered wake is announced once, with no content | Test deadline 5,000 ms exceeded. | 5017.60 |
| `apps/backend/src/core/change-tracking/capture-orphan-fence.test.ts` | retention racing a capture > objects inside the skip window: sweeps running concurrently through a whole pass lose nothing | Test deadline 5,000 ms exceeded. | 5013.05 |
| `apps/backend/src/core/coordinator-worker-turns.test.ts` | stop_worker_turn > a delegation on a turn whose stop is not confirmed yet settles on the turn end | Test deadline 5,000 ms exceeded. | 5017.95 |
| `apps/backend/src/core/change-tracking/capture-orphan-fence.test.ts` | retention racing a capture > objects past the skip window: sweeps running concurrently through a whole pass lose nothing | RangeError: Cannot use a closed database, in retention after the other race case timed out. | 1342.05 |
| `apps/backend/src/core/coordinator-worker-turns.test.ts` | stop_worker_turn > the stop note survives a delegation the sweep closes as failed | Test deadline 5,000 ms exceeded. | 5021.12 |
| `apps/backend/src/core/coordinator-worker-turns.test.ts` | stop_worker_turn > the stop note survives a delegation the sweep closes as stopped | Test deadline 5,000 ms exceeded. | 5025.44 |
| `apps/backend/tests/container-readiness.test.ts` | bounded in-container boot wait > returns as soon as the current boot is ready, and prints what one read would | Expected ready probe <1000 ms; received 1427.08525 ms (line 314). | 2490.05 |
| `apps/backend/tests/container-readiness.test.ts` | bounded in-container boot wait > a pending shell probe is clipped to the remaining overall deadline | Expected clipped probe <1500 ms; received 3363.102167 ms (line 392). | 3367.55 |
| `apps/backend/tests/container-readiness.test.ts` | bounded in-container boot wait > renews an expired shell wait window and accepts readiness in the next exec | ContainerInitializationError: timed-out, from waitForContainerBoot (line 285). | 3602.72 |
| `apps/backend/tests/container-replacement-inputs.test.ts` | capability 3 binds gated shared skills and preserves Codex revisions | Test deadline 5,000 ms exceeded. | 5003.41 |
| `apps/backend/tests/container-replacement-inputs.test.ts` | capability 4 binds gated shared skills and preserves Codex revisions | ContainerLifecycleError:daemon-unavailable: fake image capability manifest was unavailable. | 2464.50 |
| `apps/backend/tests/container-workload.test.ts` | provider emits one five-field row for tool-free, failed-empty and tool-using turns | Test deadline 5,000 ms exceeded. | 5010.47 |
| `apps/backend/tests/diff-stats-service.test.ts` | DiffStatsService > qualified recovery resets the watcher retry budget | Expected retry delays [30000,30000]; received [30000,60000]. Old immediate-reset expectation conflicts with the stability interval. | 1.04 |
| `apps/backend/src/core/commands-environment-cleanup.test.ts` | delete_environment host cleanup > deletes the local branch in the deletion flow once its worktree is removed | Test deadline 5,000 ms exceeded. | 5022.61 |
| `apps/backend/tests/gateway-events.test.ts` | gateway terminal WebSocket > closes a cookie-authenticated terminal socket when its agent-test session expires | Test deadline 5,000 ms exceeded. | 5007.60 |
| `apps/backend/src/core/commands-files-delete-folder.test.ts` | container removal safety and shared revert behavior > deletes the literal folder scratch* and preserves every sibling | Test deadline 5,000 ms exceeded. | 5011.78 |
| `apps/backend/tests/gateway-proxy.test.ts` | remote gateway > releases a proxy buffer reservation when the downstream disconnects while buffering | Test deadline 5,000 ms exceeded. | 5001.83 |
| `apps/backend/src/core/commands-files-delete-folder.test.ts` | container removal safety and shared revert behavior > deletes the literal folder scratch[ab] and preserves every sibling | Test deadline 5,000 ms exceeded. | 5024.34 |
| `apps/backend/src/core/commands-files-delete-folder.test.ts` | container removal safety and shared revert behavior > deletes the literal folder :(exclude)keep and preserves every sibling | Test deadline 5,000 ms exceeded. | 5012.16 |
| `apps/backend/src/core/commands-files-delete-folder.test.ts` | container removal safety and shared revert behavior > preflights a worktree repository before removing tracked, untracked or ignored data | Test deadline 5,000 ms exceeded. | 5010.54 |
| `apps/backend/src/core/commands-files-delete-folder.test.ts` | container removal safety and shared revert behavior > does not follow a symlink into a sibling repository | Test deadline 5,000 ms exceeded. | 5012.61 |
| `apps/backend/src/core/commands-files-delete-folder.test.ts` | container removal safety and shared revert behavior > revert removes a newly added folder missing from the base | Test deadline 5,000 ms exceeded. | 5026.68 |
| `apps/backend/src/core/commands-files-delete-folder.test.ts` | container removal safety and shared revert behavior > revert restores a tracked file from the base | Test deadline 5,000 ms exceeded. | 6123.11 |
| `apps/backend/src/core/commands-files-delete-folder.test.ts` | container removal safety and shared revert behavior > revert refuses a newly added folder containing a nested repository without mutation | Test deadline 5,000 ms exceeded. | 6031.29 |
| `apps/backend/src/core/commands-files-local-scan.test.ts` | container status > repairs excludes after same-container replacement, deletion, rewrite and failed housekeeping | Test deadline 30,000 ms exceeded. | 30002.16 |
| `apps/backend/src/core/graph-run-rewind.test.ts` | code rewind > the preview names the target, the dropped commits, the upstream and what reruns | Test deadline 5,000 ms exceeded. | 5020.48 |
| `apps/backend/src/core/graph-run-rewind.test.ts` | code rewind > it resets to the node's input commit behind a backup ref and records the push facts first | Test deadline 5,000 ms exceeded. | 5013.70 |
| `apps/backend/src/core/graph-run-rewind.test.ts` | code rewind > a reset interrupted after the journal is finished before the run plans again | Test deadline 5,000 ms exceeded. | 5027.42 |
| `apps/backend/src/core/graph-run-rewind.test.ts` | commands > graph_run_restart and the code-rewind commands validate and delegate | Test deadline 5,000 ms exceeded. | 5031.88 |
| `apps/backend/tests/portable-inputs-shared-skills.test.ts` | shared skills root (task 1) > the entrypoint imports it into ~/.agents/skills, from the relay when node cannot read the mount | Test deadline 5,000 ms exceeded. | 5009.88 |
| `apps/backend/tests/portable-inputs-shared-skills.test.ts` | shared skills root (task 1) > the entrypoint still skips a link that reaches the mount | Test deadline 5,000 ms exceeded. | 5014.22 |
| `apps/backend/tests/portable-inputs-shared-skills.test.ts` | linked skill entries (task 2) > the entrypoint imports a linked skill where Claude reads user skills | Test deadline 5,000 ms exceeded. | 5014.14 |
| `apps/backend/tests/portable-inputs-stamps.test.ts` | a restart with unchanged inputs > copies nothing, and what the first start imported is still there | Test deadline 60,000 ms exceeded. | 60031.07 |
| `apps/backend/src/core/native-agent-goal-check.test.ts` | goalWorkspaceFingerprint > changes with a new file, an edit and a commit, and not otherwise | Test deadline 5,000 ms exceeded. | 5002.05 |
| `apps/backend/tests/portable-inputs-stamps.test.ts` | a restart with unchanged inputs > a staged file rewritten with the same bytes is still unchanged | Test deadline 60,000 ms exceeded. | 60023.72 |
| `apps/web/src/components/native-agent/AgentNativeTab.render-count.test.tsx` | an unrelated environment field does not render a tab holding a transcript | Expected 0 React commits; received 1 (lines 406/903). | 842.24 |
| `apps/web/src/components/native-agent/AgentNativeTab.render-count.test.tsx` | anchor resize does not render the native controller | Expected 0 React commits; received 1 (lines 406/903). | 427.85 |
| `apps/backend/tests/portable-inputs-stamps.test.ts` | a restart with unchanged inputs > the relay's fresh copy of unchanged mounts is still unchanged | Test deadline 60,000 ms exceeded. | 60037.21 |
| `apps/backend/src/core/control-mcp-coordinator-goals.test.ts` | what a coordinator is offered > the main coordinator has the tools and a side agent does not | Test deadline 5,000 ms exceeded. | 5030.13 |
| `apps/backend/src/core/control-mcp-coordinator-goals.test.ts` | what a coordinator is offered > a call that leaves out or exceeds the limit sets nothing | Test deadline 5,000 ms exceeded. | 5023.27 |
| `apps/backend/tests/portable-inputs-stamps.test.ts` | a changed input is reflected at the next start > changing one file in a tree copies that tree alone | Test deadline 60,000 ms exceeded. | 60026.06 |
| `bridges/pi-bridge/src/http-command-preview.test.ts` | revalidates a preview selection through the first prompt attach (shadowed: %s) | Expected catalogue status stale and attachPending=true; received ready without attachPending (line 138; two parameter rows). | 0.94, 14.59 |

### Between-test and collateral error evidence

- Attachments: `Confined file write failed (exit null)` from `path-safety.ts:704` during the idempotency timeout.
- PR wakes: `SQLITE_IOERR_VNODE: disk I/O error` after timed-out tests; the isolated owner also logged an incomplete workflow-association test double. No causal ordering or product fix is claimed.
- Node seed: expected `Configured file to copy not found`, but the rejection contained interrupted temporary Git fetch output; later isolated cases also had Git push/fetch SIGTERM and null status.
- User-command tests reported dangling owned processes at their deadlines. The owner subsequently passed unchanged.
- Helper/rewrite, named-pipe fixture, worker-turn and graph-rewind cases contain temporary Git/Bash children terminated with SIGTERM/null status. The named-pipe observation does not establish that reading the FIFO itself blocked.
- Replacement inputs: the aggregate's second case reported `daemon-unavailable`; the isolated second case reported `not-owned`, after the first case timed out and reported `helper-failed`. These are fixture outcomes, not evidence of a real Docker service failure.
- Hook counters and fake workload: child exit 143 after the 5 s deadline appears between tests.
- Orphan retention: a subsequent race case reported `Cannot use a closed database` after a different race case timed out; its complete owner then passed.

## Complete isolated-owner outcomes

All 32 commands ran once per owner, sequentially, with no intervening edits by the triage worker. Each invocation selected only its owning file; the original aggregate and other host work could still be active, so this does not describe an idle-host run. The primary fast-forwarded the clean original checkout at 02:06:14 UTC only after its original aggregate ended. Recorded run timestamps and the Git reflog establish that portable-stamps completed at 02:05:40 at 310, whereas goal-check began at 02:06:18 at 894. Three late owners therefore explicitly use 894 below. No result is relabelled as validation of another immutable head.

`—` in the error column means passing output did not report an error count; failing owners' between-test counts are copied from their logged summaries. Every JUnit report records zero skipped tests.

| Owning file | Actual head | Pass | Fail | Skip | Between-test errors | Test seconds | Outcome |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `apps/backend/src/core/change-tracking/acceptance-storage.test.ts` | `310f4fd7a` | 7 | 0 | 0 | — | 6.26 | pass |
| `apps/backend/src/core/change-tracking/acceptance-turns.test.ts` | `310f4fd7a` | 13 | 0 | 0 | — | 15.07 | pass |
| `apps/backend/tests/claude-state-signal-integration.test.ts` | `310f4fd7a` | 7 | 1 | 0 | 1 | 10.32 | non-green; not classified here as a new flake |
| `apps/backend/tests/commands-environment.test.ts` | `310f4fd7a` | 8 | 0 | 0 | — | 9.63 | pass |
| `apps/backend/tests/commands-files.test.ts` | `310f4fd7a` | 16 | 1 | 0 | 1 | 51.99 | non-green; not classified here as a new flake |
| `apps/backend/tests/commands-container-exec.test.ts` | `310f4fd7a` | 14 | 1 | 0 | 1 | 26.63 | non-green; not classified here as a new flake |
| `apps/backend/tests/container-readiness.test.ts` | `310f4fd7a` | 17 | 4 | 0 | 1 | 24.58 | non-green; not classified here as a new flake |
| `apps/backend/tests/container-workload.test.ts` | `310f4fd7a` | 6 | 3 | 0 | 2 | 33.32 | non-green; not classified here as a new flake |
| `apps/backend/src/core/control-mcp-coordinator-goals.test.ts` | `894861968` | 21 | 0 | 0 | — | 6.51 | pass |
| `apps/backend/src/core/commands-files-delete-folder.test.ts` | `310f4fd7a` | 25 | 0 | 0 | — | 18.14 | pass |
| `apps/backend/src/core/commands-environment-cleanup.test.ts` | `310f4fd7a` | 38 | 0 | 0 | — | 27.66 | pass |
| `e2e/agent-testing/container-fake-claude-install.test.ts` | `310f4fd7a` | 6 | 0 | 0 | — | 3.65 | pass |
| `tests/unit/firewall-egress-filter.test.ts` | `310f4fd7a` | 8 | 2 | 0 | 0 | 125.18 | non-green; not classified here as a new flake |
| `apps/backend/tests/gateway-events.test.ts` | `310f4fd7a` | 104 | 0 | 0 | — | 7.48 | pass |
| `apps/backend/tests/gateway-proxy.test.ts` | `310f4fd7a` | 33 | 0 | 0 | — | 11.26 | pass |
| `apps/backend/src/core/native-agent-goal-check.test.ts` | `894861968` | 2 | 0 | 0 | — | 1.17 | pass |
| `apps/backend/src/core/graph-run-rewind.test.ts` | `310f4fd7a` | 13 | 0 | 0 | — | 11.73 | pass |
| `apps/backend/tests/commands-environment-image-download.test.ts` | `310f4fd7a` | 11 | 0 | 0 | — | 16.97 | pass |
| `apps/backend/src/core/preview-listener-ownership.test.ts` | `310f4fd7a` | 20 | 3 | 0 | 0 | 6.91 | non-green; not classified here as a new flake |
| `apps/backend/src/core/commands-files-local-scan.test.ts` | `310f4fd7a` | 10 | 0 | 0 | — | 13.38 | pass |
| `apps/backend/src/core/coordinator-mail-attachments.test.ts` | `310f4fd7a` | 16 | 1 | 0 | 1 | 26.80 | non-green; not classified here as a new flake |
| `apps/backend/tests/agent-mail-store-size-bench.test.ts` | `310f4fd7a` | 3 | 0 | 0 | — | 8.14 | pass |
| `apps/web/src/components/native-agent/AgentNativeTab.render-count.test.tsx` | `894861968` | 37 | 0 | 0 | — | 5.30 | pass |
| `apps/backend/src/core/nodes/node-seed-worktree.test.ts` | `310f4fd7a` | 0 | 3 | 0 | 3 | 18.97 | non-green; not classified here as a new flake |
| `apps/backend/src/core/change-tracking/capture-orphan-fence.test.ts` | `310f4fd7a` | 23 | 0 | 0 | — | 15.42 | pass |
| `bridges/pi-bridge/src/http-command-preview.test.ts` | `310f4fd7a` | 0 | 2 | 0 | 0 | 2.34 | non-green; not classified here as a new flake |
| `apps/backend/tests/portable-inputs-stamps.test.ts` | `310f4fd7a` | 50 | 0 | 0 | — | 186.11 | pass |
| `apps/backend/src/core/coordinator-status-wakes-pr.test.ts` | `310f4fd7a` | 9 | 7 | 0 | 7 | 51.61 | non-green; not classified here as a new flake |
| `apps/backend/tests/container-replacement-inputs.test.ts` | `310f4fd7a` | 0 | 2 | 0 | 1 | 10.82 | non-green; not classified here as a new flake |
| `apps/backend/tests/portable-inputs-shared-skills.test.ts` | `310f4fd7a` | 21 | 0 | 0 | — | 6.65 | pass |
| `apps/backend/src/core/user-commands.test.ts` | `310f4fd7a` | 22 | 0 | 0 | — | 9.19 | pass |
| `apps/backend/src/core/coordinator-worker-turns.test.ts` | `310f4fd7a` | 9 | 10 | 0 | 10 | 82.59 | non-green; not classified here as a new flake |

### Every isolated failed-test name

This includes failures that differed from the aggregate; a different test passing does not make its complete owner green. Group names below retain the JUnit hierarchy order. Timeout messages are Bun's test deadline, not proof of an application timeout.

| Owning file | JUnit group / actual test name | Failure message |
| --- | --- | --- |
| `apps/backend/tests/claude-state-signal-integration.test.ts` | hook writers serialize counters and retain a completed turn without any config | test timed out |
| `apps/backend/tests/commands-files.test.ts` | Electron backend command registry > does not block local untracked scanning on a named pipe | test timed out |
| `apps/backend/tests/commands-container-exec.test.ts` | GitHub credential helper > Electron backend command registry > keeps working after setup clears credential.helper, on either order | test timed out |
| `apps/backend/tests/container-readiness.test.ts` | bounded in-container boot wait > sees a boot that finishes during the window | expect(received).toBeLessThan(expected)<br><br>Expected: < 1500<br>Received: 2000.074999999999<br> |
| `apps/backend/tests/container-readiness.test.ts` | bounded in-container boot wait > a pending shell probe is clipped to the remaining overall deadline | expect(received).toBeLessThan(expected)<br><br>Expected: < 1500<br>Received: 4538.958291999999<br> |
| `apps/backend/tests/container-readiness.test.ts` | bounded in-container boot wait > renews an expired shell wait window and accepts readiness in the next exec | test timed out |
| `apps/backend/tests/container-readiness.test.ts` | bounded in-container boot wait > a probe that comes back early without a final state is spaced, not repeated at once | expect(received).toBe(expected)<br><br>Expected: "timed-out"<br>Received: "failed"<br> |
| `apps/backend/tests/container-workload.test.ts` | provider emits one five-field row for tool-free, failed-empty and tool-using turns | test timed out |
| `apps/backend/tests/container-workload.test.ts` | run-failure cleans up only containers labelled for that invocation | test timed out |
| `apps/backend/tests/container-workload.test.ts` | startup-failure cleans up only containers labelled for that invocation | test timed out |
| `tests/unit/firewall-egress-filter.test.ts` | init-firewall.sh with name checks > redirects TCP to allowed tuples and every DNS query to the daemon, and lets only marked traffic leave | test timed out |
| `tests/unit/firewall-egress-filter.test.ts` | init-firewall.sh with name checks > the daemon counts refusals beside the report, and the boot's own checks are not counted | test timed out |
| `apps/backend/src/core/preview-listener-ownership.test.ts` | LoopbackListenerOwnership on this host > attributes a real 127.0.0.1 listener and refuses another environment | expect(received).toBe(expected)<br><br>Expected: "this-environment"<br>Received: "unchecked"<br> |
| `apps/backend/src/core/preview-listener-ownership.test.ts` | LoopbackListenerOwnership on this host > attributes a real :: listener and refuses another environment | expect(received).toBe(expected)<br><br>Expected: "this-environment"<br>Received: "unchecked"<br> |
| `apps/backend/src/core/preview-listener-ownership.test.ts` | LoopbackListenerOwnership on this host > same-port listeners on loopback and a different interface keep distinct owners | expect(received).toBe(expected)<br><br>Expected: "this-environment"<br>Received: "unchecked"<br> |
| `apps/backend/src/core/coordinator-mail-attachments.test.ts` | send_message with attachments, to a container > lands inside the container, readable, Git-excluded and not retried | test timed out |
| `apps/backend/src/core/nodes/node-seed-worktree.test.ts` | FL-03/FL-04/FL-05 seed files in a leaf environment's worktree > the node's own files are copied, seed files fill only the gaps | test timed out |
| `apps/backend/src/core/nodes/node-seed-worktree.test.ts` | FL-03/FL-04/FL-05 seed files in a leaf environment's worktree > without a seed copy a missing selected file still fails as before | test timed out |
| `apps/backend/src/core/nodes/node-seed-worktree.test.ts` | command-only selected seed files reach a worktree with an empty leaf selection | test timed out |
| `bridges/pi-bridge/src/http-command-preview.test.ts` | revalidates a preview selection through the first prompt attach (shadowed: %s) | Expected stale with attachPending=true; received ready without attachPending (both parameter rows). |
| `apps/backend/src/core/coordinator-status-wakes-pr.test.ts` | pull request status wakes > a PR wakes once per state change until merge (hidden: %s) | test timed out |
| `apps/backend/src/core/coordinator-status-wakes-pr.test.ts` | pull request status wakes > a state that recurs after a fix wakes again; re-observing one episode does not | test timed out |
| `apps/backend/src/core/coordinator-status-wakes-pr.test.ts` | pull request status wakes > Merge and Cleanup: a merge recorded just before the worker is deleted still wakes once | test timed out |
| `apps/backend/src/core/coordinator-status-wakes-pr.test.ts` | pull request status wakes > a follow that already ended still records the merge when its worker is deleted | test timed out |
| `apps/backend/src/core/coordinator-status-wakes-pr.test.ts` | pull request status wakes > a review joining a create_pr follow is found by its own request; one of them reports | test timed out |
| `apps/backend/src/core/coordinator-status-wakes-pr.test.ts` | pull request status wakes > a review's auto-PR is followed after its pr-opened, without repeating it | test timed out |
| `apps/backend/tests/container-replacement-inputs.test.ts` | capability 3 binds gated shared skills and preserves Codex revisions | test timed out |
| `apps/backend/tests/container-replacement-inputs.test.ts` | capability 4 binds gated shared skills and preserves Codex revisions | ContainerLifecycleError:not-owned: The container cannot be rebuilt because its ownership could not be confirmed. |
| `apps/backend/src/core/coordinator-worker-turns.test.ts` | the Work panel's request details > a delegation keeps a bounded summary and selection, and one without them still opens | test timed out |
| `apps/backend/src/core/coordinator-worker-turns.test.ts` | the wake sound's signal > a delivered wake is announced once, with no content | test timed out |
| `apps/backend/src/core/coordinator-worker-turns.test.ts` | stop_worker_turn > stops the running turn, cancels its run, and wakes the waiting coordinator once | test timed out |
| `apps/backend/src/core/coordinator-worker-turns.test.ts` | stop_worker_turn > the stop note survives a delegation the sweep closes as failed | test timed out |
| `apps/backend/src/core/coordinator-worker-turns.test.ts` | stop_worker_turn > the stop note survives a delegation the sweep closes as stopped | test timed out |
| `apps/backend/src/core/coordinator-worker-turns.test.ts` | stop_worker_turn > an idle tab answers plainly, and nothing is marked or stopped | test timed out |
| `apps/backend/src/core/coordinator-worker-turns.test.ts` | worker slash commands > lists a tab's commands without live-turn commands | test timed out |
| `apps/backend/src/core/coordinator-worker-turns.test.ts` | worker slash commands > a command (/review) stores its resolved name and opens one delegation | test timed out |
| `apps/backend/src/core/coordinator-worker-turns.test.ts` | worker slash commands > a command (claude:/review) stores its resolved name and opens one delegation | test timed out |
| `apps/backend/src/core/coordinator-worker-turns.test.ts` | worker slash commands > a failed delegation open fails the command and a busy retry recovers the same turn | test timed out |

### Isolated-owner commands

The exact commands include JUnit report paths because the logged runner deletes passing raw output. Backend commands preload node isolation; Pi additionally preloads its isolated agent directory; root/web commands use their Bun configurations.

- `mise run test:logged -- --name watcher-triage-acceptance-storage -- bun test --cwd apps/backend ./src/core/change-tracking/acceptance-storage.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/acceptance-storage.xml` — exit 0; wrapper 6.286 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-acceptance-turns -- bun test --cwd apps/backend ./src/core/change-tracking/acceptance-turns.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/acceptance-turns.xml` — exit 0; wrapper 15.084 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-claude-signal -- bun test --cwd apps/backend ./tests/claude-state-signal-integration.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/claude-signal.xml` — exit 1; wrapper 10.339 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-commands-environment -- bun test --cwd apps/backend ./tests/commands-environment.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/commands-environment.xml` — exit 0; wrapper 9.651 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-commands-files -- bun test --cwd apps/backend ./tests/commands-files.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/commands-files.xml` — exit 1; wrapper 52.331 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-container-exec -- bun test --cwd apps/backend ./tests/commands-container-exec.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/container-exec.xml` — exit 1; wrapper 26.648 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-container-readiness -- bun test --cwd apps/backend ./tests/container-readiness.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/container-readiness.xml` — exit 1; wrapper 24.596 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-container-workload -- bun test --cwd apps/backend ./tests/container-workload.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/container-workload.xml` — exit 1; wrapper 33.341 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-coordinator-goals -- bun test --cwd apps/backend ./src/core/control-mcp-coordinator-goals.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/coordinator-goals.xml` — exit 0; wrapper 6.527 s; head `8948619686981e7b237f879192ac6ffc86b227c6`.
- `mise run test:logged -- --name watcher-triage-delete-folder -- bun test --cwd apps/backend ./src/core/commands-files-delete-folder.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/delete-folder.xml` — exit 0; wrapper 18.155 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-environment-cleanup -- bun test --cwd apps/backend ./src/core/commands-environment-cleanup.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/environment-cleanup.xml` — exit 0; wrapper 28.049 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-fake-claude-install -- bun test ./e2e/agent-testing/container-fake-claude-install.test.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/fake-claude-install.xml` — exit 0; wrapper 3.665 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-firewall -- bun test ./tests/unit/firewall-egress-filter.test.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/firewall.xml` — exit 1; wrapper 125.685 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-gateway-events -- bun test --cwd apps/backend ./tests/gateway-events.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/gateway-events.xml` — exit 0; wrapper 7.500 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-gateway-proxy -- bun test --cwd apps/backend ./tests/gateway-proxy.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/gateway-proxy.xml` — exit 0; wrapper 11.430 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-goal-check -- bun test --cwd apps/backend ./src/core/native-agent-goal-check.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/goal-check.xml` — exit 0; wrapper 1.183 s; head `8948619686981e7b237f879192ac6ffc86b227c6`.
- `mise run test:logged -- --name watcher-triage-graph-rewind -- bun test --cwd apps/backend ./src/core/graph-run-rewind.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/graph-rewind.xml` — exit 0; wrapper 11.750 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-image-download -- bun test --cwd apps/backend ./tests/commands-environment-image-download.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/image-download.xml` — exit 0; wrapper 17.029 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-listener-ownership -- bun test --cwd apps/backend ./src/core/preview-listener-ownership.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/listener-ownership.xml` — exit 1; wrapper 6.939 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-local-scan -- bun test --cwd apps/backend ./src/core/commands-files-local-scan.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/local-scan.xml` — exit 0; wrapper 13.397 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-mail-attachments -- bun test --cwd apps/backend ./src/core/coordinator-mail-attachments.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/mail-attachments.xml` — exit 1; wrapper 26.858 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-mail-bench -- bun test --cwd apps/backend ./tests/agent-mail-store-size-bench.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/mail-bench.xml` — exit 0; wrapper 8.154 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-native-tab-render -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.render-count.test.tsx --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/native-tab-render.xml` — exit 0; wrapper 5.319 s; head `8948619686981e7b237f879192ac6ffc86b227c6`.
- `mise run test:logged -- --name watcher-triage-node-seed -- bun test --cwd apps/backend ./src/core/nodes/node-seed-worktree.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/node-seed.xml` — exit 1; wrapper 20.531 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-orphan-fence -- bun test --cwd apps/backend ./src/core/change-tracking/capture-orphan-fence.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/orphan-fence.xml` — exit 0; wrapper 15.438 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-pi-preview -- bun test --cwd bridges/pi-bridge ./src/http-command-preview.test.ts --preload ../../tests/setup-node.ts --preload ./src/testing/test-isolation.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/pi-preview.xml` — exit 1; wrapper 2.622 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-portable-stamps -- bun test --cwd apps/backend ./tests/portable-inputs-stamps.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/portable-stamps.xml` — exit 0; wrapper 186.124 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-pr-wakes -- bun test --cwd apps/backend ./src/core/coordinator-status-wakes-pr.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/pr-wakes.xml` — exit 1; wrapper 51.830 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-replacement-inputs -- bun test --cwd apps/backend ./tests/container-replacement-inputs.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/replacement-inputs.xml` — exit 1; wrapper 11.012 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-shared-skills -- bun test --cwd apps/backend ./tests/portable-inputs-shared-skills.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/shared-skills.xml` — exit 0; wrapper 6.682 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-user-commands -- bun test --cwd apps/backend ./src/core/user-commands.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/user-commands.xml` — exit 0; wrapper 9.272 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- `mise run test:logged -- --name watcher-triage-worker-turns -- bun test --cwd apps/backend ./src/core/coordinator-worker-turns.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/worker-turns.xml` — exit 1; wrapper 82.647 s; head `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.

### Non-green isolated artifacts

- `apps/backend/tests/claude-state-signal-integration.test.ts`: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.nBqPWL/watcher-triage-claude-signal.log.gz`; JUnit `/private/tmp/ork-watcher-failure-triage.0oarZv/claude-signal.xml`.
- `apps/backend/tests/commands-files.test.ts`: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.uifdIP/watcher-triage-commands-files.log.gz`; JUnit `/private/tmp/ork-watcher-failure-triage.0oarZv/commands-files.xml`.
- `apps/backend/tests/commands-container-exec.test.ts`: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.b16jJI/watcher-triage-container-exec.log.gz`; JUnit `/private/tmp/ork-watcher-failure-triage.0oarZv/container-exec.xml`.
- `apps/backend/tests/container-readiness.test.ts`: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.O95ftp/watcher-triage-container-readiness.log.gz`; JUnit `/private/tmp/ork-watcher-failure-triage.0oarZv/container-readiness.xml`.
- `apps/backend/tests/container-workload.test.ts`: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.lv0Eyq/watcher-triage-container-workload.log.gz`; JUnit `/private/tmp/ork-watcher-failure-triage.0oarZv/container-workload.xml`.
- `tests/unit/firewall-egress-filter.test.ts`: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.VEiypp/watcher-triage-firewall.log.gz`; JUnit `/private/tmp/ork-watcher-failure-triage.0oarZv/firewall.xml`.
- `apps/backend/src/core/preview-listener-ownership.test.ts`: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.GYn7uY/watcher-triage-listener-ownership.log.gz`; JUnit `/private/tmp/ork-watcher-failure-triage.0oarZv/listener-ownership.xml`.
- `apps/backend/src/core/coordinator-mail-attachments.test.ts`: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.IS76Rt/watcher-triage-mail-attachments.log.gz`; JUnit `/private/tmp/ork-watcher-failure-triage.0oarZv/mail-attachments.xml`.
- `apps/backend/src/core/nodes/node-seed-worktree.test.ts`: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.L9KFCa/watcher-triage-node-seed.log.gz`; JUnit `/private/tmp/ork-watcher-failure-triage.0oarZv/node-seed.xml`.
- `bridges/pi-bridge/src/http-command-preview.test.ts`: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.mmBds9/watcher-triage-pi-preview.log.gz`; JUnit `/private/tmp/ork-watcher-failure-triage.0oarZv/pi-preview.xml`.
- `apps/backend/src/core/coordinator-status-wakes-pr.test.ts`: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.sAqNPl/watcher-triage-pr-wakes.log.gz`; JUnit `/private/tmp/ork-watcher-failure-triage.0oarZv/pr-wakes.xml`.
- `apps/backend/tests/container-replacement-inputs.test.ts`: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.ZrcrSE/watcher-triage-replacement-inputs.log.gz`; JUnit `/private/tmp/ork-watcher-failure-triage.0oarZv/replacement-inputs.xml`.
- `apps/backend/src/core/coordinator-worker-turns.test.ts`: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.3AzHmN/watcher-triage-worker-turns.log.gz`; JUnit `/private/tmp/ork-watcher-failure-triage.0oarZv/worker-turns.xml`.

## Registry disposition and decisions

Exact owning-file-pass recurrences update existing cases 9910, 9906, 6603, 9839, 6600, 6561 and 1651; their recurrence checks used base 08d3da4a against the current registry ref. Case 6603 is reopened because its prior fix is in the base; local 6561 is reopened to match its already-open upstream state. Prior resolutions remain history, not a claim that their old causes have returned. Distinct unmatched owner-pass observations are grouped once in [case 9920](../tests/flaky-tests/aggregate-validation-runs/9920-worktree-watcher-review-mixed-owner-timeouts.md).

Pi preview fails alone consistently and is reported as an unrelated deterministic catalogue-contract failure. Firewall, attachments, PR wakes, named-pipe fixture, hook writer, helper/rewrite, real listener, worker-turn, node-seed, replacement-input and fake-workload owners remained non-green; no new flake classification or production fix is invented for them. Existing histories such as 9837/6602, 9852, 4843, 1102 and 6600 remain relevant context. Environmental case 5561 requires its measured spawn-latency signature; that measurement was not made during this observation, so no such cause is claimed.

The choice was to repair the two affected watcher-test contracts and the proven macOS fixture races, then preserve every unrelated failure. Broad production fixes, relaxed assertions, raised individual-test deadlines, automatic retries and skips would expand scope without evidence. A complete owner pass establishes intermittent behavior only; it does not replace either unsuccessful aggregate attempt.

## Earlier rollback-head checks

These ran at clean ccf46a4d4 before the coverage follow-up. They are historical snapshot evidence, not final-head qualification; passing raw logs were removed, so test totals are unavailable.

| Exact command | Result |
| --- | --- |
| `mise run test:logged -- --name review-format -- mise run format:check` | Pass, 0.6 s |
| `mise run test:logged -- --name review-lint -- mise run lint` | Pass, 4.5 s; warning details not retained |
| `mise run test:logged -- --name review-typecheck -- mise run typecheck` | Pass, 8.6 s |
| `mise run test:logged -- --name review-build -- mise run build` | Pass, 4.5 s |
| `mise run test:logged -- --name review-tests -- mise run test` | Exit 1, 1800.2 s; outer absolute deadline after about 1779 s capacity wait, lockfile passed and remaining groups interrupted |
| `mise run test:logged -- --name review-watcher-slow -- bun test --cwd apps/backend ./src/core/worktree-snapshots-git.test.ts ./tests/worktree-watcher-real.test.ts ./tests/worktree-watcher.test.ts --parallel=1 --only-failures` | Pass, 42.1 s on macOS; does not qualify Linux permission behavior |
| `mise run test:logged -- --name review-changed-owners -- bun test --cwd apps/backend ./src/core/worktree-watcher-split.test.ts ./src/core/worktree-snapshots.test.ts --parallel=1 --only-failures` | Pass, 1.6 s |

Earlier failure evidence: `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.VagsX4/review-tests.log.gz`; inner partial group logs were preserved under `orkestrator-test-run.JHl54l/*.log.gz`.

## Not run and cleanup

No browser, Electron-native, iOS, real-agent or complete slow-tier qualification was added for this backend watcher change. The isolated owner commands use fixture homes/local repositories/fake providers and Docker shims; the supplied Linux watcher proof uses a credential-free disposable container. No production application was launched.

The triage worker's native test sessions all ended. The primary confirmed both aggregate sessions ended, no test profile was created, and the temporary isolated worktree/proof preloads/bundles were removed after their owned work stopped. No manual process signalling or broad cleanup commands were used. At preparation handoff, the registry/document edits following source head 894 were uncommitted for primary review. The ignored receipt and completion transcript carry subsequent canonical verification outcomes as described above.
