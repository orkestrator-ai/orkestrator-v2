# Environment-deletion main merge validation

- **ID:** 9839
- **Status:** open
- **Date observed:** 2026-11-06
- **Original command:** `mise run test:logged -- --name merge-default -- mise run test`
- **Merge parents:** `aeb6617edd1cc0a525c74eedf2b432584ac83b41` and `9f94b114204f3f98c643bc3489d2ac7d2c5220c6`.
- **Worker configuration:** default aggregate; root one isolated worker, backend four isolated workers, and bridge group two worker slots. The nine-worker component browser suite and one-worker isolated gateway smoke also ran on this host.
- **Suite counts:** root 3,707 pass and four fail across 191 files (505.77 s). The Codex bridge reported 2,400 pass, 63 skip and one fail across 113 files (80.07 s). Workspace summaries: backend 16,483 pass, 138 skip and eight fail across 1,101 files; web 13,056 pass, ten skip and one fail across 869 files; protocol 4,980 pass, two skip and one fail; CLI 501 pass, eight skip and three fail. Desktop, public web and toolchain had no failures. Aggregate exit 1 after 1,317.5 s. Counts preserve the original run, including the in-progress row assertion and subsequently repaired registry IDs.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.HtWRHT/`, compressed by the aggregate on completion.

## Aggregate failures whose complete unchanged owners passed alone

Each rerun used `mise run test:logged`, one explicit owning file and `--parallel=1 --only-failures`; passing raw output was deleted by that runner. No assertion, timeout or skip changed.

| Test | Owner | Original failure | Isolated rerun | Result |
| --- | --- | --- | --- | --- |
| `fallback to the ordinary clone > an object lost from deep in the history, which only the clone can find` | `tests/unit/workspace-setup-git-mirror.test.ts:309` | Git child status null; 6,809.93 ms, beyond the 5 s case deadline | `mise run test:logged -- --name merge-git-mirror-alone -- bun test ./tests/unit/workspace-setup-git-mirror.test.ts --parallel=1 --only-failures` | exit 0, 46.4 s |
| `native shell completion execution > zsh bashcompinit parses option values and offers short flags` | `packages/cli/tests/command-surface.test.ts:375` | Bash child status null; 5,004.27 ms | `mise run test:logged -- --name merge-cli-completion-alone -- bun test --cwd packages/cli ./tests/command-surface.test.ts --parallel=1 --only-failures` | exit 0, 6.8 s |
| `container removal safety and shared revert behavior > revert refuses a newly added folder containing a nested repository without mutation` | `apps/backend/src/core/commands-files-delete-folder.test.ts:260` | Expected nested-repository refusal, received an empty error; 5,305.84 ms and timeout | `mise run test:logged -- --name merge-folder-delete-alone -- bun test --cwd apps/backend ./src/core/commands-files-delete-folder.test.ts --parallel=1 --only-failures` | exit 0, 14.7 s |
| `never runs the worktree's fsmonitor hook or takes optional locks (node)` | `apps/backend/src/core/review-worktree-fingerprint.test.ts` | 5,054.04 ms timeout | `mise run test:logged -- --name merge-fingerprint-alone -- bun test --cwd apps/backend ./src/core/review-worktree-fingerprint.test.ts --parallel=1 --only-failures` | exit 0, 24.1 s |
| `bounded in-container boot wait > returns as soon as the current boot is ready, and prints what one read would` | `apps/backend/tests/container-readiness.test.ts:314` | Probe took 1,064.68 ms, expected below 1,000 ms; case 1,333.58 ms | `mise run test:logged -- --name merge-readiness-alone -- bun test --cwd apps/backend ./tests/container-readiness.test.ts --parallel=1 --only-failures` | exit 0, 9.5 s |

The isolated passes establish intermittence. Host scheduling pressure is a hypothesis, not an established cause.

Known recurrences are recorded in their existing cases: [0210](../agent-bridges/0210-fake-codex-process-timeout.md), [6193](../backend-services-and-tooling/6193-webkit-generation-reader-einval.md), [4843](4843-e8-recorded-backend-failures.md) and [6603](../environments-and-containers/6603-container-status-excludes-aggregate-timeout.md).

## Other validation results

These are not classified as flakes:

- The register uniqueness test found three different files using ID 9834. The merge retained their evidence and assigned two unique IDs, 9837 and 9838, updating links and index rows. `mise run test:logged -- --name merge-registry -- bun test ./tests/unit/flaky-tests-index.test.ts --parallel=1 --only-failures` then passed (1.2 s).
- The aggregate started before the row selection integration assertion was added. It later failed `multi-select takes a failed cleanup but not a delete in flight, on either path` at the new assertion. A complete settled-source owner rerun passed (0.8 s), and `mise run test:logged -- --name merge-environments-federation -- bun test --cwd apps/web ./src/components/environments ./src/components/federation ./src/lib/federation --parallel=2 --only-failures` passed the environment/federation component and library groups together (31.7 s). This in-progress run is not classified as a flake.
- `packages/protocol/src/node/shell-process-state.test.ts` still failed alone: seven pass, two fail (2.7 s). Both empty/zombie process-group checks returned true rather than false. Source and owner match the target parent exactly. Evidence: `orkestrator-test-run.mcEEhJ/merge-process-state-alone.log.gz` under the same temporary root.
- `packages/cli/tests/cli.test.ts` still failed alone: 12 pass, one fail (37.9 s), `starts and gracefully stops the packaged backend`, readiness not observed within 20 s. The other NODE_ENV startup case passed alone. Evidence: `orkestrator-test-run.j0BPNV/merge-cli-package-alone.log.gz`.
- `e2e/agent-testing/packaged-electron-app.test.ts` still failed alone: 13 pass, one fail (0.9 s). Its Linux-path expectation disagrees with the macOS path returned on this host. Evidence: `orkestrator-test-run.9uNwJY/merge-packaged-fixture-alone.log.gz`.
- The aggregate also timed out `logins > Codex: a rotation and then a sign-out reach the home` in `apps/backend/tests/portable-inputs-stamps.test.ts` at 60,034.25 ms.
- `apps/backend/tests/portable-inputs-stamps.test.ts` did not settle its isolated rerun: `mise run test:logged -- --name merge-stamps-alone -- bun test --cwd apps/backend ./tests/portable-inputs-stamps.test.ts --parallel=1 --only-failures` was stopped by the logged runner after 300.1 s without output. Evidence: `orkestrator-test-run.dr0X64/merge-stamps-alone.log.gz`. No isolated pass or root cause is claimed.
- The restore-plan cap owner still timed out alone (19 pass, one fail and one between-test error in 11.8 s); the recurrence and exact command are recorded in [5360](../coordinator-and-multi-review/5360-measurement-file-cap-restore-plan-parallel-timeout.md).
- The isolated gateway/deletion smoke had 13 pass, 11 skip and two failures (422.7 s): signed-out recovery received signed-in auth, and the diff-baseline clear did not settle in 15 s. The real deletion-failure/inactive-view/reload/Retry scenario passed. Evidence: `orkestrator-test-run.EPovyT/merge-live-delete.log.gz` and `output/agent-testing/merge-delete-0bf060/browser/`. The disposable profile was stopped and reset.

Static checks and the resolved storage, protocol and row owners passed. The aggregate is not claimed green.

## Full browser suite

`mise run test:logged -- --name merge-browser -- mise run test:browser` exited 1 after 1,281.1 s: 1,517 pass, 135 skip and two failures. Both failures were `only the tab whose launch overrode the default is marked` in `e2e/TabLaunchOverride.spec.ts:8`, one at each viewport, because the expected button accessible name was absent. The requested badge itself passed its count, text and tooltip assertions. Original evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.Cfz7YY/merge-browser.log.gz`.

`mise run test:logged -- --name merge-tab-launch-alone -- bunx playwright test --config e2e/playwright.config.ts e2e/TabLaunchOverride.spec.ts --workers=1` reproduced both failures in the complete owner (four pass, two fail; 20.5 s). The owner and fixture match the target parent exactly. Isolated evidence: `orkestrator-test-run.j7kxnl/merge-tab-launch-alone.log.gz` under the same temporary root. This persistent failure is not classified as a flake.

Electron, Docker and iOS scenario suites were not run: the conflict resolutions do not change those execution paths. The disposable real-stack profile `merge-delete-0bf060` was stopped and reset; its deletion failure screenshot is `output/visual-previews/delete-retry-real-failure.png`.

## Second merge pass

The post-push fetch found six new target commits, ending at `df3037e291c4e230ab38dc22b689f368715b877f`.
The second merge conflicted only in the evidence catalogs, case prose and the
container todo index, including both endpoints of two evidence-case renames.
Main had independently repaired the case-number collision: its canonical files
are `6602-firewall-egress-filter-startup-timeout.md`,
`6603-container-status-excludes-aggregate-timeout.md` and
`9837-firewall-name-check-fixture-timeouts.md`. The resolution uses those names,
retains both branches' recurrence evidence, updates references and keeps the
environment-deletion follow-up alongside main's new todo entries.

The evidence catalogs are consumed by the registry consistency test, so this
pass validates that owner and repository static checks. Source, configuration
and tests from main merged without manual resolution; they do not widen this
pass's conflict-validation scope. The earlier aggregate and browser results
remain non-green as recorded above; this pass does not claim to repair them.

Second-pass validation: `mise run test:logged -- --name merge-pass2-static -- mise run check` passed (3.8 s); `mise run test:logged -- --name merge-pass2-registry -- bun test ./tests/unit/flaky-tests-index.test.ts --parallel=1 --only-failures` passed (0.3 s).

## Original conflict inventories

### Pass 1

- `apps/backend/src/core/storage-projects.ts`
- `apps/web/src/components/environments/EnvironmentItem.tsx`
- `apps/web/src/components/environments/environment-row-facts.ts`
- `apps/web/src/components/environments/environment-row-model.ts`
- `apps/web/src/components/federation/useMachineViews.ts`
- `docs/tests/flaky-tests/aggregate-validation-runs/0000-index.md`
- `docs/tests/flaky-tests/environments-and-containers/0000-index.md`
- `docs/tests/flaky-tests/native-agents-and-transcripts/0000-index.md`
- `docs/tests/flaky-tests/native-agents-and-transcripts/1102-claude-hook-concurrent-counter-snapshot.md`
- `docs/todo/containers-and-environments/0000-index.md`
- `packages/protocol/src/node-summaries.ts`

### Pass 2

- `docs/tests/flaky-tests/aggregate-validation-runs/6600-live-head-preparation-owners-vary-with-load.md`
- `docs/tests/flaky-tests/backend-services-and-tooling/0000-index.md`
- `docs/tests/flaky-tests/backend-services-and-tooling/6193-webkit-generation-reader-einval.md`
- `docs/tests/flaky-tests/environments-and-containers/0000-index.md`
- `docs/tests/flaky-tests/environments-and-containers/6602-firewall-egress-filter-startup-timeout.md`
- `docs/tests/flaky-tests/environments-and-containers/6603-container-status-excludes-aggregate-timeout.md`
- `docs/tests/flaky-tests/environments-and-containers/9834-container-status-excludes-aggregate-timeout.md`
- `docs/tests/flaky-tests/environments-and-containers/9834-firewall-egress-filter-startup-timeout.md`
- `docs/tests/flaky-tests/environments-and-containers/9837-firewall-egress-filter-startup-timeout.md`
- `docs/tests/flaky-tests/environments-and-containers/9838-container-status-excludes-aggregate-timeout.md`
- `docs/todo/containers-and-environments/0000-index.md`


## Follow-up review preparation at `228561646` — 2026-11-06

Original command: `mise run test:logged -- --name review-default-tests -- mise
run test`, backend four isolated workers. The workspace ended at the no-progress
watchdog with no closing summary, so complete totals are unavailable.
Original evidence remains under
`.orkestrator/review-artifacts/review-validation-dd80c812-46c6-4f02-b538-897dbf04bdfd/validation-04.stderr.txt`.

`container removal safety and shared revert behavior > revert restores a tracked
file from the base` (`apps/backend/src/core/commands-files-delete-folder.test.ts`)
timed out at 5,031.36 ms during `git diff --cached --name-status`.
At `b32cfe416`, the unchanged complete owner passed alone:
`mise run test:logged -- --name recorded-revert-alone -- bun test --cwd
apps/backend ./src/core/commands-files-delete-folder.test.ts --parallel=1
--only-failures` (exit 0, 24.4 s). Passing raw output was deleted, so totals are
not inferred. No assertion, skip or timeout changed; this is evidence of
intermittence, not a demonstrated cause or repair.

Readiness remains unresolved. Preparation's `a pending shell probe is clipped
to the remaining overall deadline` took 1,893.45 ms against its 1,500 ms cap.
The complete owner at `b32cfe416` failed alone in
`mise run test:logged -- --name recorded-readiness-alone -- bun test --cwd
apps/backend ./tests/container-readiness.test.ts --parallel=1 --only-failures`:
19 pass, two fail, 69 assertions (13.02 s). The same probe case took 2,996.14 ms;
`renews an expired shell wait window and accepts readiness in the next exec`
also returned `timed-out`. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.jqbt6D/recorded-readiness-alone.log.gz`.
These cases exercise the existing boot-wait path, not the changed deletion drain.
A combined three-owner run had passed earlier (24.9 s); that does not erase
the isolated failure or establish its cause. Neither assertion was changed.

## Follow-up rework rerun at `3bc01ae0b` — 2026-11-06

On 18 CPUs at load 36.9–41.4, the complete readiness owner passed alone three
times in a row (10.5 s, 10.4 s, 7.9 s):
`mise run test:logged -- --name readiness-alone-N -- bun test --cwd apps/backend
./tests/container-readiness.test.ts --parallel=1`. It passed again in a
nine-owner run with the listener, baseline, revert and deletion owners
(`related-owners-combined`, 36.7 s, exit 0), which shows no hang in those
owners at this commit. The earlier `recorded-related-owners` no-output watchdog
(`orkestrator-test-run.ovaWog`) kept only the runner header, so which file was
running when it fired is unknown.

The failing cases time a boot-wait probe, which calls `runCommand` without
`waitForTermination`. That path's timeout (SIGTERM, then SIGKILL and rejection
after the 100 ms grace) is unchanged by the branch; only the drain run by a
deletion opts into waiting for termination. The isolated failure at
`b32cfe416` came at a similar load, so this records intermittence, not a cause.
No assertion, timeout or skip changed.

## Review findings qualification after `b5ed29dce` — 2026-11-06

The review's claim that both delete-retry scenarios failed is contradicted by
its original machine-readable results. Both specs are `ok: true`, with a
`passed` result, in
`output/agent-testing/qa-browser-7f4ec5d2-d39/browser/results.json`.
The preserved `validation-07.stdout.txt` lists those scenarios as cases 152
and 153; its three failures are instead the two CLI project-expansion cases
and the terminal-input-resume case. The separate teardown error is the
terminal-input trace exceeding the 64 MiB sanitization bound. Neither the
original package nor its artifacts were modified.

Both delete-retry scenarios passed again, without changing their source,
in a fresh credential-free, Codex-only profile:

- Start: `mise run dev:test --profile delete-review-r2 --fixture --no-agent-credentials --agent-platforms codex --headless`.
- Check: `ORKESTRATOR_AGENT_TEST_PROFILE=delete-review-r2 ORKESTRATOR_AGENT_TEST_RUN_ID=delete-review-r2 mise run test:logged -- --name review-delete-retry -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts environment-delete-retry.spec.ts --workers=1`.
- Result: two passed, zero failed/skipped/flaky, 12.7 s. Machine-readable evidence: `output/agent-testing/delete-review-r2/browser/results.json`.
- Cleanup: `dev:stop` and `dev:reset` both succeeded; subsequent `dev:status --json` reports the profile missing with no live processes.

The macOS lost-exit owner also passed in 29.8 s:
`mise run test:logged -- --name review-macos-lost-exit -- bun test
./packages/protocol/src/node/command-capture-reap.integration.test.ts
--parallel=1 --only-failures`. This includes the termination-waiting abort,
timeout and overflow cases; these ran on Darwin rather than being skipped.

Added controlled real-helper exit coverage at two boundaries: the confined
removal promise and the delete command's Retry admission. Each test observes
SIGKILL but withholds delivery of the helper's actual exit. The promise and
delete guard must stay pending until delivery; afterward the delete reports
its deadline and Retry succeeds. The command test fires the real stage timer
only after helper startup, avoiding a race against unrelated Git startup.
No production behavior changed.

The two backend owners passed together in 5.4 s:
`mise run test:logged -- --name review-helper-guards-final -- bun test --cwd
apps/backend ./src/core/path-safety.test.ts
./src/core/commands-environment-cleanup.test.ts --parallel=1 --only-failures`.
Focused backend typechecking initially found seven missing parameter types in
these new test spies; explicit parameter tuples fixed all seven and the exact
package typecheck passed on rerun (0.6 s). The initial artifact is
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.ivmWjA/review-backend-types.log.gz`.
Web typechecking and the complete remote-row parity owner passed (0.7 s and
1.1 s). Edited-file formatting and lint checks passed.

The default suite's DOM scan included the branch-touched remote-row parity
owner. Its four DOM absence assertions now pass booleans to `expect`, keeping
failure diagnostics bounded, with the same assertions. The other four files
named by the original scan are unchanged by this branch. This repairs the
branch's contribution without rewriting unrelated tests.

The exact failed preparation command was rerun after the assertion repair:
`mise run test:logged -- --name review-default-rerun -- mise run test`.
It exited 1 in 223.5 s. Workspace, bridges and the Codex protocol group passed;
root/support had 3,747 pass and three fail across 196 files. The three original
egress qualification failures did not recur. The remote-row file is absent
from the remaining DOM scan failures.

Remaining failures and scope:

- DOM scan: `CoordinatorPanel.outcome.test.tsx`, `ProviderMcpSettings.test.tsx`, `ProjectHomeActivity.test.tsx` and `tests/unit/components/EnvironmentItem.test.tsx` remain; all four are unchanged by this branch. Preparation triage says `unrelated`, reason `failed-on-target-ci`; the branch-touched fifth file was repaired.
- Test ownership: the unchanged `electron-startup-recovery.integration.test.ts` is still unowned. Preparation triage says `unrelated`, reason `failed-on-target-ci`. Neither this file nor the ownership configuration is changed by the branch.
- Packaged-app path: the test expects `linux-arm64-unpacked`, while the helper defaults to `process.platform` and correctly returns `mac-arm64/...app/Contents/MacOS/OrkestratorV2` on this Darwin host. Both source and test are outside the diff. This is a demonstrated OS expectation mismatch, not a deletion-path failure.

Rerun evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.1PhcXT/review-default-rerun.log.gz`;
inner aggregate artifacts: `orkestrator-test-run.ZzfLGH` under the same parent.
The original review package and its output remain intact.

The broader browser commands were not repaired or rerun: preparation triage
leaves `TabLaunchOverride` (both viewports), the two CLI project-expansion
cases and terminal-input-resume `undetermined`/`not-import-traceable`. No cause
in the deletion diff was established. The 64 MiB terminal trace sanitization
failure also remains unresolved. The targeted two-case deletion qualification
is green; it does not claim those broader suites are green. No unrelated
assertion, timeout, skip or sanitizer bound was changed to hide a failure.

The evidence registry owner also passed: `mise run test:logged -- --name review-evidence-registry -- bun test ./tests/unit/flaky-tests-index.test.ts --parallel=1 --only-failures` (0.2 s).

## Scheduling repair validation, 2026-11-09

Observed on `project-scheduling-ac146edab2ff-r1`, base
`3cf3dd7994cb36954f0670430216a71c7b6505d9`, during the concurrent default
aggregate (workspace five worker slots, root one, bridges two, protocol one)
and five-worker component browser run. `mise run flaky:recurrence -- 9839
--base 3cf3dd7994cb36954f0670430216a71c7b6505d9 --registry-ref origin/main`
reported the case open and directed recording a recurrence.

Original command: `mise run test:logged -- --name address-full-tests -- mise run test`.
`bounded in-container boot wait > a pending shell probe is clipped to the
remaining overall deadline` in `apps/backend/tests/container-readiness.test.ts:392`
measured 1,901.728 ms, above its 1,500 ms cap (case duration 1,907.16 ms).
The workspace log is retained under
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.mX02WE/`.
The aggregate had not finished when the owner was rerun, so no complete total
is claimed here.

The unchanged complete owner passed with
`mise run test:logged -- --name container-readiness-isolated -- bun --cwd=apps/backend test tests/container-readiness.test.ts --parallel=2 --only-failures`
(exit 0, 9.6 s). Passing output was deleted by the runner; no isolated total
is claimed. No readiness source, timeout or assertion changed. The cause is
unconfirmed, and the isolated pass does not replace the aggregate failure.

## Worktree-watcher review recurrence — 2026-11-10

Observed in `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=7200000 mise run test:logged -- --name coverage-full-final -- mise run test` at `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`, base `08d3da4a23cfe2ecc34fba663ca27e765f7924a9`, macOS arm64/Bun 1.4.4. The workspace reserved six slots (web two, backend four), root one, bridges two and protocol one. The aggregate exited 1 after 2468.77 s; backend has no final counts because the workspace no-progress watchdog fired. Root reported 4274 pass/25 skip/4 fail; web 14336 pass/10 skip/2 fail; Pi 706 pass/1 skip/2 fail.

- `apps/backend/src/core/commands-files-delete-folder.test.ts` — `container removal safety and shared revert behavior > revert restores a tracked file from the base`: Test deadline 5,000 ms exceeded. Observed 6123.11ms. Complete unchanged owner: 25 pass, 0 fail, 0 skip in 18.14 s at `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`.

```sh
mise run test:logged -- --name watcher-triage-delete-folder -- bun test --cwd apps/backend ./src/core/commands-files-delete-folder.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/delete-folder.xml
```

`mise run flaky:recurrence -- 9839 --base 08d3da4a23cfe2ecc34fba663ca27e765f7924a9 --registry-ref origin/main` reported the case open; this records a recurrence.

Evidence: `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.dH765N/` (compressed group logs); JUnit under `/private/tmp/ork-watcher-failure-triage.0oarZv/`. [The complete report](../../../development/worktree-watcher-validation.md) contains the exact group outcomes, commands and non-green isolated owners. Passing alone establishes intermittence, not a cause or a fix. No related assertion, timeout, skip or implementation changed.
