# Worktree-watcher review: mixed-owner aggregate failures that pass alone

- **ID:** 9926
- **Status:** open
- **Date observed:** 2026-11-10
- **Observing base:** `08d3da4a23cfe2ecc34fba663ca27e765f7924a9`.
- **Aggregate head:** `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.
- **Command:** `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=7200000 mise run test:logged -- --name coverage-full-final -- mise run test`.
- **Host:** macOS arm64, Bun 1.4.4 (`38afee6c8`), mise 2026.9.17.
- **Workers:** workspace six admitted slots (web two, backend four), root one, bridges two, protocol one; actual package banners are retained in the group logs.

The aggregate exited 1 after 2468.77 s. Root completed with 4274 pass, 25 skip and four fail; web completed with 14336 pass, ten skip and two fail. Pi completed with 706 pass, one skip and two fail. Backend emitted named failures but no final counts: the workspace no-progress watchdog stopped it. The other completed packages and bridges passed. This record does not turn the original aggregate green.

## Newly confirmed intermittent observations

Only tests whose complete unchanged owner passed alone appear here. Exact known-case matches update their existing cases instead: 9910, 9906, 6603, 9839, 6600, 6561 and 1651. The related observations below are distinct tests, even where an owner also contains a known case.

| Owning file | Actual aggregate test name | Failure | Complete owner alone |
| --- | --- | --- | --- |
| `apps/backend/src/core/user-commands.test.ts` | interactive commands > cancel stops the whole command and clears its prompt | Test deadline 5,000 ms exceeded. | 22 pass, 0 fail, 0 skip; 9.19 s; `310f4fd7a` |
| `apps/backend/tests/agent-mail-store-size-bench.test.ts` | agent mail store size benchmark > rejects malformed, empty, missing and nonpositive sizes | Test deadline 5,000 ms exceeded. | 3 pass, 0 fail, 0 skip; 8.14 s; `310f4fd7a` |
| `apps/backend/src/core/change-tracking/acceptance-storage.test.ts` | acceptance: storage durability, retention and representation > H11: crashes around object publication, ledger commit and outbox drain recover without dangling references | Test deadline 5,000 ms exceeded. | 7 pass, 0 fail, 0 skip; 6.26 s; `310f4fd7a` |
| `apps/backend/tests/commands-environment-image-download.test.ts` | start waits for an automatic missing-image pull outside start admission | Test deadline 5,000 ms exceeded. | 11 pass, 0 fail, 0 skip; 16.97 s; `310f4fd7a` |
| `apps/backend/src/core/change-tracking/acceptance-turns.test.ts` | acceptance: fencing > H12: strict checkpoints hold a dispatch whose start fence was replaced | Test deadline 5,000 ms exceeded. | 13 pass, 0 fail, 0 skip; 15.07 s; `310f4fd7a` |
| `apps/backend/tests/commands-environment-image-download.test.ts` | start checks a pending tombstone after the download and lets queued deletion finish | Test deadline 5,000 ms exceeded. | 11 pass, 0 fail, 0 skip; 16.97 s; `310f4fd7a` |
| `apps/backend/tests/commands-environment.test.ts` | Electron backend command registry > preserves unusual Git paths and binary stats in NUL-delimited output | Test deadline 5,000 ms exceeded. | 8 pass, 0 fail, 0 skip; 9.63 s; `310f4fd7a` |
| `apps/backend/tests/commands-environment.test.ts` | Electron backend command registry > rejects a local HEAD that git did not report as a commit sha | Temporary Git fixture push failed with SIGTERM and null exit code; intended HEAD-validation assertion was not reached. | 8 pass, 0 fail, 0 skip; 9.63 s; `310f4fd7a` |
| `apps/backend/src/core/change-tracking/capture-orphan-fence.test.ts` | retention racing a capture > objects inside the skip window: sweeps running concurrently through a whole pass lose nothing | Test deadline 5,000 ms exceeded. | 23 pass, 0 fail, 0 skip; 15.42 s; `310f4fd7a` |
| `apps/backend/src/core/change-tracking/capture-orphan-fence.test.ts` | retention racing a capture > objects past the skip window: sweeps running concurrently through a whole pass lose nothing | RangeError: Cannot use a closed database, in retention after the other race case timed out. | 23 pass, 0 fail, 0 skip; 15.42 s; `310f4fd7a` |
| `apps/backend/src/core/commands-environment-cleanup.test.ts` | delete_environment host cleanup > deletes the local branch in the deletion flow once its worktree is removed | Test deadline 5,000 ms exceeded. | 38 pass, 0 fail, 0 skip; 27.66 s; `310f4fd7a` |
| `apps/backend/tests/gateway-events.test.ts` | gateway terminal WebSocket > closes a cookie-authenticated terminal socket when its agent-test session expires | Test deadline 5,000 ms exceeded. | 104 pass, 0 fail, 0 skip; 7.48 s; `310f4fd7a` |
| `apps/backend/src/core/commands-files-delete-folder.test.ts` | container removal safety and shared revert behavior > deletes the literal folder scratch* and preserves every sibling | Test deadline 5,000 ms exceeded. | 25 pass, 0 fail, 0 skip; 18.14 s; `310f4fd7a` |
| `apps/backend/tests/gateway-proxy.test.ts` | remote gateway > releases a proxy buffer reservation when the downstream disconnects while buffering | Test deadline 5,000 ms exceeded. | 33 pass, 0 fail, 0 skip; 11.26 s; `310f4fd7a` |
| `apps/backend/src/core/commands-files-delete-folder.test.ts` | container removal safety and shared revert behavior > deletes the literal folder scratch[ab] and preserves every sibling | Test deadline 5,000 ms exceeded. | 25 pass, 0 fail, 0 skip; 18.14 s; `310f4fd7a` |
| `apps/backend/src/core/commands-files-delete-folder.test.ts` | container removal safety and shared revert behavior > deletes the literal folder :(exclude)keep and preserves every sibling | Test deadline 5,000 ms exceeded. | 25 pass, 0 fail, 0 skip; 18.14 s; `310f4fd7a` |
| `apps/backend/src/core/commands-files-delete-folder.test.ts` | container removal safety and shared revert behavior > preflights a worktree repository before removing tracked, untracked or ignored data | Test deadline 5,000 ms exceeded. | 25 pass, 0 fail, 0 skip; 18.14 s; `310f4fd7a` |
| `apps/backend/src/core/commands-files-delete-folder.test.ts` | container removal safety and shared revert behavior > does not follow a symlink into a sibling repository | Test deadline 5,000 ms exceeded. | 25 pass, 0 fail, 0 skip; 18.14 s; `310f4fd7a` |
| `apps/backend/src/core/commands-files-delete-folder.test.ts` | container removal safety and shared revert behavior > revert removes a newly added folder missing from the base | Test deadline 5,000 ms exceeded. | 25 pass, 0 fail, 0 skip; 18.14 s; `310f4fd7a` |
| `apps/backend/src/core/commands-files-delete-folder.test.ts` | container removal safety and shared revert behavior > revert refuses a newly added folder containing a nested repository without mutation | Test deadline 5,000 ms exceeded. | 25 pass, 0 fail, 0 skip; 18.14 s; `310f4fd7a` |
| `apps/backend/src/core/graph-run-rewind.test.ts` | code rewind > the preview names the target, the dropped commits, the upstream and what reruns | Test deadline 5,000 ms exceeded. | 13 pass, 0 fail, 0 skip; 11.73 s; `310f4fd7a` |
| `apps/backend/src/core/graph-run-rewind.test.ts` | code rewind > it resets to the node's input commit behind a backup ref and records the push facts first | Test deadline 5,000 ms exceeded. | 13 pass, 0 fail, 0 skip; 11.73 s; `310f4fd7a` |
| `apps/backend/src/core/graph-run-rewind.test.ts` | code rewind > a reset interrupted after the journal is finished before the run plans again | Test deadline 5,000 ms exceeded. | 13 pass, 0 fail, 0 skip; 11.73 s; `310f4fd7a` |
| `apps/backend/src/core/graph-run-rewind.test.ts` | commands > graph_run_restart and the code-rewind commands validate and delegate | Test deadline 5,000 ms exceeded. | 13 pass, 0 fail, 0 skip; 11.73 s; `310f4fd7a` |
| `apps/backend/tests/portable-inputs-shared-skills.test.ts` | shared skills root (task 1) > the entrypoint still skips a link that reaches the mount | Test deadline 5,000 ms exceeded. | 21 pass, 0 fail, 0 skip; 6.65 s; `310f4fd7a` |
| `apps/backend/tests/portable-inputs-stamps.test.ts` | a restart with unchanged inputs > copies nothing, and what the first start imported is still there | Test deadline 60,000 ms exceeded. | 50 pass, 0 fail, 0 skip; 186.11 s; `310f4fd7a` |
| `apps/backend/src/core/native-agent-goal-check.test.ts` | goalWorkspaceFingerprint > changes with a new file, an edit and a commit, and not otherwise | Test deadline 5,000 ms exceeded. | 2 pass, 0 fail, 0 skip; 1.17 s; `894861968` |
| `apps/backend/tests/portable-inputs-stamps.test.ts` | a restart with unchanged inputs > a staged file rewritten with the same bytes is still unchanged | Test deadline 60,000 ms exceeded. | 50 pass, 0 fail, 0 skip; 186.11 s; `310f4fd7a` |
| `apps/web/src/components/native-agent/AgentNativeTab.render-count.test.tsx` | anchor resize does not render the native controller | Expected 0 React commits; received 1 (lines 406/903). | 37 pass, 0 fail, 0 skip; 5.30 s; `894861968` |
| `apps/backend/tests/portable-inputs-stamps.test.ts` | a restart with unchanged inputs > the relay's fresh copy of unchanged mounts is still unchanged | Test deadline 60,000 ms exceeded. | 50 pass, 0 fail, 0 skip; 186.11 s; `310f4fd7a` |
| `apps/backend/src/core/control-mcp/coordinator-goals.test.ts` | what a coordinator is offered > a call that leaves out or exceeds the limit sets nothing | Test deadline 5,000 ms exceeded. | 21 pass, 0 fail, 0 skip; 6.51 s; `894861968` |

Every owner ran once with `--parallel=1 --only-failures --reporter=junit`; backend owners explicitly preloaded `../../tests/setup-node.ts`, while web used its DOM preloads. No assertion, deadline, skip or unrelated production code changed. All exact commands and retained JUnit locations are in [the validation report](../../../development/worktree-watcher-validation.md#isolated-owner-commands).

## Evidence and limits

- Original group logs: `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.dH765N/*.log.gz`.
- Original outer log: `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.LbfszS/coverage-full-final.log.gz`.
- Isolated JUnit records: `/private/tmp/ork-watcher-failure-triage.0oarZv/*.xml`. Passing raw logs were removed by the logged runner; JUnit retains the counts.
- The unchanged owners passed at their recorded heads; three late reruns used clean `8948619686981e7b237f879192ac6ffc86b227c6` after the original aggregate ended. Differences from the aggregate head concern watcher tests and registry prose, not these owners. Head attribution is explicit in the report.
- The cause is unconfirmed. Timeouts and late child/SQLite errors do not establish slow spawning, a particular product race, or a need to raise a timeout. The original failed/incomplete aggregate remains evidence.
- Thirteen complete owners remained non-green alone. The report retains every failed name and available count; these owners are not classified here as newly confirmed flakes.
- The final-source aggregate attempt at `8948619686981e7b237f879192ac6ffc86b227c6` expired admission with exit 75 before any tests ran; it supplies no test counts or full-suite pass.

## Recurrence 2026-11-13: agent mail store size benchmark

- **Test:** `agent mail store size benchmark > rejects malformed, empty, missing and nonpositive sizes`
  (`apps/backend/tests/agent-mail-store-size-bench.test.ts`).
- **Base:** `17d28238c098b4443d1289df5c4ed75e7cc2802e`; head `83a9be859` on
  `rootless-docker-copy-1c9f451a929a-r1`, which changes neither the test nor
  its script nor anything the script imports. `mise run flaky:recurrence -- 9926 --base 17d28238c098b4443d1289df5c4ed75e7cc2802e`
  answered open: record as a recurrence.
- **Host:** beelink2, Linux x86_64, Bun 1.4.4, load average about 104.
- **Aggregate:** `mise run test:logged -- --name address-default-tests -- mise run test`;
  backend `test:workspace` 18163 pass, 1 fail (this test, deadline 5,000 ms
  exceeded at 5011.33 ms) across 1279 files in 748.48 s. The runner's
  rerun-alone step was still queued for host capacity at the 1800 s group
  deadline.
- **Alone:** `NODE_ENV=test mise run test:logged -- --name rerun-agent-mail-bench-2 -- bun --no-env-file --cwd=apps/backend test --preload ../../tests/setup-node.ts tests/agent-mail-store-size-bench.test.ts`
  passed (3 tests, 10.7 s). One earlier alone run at the same load failed
  the same way: the test spawns the benchmark six times, and one spawn took
  about 1.8 s on that host.
