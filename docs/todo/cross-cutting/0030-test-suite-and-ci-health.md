# Test suite and CI health

Checked against `main` at `bf49a751` (2026-10-25).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Apply the required-check ruleset**: once `main` has three green `CI` runs in a row, the maintainer applies the prepared ruleset (item 1). Status: open (the precondition is now met; maintainer action).
2. **Open CI flakes 0182 and 0672**: the Cursor HTTP readiness timeout and the Chromium page crash in the interactive preview case. Status: open.
3. **Owner flake cases from the triage**: create the cases the 2026-10-25 triage suggested but did not number. Status: open.
4. **Failures that are not flakes**: give `workspace-realm-electron.spec.ts:409`, the annotation Notes focus check, the `AgentLaunchDialog` branch suggestion and the 0723 exit-before-stderr race their own bug or todo. Status: open.
5. **Live hung-`close()` Electron check**: run a real Electron spec whose `close()` hangs and confirm `closeElectronWithin` cleans up. Status: open.
6. **Watch the workspace group margin and the runner shutdowns** (Needs verification). Status: open (margin currently comfortable).
7. **Deferred measurement work**: ACP transcript matrix, longest-first bridge scheduling, splitting backend `test:workspace`, and any resumed speed work. Status: deferred (until measured).

Item 1's evidence, items 2 to 6 and 8 to 10, and the flake triage are done; 0145 owns the stock-Ubuntu sandbox qualification.

### 1. Apply the required-check ruleset

**Problem.** `main` has no branch protection or ruleset, so a pull request can merge with failing lint, typecheck or tests. That is how `main` stayed red for days in October.

**Context.** The ruleset is the first `json` block in this file (parsed by `tests/unit/ci-workflows.test.ts`), approved on 2026-10-15; agents prepare it, the maintainer applies it after three consecutive green `CI` runs on `main`. The 0030 branch merged as `182a4031` (#1265, 2026-10-25).

**Investigation.** Checked today with read-only `gh` calls. `gh api repos/orkestrator-ai/orkestrator-v2/rulesets` still returns `[]`, and `branches/main/protection` still answers 404 "Branch not protected". `main` was red again after the branch merged: 36 of the last 40 `ci.yml` runs on `main` failed, every one in "Unit and integration tests", through `6dbfc47f` (run 40379705332, 2026-10-26 18:39). The failures were the same backend set in each run checked (for example "bounded bridge output > the writer writes a quiet producer's first line while its pipe stays open", "Electron backend command registry > starts the in-container Codex bridge …", "an exited container's final boot record > …"), so they were deterministic, not flakes; they stopped with `ce205ad3` (#1317, "keep bridge logs streaming and bounded"). Since then the last four runs are green: `ce205ad3` (40395650750), `9791a425` (40418381691), `1aabf049` (40424122650) and `863b5782` (40431509846). The three-green precondition is therefore met. The three contexts still match `ci.yml`'s job names. Newly noticed in those failure logs: a backend test (apparently `apps/backend/src/core/public-api/public-api-schedules.test.ts`, whose "scheduled audit" prompt is printed just before) reaches the real Codex naming path (`apps/backend/src/core/commands-agent-support.ts:109`) and spawns `codex`, which tries `wss://api.openai.com/v1/responses` and gets 401. It does not fail the test, but the unit suite makes an outbound network call; per the README rules that belongs in a new todo file.

**Decisions.**

- **Apply it now?**
  - **Yes: the maintainer applies it now, re-running the file's "Check first" commands immediately before (recommended).**
    - Pros: the precondition is met; every further unguarded day risks another multi-day red stretch like 2026-10-26's.
    - Cons: if the next run fails for an unrelated flake, merges block until it is rerun; the app's own `gh pr merge` path is refused until checks pass (intended).
  - **Wait for a longer green streak (for example a week).**
    - Pros: more confidence that `main` is stable.
    - Cons: the agreed rule was three; `main` has gone red within a day twice since 2026-10-23, which is exactly what the ruleset prevents.
- **Where to record the network-calling test?**
  - **A new todo file for making the schedule test hermetic (stub the naming command), linked from here (recommended).**
    - Pros: follows the README rule against adding todos to an existing file; a real fix (unit tests must not reach the network) with a clear owner.
    - Cons: one more small file.
  - **Leave it, since it does not fail.**
    - Pros: no work.
    - Cons: an outbound call from CI is non-hermetic and would leak credentials if the runner ever had a Codex login.

### 2. Open CI flakes 0182 and 0672

**Problem.** Two flakes can still turn a `main` run red once the ruleset is required, blocking merges.

**Context.** 0182 is `authentication > reports an authenticated credential as ready` in `bridges/cursor-bridge/src/http.test.ts`; 0672 is the interactive preview resource-escape case that crashed Chromium twice on CI.

**Investigation.** Both are still `open` in their group indexes. The number 0672 is used by five different case rows in the flake registry (MCP bridge validation, the preview crash, the executable-document policy, the container storage helper and a native-agent reconciliation case), which the file's "Living-doc drift" note already accepts; it makes references such as "flake 0672" ambiguous. The preview case is `apps/backend/src/core/transcript-artifacts/preview-interactive.test.ts:346`.

**Decisions.**

- **How to handle them before the ruleset bites?**
  - **Investigate 0672 first (a real browser crash, possibly memory on four cores), and add a bounded readiness budget to 0182 only if its case shows a fixed timeout as the cause (recommended).**
    - Pros: 0672 is the one that took down whole `main` runs; fixes stay evidence-led, as the constraints require.
    - Cons: a Chromium crash may not reproduce off the runner.
  - **Rely on rerunning failed jobs.**
    - Pros: no work.
    - Cons: the constraints forbid retries as a fix; a required check that flakes trains people to rerun blindly.
- **Should flake references name the file path rather than the number?**
  - **Yes, for reused numbers such as 0672, cite the case file name (recommended).**
    - Pros: unambiguous without renumbering.
    - Cons: longer references.
  - **Renumber the duplicates.**
    - Pros: restores unique ids.
    - Cons: the file already decided against it because prose references across cases would need rewriting.

### 3. Owner flake cases from the triage

**Problem.** The triage named owners with recurring failures but created no case for them, so their next recurrence has nowhere to be recorded.

**Context.** Named: `media-stream.browser.test.ts`, `cursor-bridge/src/initial-run.test.ts`, `RemoteWorkspaceRegion.test.tsx`, `workspace-setup-preserve.test.ts`, the two desktop shutdown-deadline cases in 0720, and the `review-validation-worker.test.ts` runner-slot case. No numbers were free on that branch (D12).

**Investigation.** Searching the group indexes: the first three appear only inside aggregate-run rows in `aggregate-validation-runs/0000-index.md`, not as their own cases; `workspace-setup-preserve` and "does not hold the local runner slot" appear in no index. None of the six has its own case.

**Decisions.**

- **Create them now or on recurrence?**
  - **Create each on its next recurrence, with that run's evidence (recommended).**
    - Pros: AGENTS.md defines a flake by an owner-file rerun; a case created now would have only second-hand evidence.
    - Cons: the triage's knowledge sits only in this file until then.
  - **Create all six now from the triage notes.**
    - Pros: future recurrences have a home at once.
    - Cons: cases without a captured failure message (the runner-slot one has none) are thin.

### 4. Failures that are not flakes

**Problem.** Some failures the triage found fail alone too, so they are bugs, but they have no owner file.

**Context.** `workspace-realm-electron.spec.ts:409` and the annotation Notes focus check (0740, 0772, 0789, 0790), the `AgentLaunchDialog.spec.ts` branch suggestion (only in 0493), and 0723's likely race at `commands-servers.ts`.

**Investigation.** The 0723 race is still present: the OpenCode server start decides its error in the `exit` listener (`child.once("exit", onExit)`, `apps/backend/src/core/commands-servers.ts:301`) from `stderrTail`, and stderr data can arrive after `exit` (Node and Bun emit `close` after the streams end). The locked-database message at `:292`-`:295` therefore depends on timing. The line number in the file (295) is now the message construction, not the decision.

**Decisions.**

- **Where should these go?**
  - **One new todo file per failure group (Electron realm and Notes focus; the launch-dialog branch suggestion; the OpenCode exit race) in the folder that owns the code (recommended).**
    - Pros: each lands next to related work and gets its own rating; the OpenCode race is a product bug (a wrong error message), not test health.
    - Cons: three small files.
  - **One combined "known failing specs" file here in cross-cutting.**
    - Pros: one place to look.
    - Cons: mixes unrelated owners; rates poorly as a whole.
- **How to fix the exit race?**
  - **Decide on `close` (after stdio ends) instead of `exit` (recommended).**
    - Pros: standard fix; stderr is complete by then.
    - Cons: `close` can be delayed by a grandchild holding the pipe; needs a bound.
  - **Wait a short grace after `exit` for more stderr.**
    - Pros: small change.
    - Cons: a timing heuristic, which the timer rules discourage.

### 5. Live hung-`close()` Electron check

**Problem.** The cleanup for a hung Electron `close()` is proved by unit tests and a 2 s throwaway run, but not by a real Electron spec whose `close()` hangs.

**Context.** Item 9 (done): `ownProcessGroup` (`e2e/process-cleanup.ts`), the worker fixture in `e2e/agent-testing/electron-fixtures.ts`, and `closeElectronWithin` (`e2e/agent-testing/design-electron-cleanup.ts:79`, 20 s bound).

**Investigation.** `tests/unit/electron-spec-process-ownership.test.ts` still guards the pattern. No spec forces a hang.

**Decisions.**

- **How to make `close()` hang for the check?**
  - **A temporary local edit that blocks the main process's `before-quit` in one spec, run once with `mise run test:agent:electron`, then reverted, with the leftover-process check recorded (recommended).**
    - Pros: real Electron, real process tree; no permanent test hook.
    - Cons: one-off evidence; not repeatable in CI.
  - **A permanent opt-in spec with a test-only hang switch in the main process.**
    - Pros: repeatable.
    - Cons: a production code path that exists only for tests.
  - **Retire the item, accepting the unit and throwaway-run evidence.**
    - Pros: no work.
    - Cons: the original leak was found only in real runs.

### 6. Watch the workspace group margin and the runner shutdowns

**Problem.** The workspace group could approach its 30-minute deadline (`DEFAULT_TEST_GROUP_TIMEOUT_MS`, `scripts/test-all.ts:203`) as the backend grows, and the 2026-10-24 runner shutdowns were never diagnosed.

**Context.** The test job's limit is 45 minutes (`.github/workflows/ci.yml:75`).

**Investigation.** The latest green run (40431509846) took 1,104 s for the workspace group, 152 s for root and 116 s for bridges, faster than the 1,215 to 1,296 s the file recorded, so the margin is about 12 minutes. No runner shutdown appears in the runs checked today.

**Decisions.**

- **Keep these as open verification items?**
  - **Keep the margin watch, and close the shutdown item if it has not recurred by the time the ruleset has been active for two weeks (recommended).**
    - Pros: the margin is cheap to read from each run; a non-recurring shutdown with an inferred cause has nothing left to verify.
    - Cons: if it returns later, the memory-capture idea must be rediscovered from git history.
  - **Add the `free -m` loop to the CI job now.**
    - Pros: evidence ready if it recurs.
    - Cons: noise in every run's log for an event not seen since 2026-10-24.

### 7. Deferred measurement work

**Problem.** Several speed ideas wait for a measurement; without one they risk either never happening or being done blind.

**Context.** ACP's `acp-transcript.test.ts` spawns a bridge in 77 places; ACP alone is about as long as the other four bridges; backend's build-dependent tests could be split; the constraints forbid concurrency changes without measurements.

**Investigation.** Bridges took 116 s in the latest green run, so longest-first scheduling would save little. Nothing has changed in `scripts/test-all.ts` planning since the file was written.

**Decisions.**

- **Keep or retire the deferred items?**
  - **Keep them deferred and leave the file's "start from the CI timings" note as the trigger (recommended).**
    - Pros: they are cheap to keep; the CI timings now come from every run.
    - Cons: the file stays open longer once items 1 to 6 close.
  - **Move them into a new speed-work todo file when items 1 to 6 close, so this file can finish.**
    - Pros: lets 0030 be finished and deleted.
    - Cons: one more file carrying deferred work.

`mise run test` should be fast and green, and stay that way, without weakening
what it proves. Every test file has exactly one owner, waits are controlled
rather than slept, and setup matches what each assertion needs. Most of the
2026-09-21 streamlining review landed in #815, #966 moved the backend and
desktop suites into their packages, and #1149 (2026-10-22) fixed the red `main`
of 2026-10-20 to 2026-10-22.

`main` went red again on 2026-10-23 and has stayed red since 2026-10-24
17:43: every `CI` run on `main` from then to 2026-10-25 12:00 failed "Unit and
integration tests".
Branch `todo-0030-test-suite-ci-health-e11a519267e2` (2026-10-25) fixes every
cause those runs showed, and a GitHub Actions run of the branch's exact
`ci.yml` jobs is the evidence (item 1). It also finishes items 3, 4, 6, 8 and 9 and
a triage of the flake registry. What remains
is the maintainer applying the prepared ruleset once `main` has three green
runs, two open CI flakes (0182, 0672), owner cases the triage suggested, and
one live check (an Electron spec with a hung `close()`).

## Current state

- **CI.** `.github/workflows/ci.yml` runs on pushes to `main` and on pull
  requests, with three jobs: "bun fmt and oxlint", "Typecheck", and "Unit and
  integration tests". `validate-bun-runtime.yml` builds the bundled Bun per
  platform and runs the container smoke. A failing group prints its output
  tail and then Bun's report for every failing test, and the test job uploads
  the compressed logs (`test-logs-<run>-<attempt>`) when it fails.
- **The runner is Ubuntu 26.04.** `ubuntu-latest` reported Ubuntu 26.04.1 LTS,
  kernel 7.0 (Azure), four cores and 16 GB on 2026-10-25 (probe run
  40193653132). Its image has no `zsh` or `fish`, has world-writable
  `/usr/share/zsh` completion directories, and loads AppArmor's
  `bwrap-userns-restrict` and `unprivileged_userns` profiles.
- **`main` is unprotected.** `gh api repos/orkestrator-ai/orkestrator-v2/branches/main/protection`
  answers 404 "Branch not protected", and `gh api repos/orkestrator-ai/orkestrator-v2/rulesets`
  returns `[]` (rechecked 2026-10-25). The maintainer approved the ruleset in
  item 1 on 2026-10-15.
- **`main` red from 2026-10-23 to 2026-10-25.** 44 `CI` runs on `main` failed
  between `39985615373` (#1190, 2026-10-23 16:17) and `40190229310` (#1245,
  2026-10-25 11:45), with a few green runs among them until `40115711165`
  (2026-10-24 17:20); every run after that failed.
  Lint and typecheck passed on every run; only "Unit and integration tests"
  failed. The causes, by count of runs:

  | Failure | Runs | Cause | Fix on this branch |
  | --- | ---: | --- | --- |
  | `mermaid rendering > enforces source bytes, edges and SVG limits at and over the boundary` | 26 | Five Chromium layouts on four cores took the 2,000-note diagram past the 5 s render deadline, so it failed as `render_timeout` before its SVG was counted. | That runner gets a 20 s render budget; every limit and the production deadline stay ([flake 0879](../../tests/flaky-tests/design-canvas-and-artifacts/0879-mermaid-limits-render-deadline-on-ci.md)). |
  | `Claude coordinator sandbox qualification > default-sandbox-writes` and `coordinator-sandbox-reads` | 20 | Every completed run since the test landed (#1217, 2026-10-24 17:43). Ubuntu's AppArmor bwrap profile strips capabilities from the nested user namespace the CLI's `apply-seccomp` creates, so every sandboxed command fails. The older live test only ever expected sandboxed commands to fail, so it never noticed. | CI removes the two AppArmor profiles and checks a nested namespace before the tests. The test now prints why a command failed. The product side is [0145](../agent-engines/0145-claude-linux-sandbox-apparmor-nested-userns.md). |
  | Runner "received a shutdown signal" about 5 minutes in | 8 | Started with #1227's own pull-request run (22:01) and stopped once #1236 changed the same tool-group animation code; pull-request runs in that window died the same way. The likely cause is a test from #1227 exhausting the runner; no runner diagnostics exist to confirm it. | None needed: gone since #1236. |
  | `native shell completion execution > zsh bashcompinit …` | 6 | Since #1246. The runner has no `zsh`; with it installed, `compinit` aborts on the world-writable completion directories because it cannot prompt. | CI installs `zsh` and `fish`; the test runs `compinit -u` and skips on a host without `zsh`. The fish test now runs on CI and checks short flags in a way fish 3.7 and 4 both answer. |
  | `interactive preview in Chromium > resource escape …` (`Page crashed`) | 2 | Unknown ([flake 0672](../../tests/flaky-tests/design-canvas-and-artifacts/0672-preview-interactive-chromium-page-crash.md)). | Registered recurrence; open. |
  | ACP composer patch/prompt race | 1 | The test assumed two concurrent requests overlap ([0875](../../tests/flaky-tests/agent-bridges/0875-acp-composer-patch-prompt-overlap-assumption.md)). | The fake agent holds the composer RPC, so the overlap is certain. |
  | ACP `401` after `spawnBridge` | 1 | Another server took the harness's released port; readiness checked only unauthenticated health ([0876](../../tests/flaky-tests/agent-bridges/0876-acp-harness-port-squatter-401.md)). | Reproduced and fixed. |
  | Claude persistence `EEXIST` | 1 | A previous test's unawaited preference write landed in the next test ([0877](../../tests/flaky-tests/agent-bridges/0877-claude-session-preference-write-crosses-tests.md)). | Shown and fixed. |
  | Interaction hold `rejected` | 1 | The fixture read the clock twice, so the pause could predate the request ([0878](../../tests/flaky-tests/native-agents-and-transcripts/0878-interaction-hold-fixture-clock-boundary.md)). | Reproduced and fixed. |

  The two failures named for this round are also settled. The OpenCode
  conformance owner already compares with `PINNED_TOOLCHAIN_VERSIONS.opencode`
  (changed by #1217) and passed 70 of 70 alone on 2026-10-25. The Firefox
  favicon case ([0697](../../tests/flaky-tests/design-canvas-and-artifacts/0697-artifact-engine-firefox-favicon-sink-hit.md))
  was Firefox's own UI fetching `/favicon.ico`; Firefox now launches with
  `browser.chrome.site_icons` off.
- **Earlier red periods, all fixed.** 2026-10-14 to 2026-10-18: the backend
  suite never finished under Turbo's grouped CI log order (#999 streams it),
  plus a credential-script `bash_logout` exit, a non-hermetic `gh` PATH, a
  four-core review-worker budget, `EMFILE` while signing the macOS bundle and
  load flakes 0160, 0176, 0232 and 0240. 2026-10-20 to 2026-10-22: Bun on Linux
  reports a removed watch root with an `undefined` filename, which crashed
  `worktree-watcher.ts` (#1149), plus flakes 0385/0473/0513 and 0671. The
  worktree persist-failure test (`commands-registry-environments.test.ts`) was
  fixed on 2026-10-18 by matching the canonical worktree path and preloading
  `tests/setup-node.ts` from `apps/backend/bunfig.toml`. Details are in git
  history and the flake cases.
- **Ownership guard.** `tests/unit/test-suite-ownership.test.ts` derives owners
  from `buildConcurrentGroups` (`scripts/test-all.ts`) and the package test
  selectors. It also rejects root tests that import backend or desktop
  sources.
- **Controlled time.** `tests/helpers/controlled-timeout.ts`
  (`installControlledTimeout`, with collision detection and `assertDrained`) is
  tested by `tests/unit/controlled-timeout.test.ts` and documented in the
  testing guide with the timer rules.
- **Task graph.** `apps/web`, `apps/web-public`, `apps/desktop` and
  `packages/protocol` set `test:workspace.dependsOn: []`; backend and CLI keep
  `dependsOn: ["build"]` because some of their tests consume `dist`. The
  workspace group asks Turbo for `build` and `test:workspace` in one
  invocation. `planWorkers` caps the aggregate at `MAX_AGGREGATE_TEST_WORKERS`
  (8). On a four-core host it plans Turbo `--concurrency=1` and one backend
  worker, so the workspace packages run one after another.
- **Timing on CI** (`main` runs 40187357422, 40189950916 and 40190229310,
  2026-10-25; Bun's own per-package totals):

  | Group or package | Time |
  | --- | ---: |
  | Workspace group | 1,215–1,296 s |
  | Backend package (669 files, 11,374 tests) | 700–755 s |
  | Web package (610 files, 9,670 tests) | 377–400 s |
  | Root and agent-support group | 199–214 s |
  | Bridges group | 145–191 s |
  | ACP bridge | 140–146 s |

## Outstanding work

### Code

1. **Confirm `main` stays green, then apply the approved ruleset.** This is a
   repository settings change for the maintainer; agents prepare it and do not
   apply it. Once `main` passes three `CI` runs in a row, apply the ruleset
   below. If a run fails first, fix or register the failure and restart the
   count.

   - **Done (2026-10-25): every failure since 2026-10-23 is fixed or
     registered** (table above).
   - **Evidence that the branch is green on the three required checks.**
     `CI` cannot run on a branch without a pull request, so a throwaway branch
     (`todo-0030-ci-probe-e11a519267e2`) dispatched `validate-bun-runtime.yml`
     with its own jobs skipped and `ci.yml`'s three jobs copied in unchanged
     (renamed "… (todo 0030 probe)"), on this branch's tree. Results:

     | Run | Tree | bun fmt and oxlint | Typecheck | Unit and integration tests |
     | --- | --- | --- | --- | --- |
     | 40197666008 | first commit (`75bf354fa`, the same content as rebased `0da1c6218`) | success | success | success: workspace 1,032.7 s, root 158.8 s, bridges 117.2 s |
     | 40198993774 | final head `bd7efe330`, rebased on `5a8b11b9` | success | success | success: workspace 1,209.4 s, root 201.5 s, bridges 150.4 s |

     Earlier probe runs found the Ubuntu 26.04 facts and the last two
     failures: 40193653132 (full suite plus diagnostics), 40195484352 (the
     AppArmor and zsh fixes, step by step) and 40195714408 (everything green
     except two root tests that read `main.ts` source, updated for the
     extracted window bookkeeping and the dev version). The probe branch was
     deleted after the evidence was recorded. These runs do not count towards
     the three green `main` runs. The branch was then rebased once more, onto
     `bf49a751` (#1250, #1252, which touch the e2e annotation helpers and
     flake indexes); that rebase was checked locally (`mise run check` and the
     affected root tests), not on Actions.
   - **Still to do (maintainer):** after the branch merges, wait for three
     consecutive green `CI` runs on `main`, then run the command below. `main`
     itself failed every completed run from 2026-10-24 17:43 to 2026-10-25
     11:45 (the last before this branch was written).
   - Required checks: `bun fmt and oxlint`, `Typecheck` and
     `Unit and integration tests` from `.github/workflows/ci.yml`, all reported
     by `github-actions` (app 15368). Rechecked on 2026-10-25 against the check
     runs of `20f6de91`. `tests/unit/ci-workflows.test.ts` fails if a context
     below stops matching a `ci.yml` job name.
   - Ruleset settings: target `main` (`~DEFAULT_BRANCH`), enforcement active,
     block deletion and force pushes, strict up-to-date checks off, enforce on
     branch creation, Admin role (`actor_id` 5) may always bypass.

   ```json
   {
     "name": "main: required CI",
     "target": "branch",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
     "bypass_actors": [{ "actor_type": "RepositoryRole", "actor_id": 5, "bypass_mode": "always" }],
     "rules": [
       { "type": "deletion" },
       { "type": "non_fast_forward" },
       {
         "type": "required_status_checks",
         "parameters": {
           "strict_required_status_checks_policy": false,
           "do_not_enforce_on_create": false,
           "required_status_checks": [
             { "context": "bun fmt and oxlint", "integration_id": 15368 },
             { "context": "Typecheck", "integration_id": 15368 },
             { "context": "Unit and integration tests", "integration_id": 15368 }
           ]
         }
       }
     ]
   }
   ```

   - Check first: `gh run list --branch main --workflow ci.yml --limit 3`
     shows three `success` runs, and
     `gh api repos/orkestrator-ai/orkestrator-v2/rulesets` still returns `[]`.
   - Apply from a checkout of `main` that contains this file. The command
     extracts the first `json` block, as `tests/unit/ci-workflows.test.ts` does:

     ```sh
     bun -e 'const doc = await Bun.file("docs/todo/cross-cutting/0030-test-suite-and-ci-health.md").text();
     process.stdout.write(doc.match(/\x60{3}json\s+([\s\S]*?)\x60{3}/)[1]);' |
       gh api -X POST repos/orkestrator-ai/orkestrator-v2/rulesets --input -
     ```

   - Verify: `gh api repos/orkestrator-ai/orkestrator-v2/rulesets` lists
     "main: required CI", and
     `gh api repos/orkestrator-ai/orkestrator-v2/rules/branches/main` returns
     the deletion, non-fast-forward and required-status-checks rules. Undo
     with `gh api -X DELETE repos/orkestrator-ai/orkestrator-v2/rulesets/<id>`.

   Why these settings:

   - The three contexts are the `ci.yml` job names, reported by
     `github-actions` (app 15368), as checked on `7ccb193e`, `c66604e2` and
     `20f6de91`. `actor_id` 5 is the repository Admin role. The lint job was
     renamed from "oxfmt and oxlint" to "bun fmt and oxlint" by #1229
     (2026-10-24); the ruleset uses the current name and the contract test
     keeps them in step.
   - Strict up-to-date checks stay off at first: about 226 pull requests a
     month and a 21-minute test job would serialise merges. Revisit with a
     merge queue, which needs a `merge_group:` trigger in `ci.yml`.
   - Repository admins may bypass, because version bumps are pushed to `main`
     directly. No workflow pushes to `main`. Moving the bumps to pull requests
     would allow pull-request-only bypass.
   - The Bundled Bun and Container checks are not required: that workflow is
     path-filtered, so a required check would stay pending on unrelated pull
     requests.
   - Once active, the app's merge (`gh pr merge` without `--admin`,
     `apps/backend/src/core/commands-review.ts`) is refused until the three
     checks pass. That is intended; the maintainer chose not to add `--admin`
     or `--auto`.
2. **Done (2026-10-22): `AddProjectDialog.test.tsx`.** The 2 s typed-path
   debounce is captured with `installControlledTimeout` (56.5 s to 2.1 s).
3. **Done (2026-10-25): remaining literal waits.**
   - `PersistentTerminal.test.tsx`: #1161 had already converted 13 of the 14
     waits (the file was about 3 s, not 7.9 s). The last 60 ms wait now
     captures the visibility redraw's 50 ms final-refresh timer
     (`persistent-terminal-redraw.ts`), which is armed only after both resize
     attempts, and asserts `resize` was never called. Three mutations (raw
     `resize` in the scheduled fit, in the redraw, or inside the timer) fail it.
   - `AgentNativeTab.test.tsx`: 24 of 33 waits converted, including 14 of the
     fifteen 120 ms resource-event waits. `deliverResourceChange` captures the
     50 ms coalescing timer (`resource-sync.ts`, `COALESCE_MS`), checks exactly
     one timer armed and none dropped, then waits for the read coordinator to
     go idle (`getDiagnostics()`). The 16 affected tests went from about 2.6 s
     to 0.8–1.7 s. With `COALESCE_MS` at 200 ms, 15 of them fail; with the old
     sleeps only 3 did.
   - Kept, each with a reason in the test review: line 7413 (120 ms, `ensure`
     finishing while inactive has no observable signal), 7347, 8016 and 8039
     (negative windows with no signal), 6656, 6759, 8897, 9329 and 3847 (no
     production timer: a regression would be a mount effect or render loop).
   - Both files passed 5 runs in a row, and the web package passed (9,660
     pass, 10 skip).
4. **Done (2026-10-25): backend slow owners.** Measured alone, macOS.
   - Done: `review-validation-worker.test.ts`. The worker already honours
     `ORKESTRATOR_TEST_QUEUE_TIMEOUT_MS`; `a command that expires while queued
     keeps no stale queue explanation` now uses 3 s instead of 6 s and watches
     the worker's state file instead of starting a control process per check
     (6.4 s to 3.3–3.4 s). Three mutations fail it. The other cases sit on the
     worker's 1 s minimum for its test overrides, or need 1 s of CPU
     measurement.
   - Done: `public-api-exec.test.ts`. #1161 had already given the three
     TERM-ignoring cases a 500 ms test-only grace
     (`ORKESTRATOR_TEST_EXEC_KILL_GRACE_MS`, default 5000, clamped to
     100–5000; 14.4 s for the file). `exec-worker.test.ts` pins the 5 s default
     on a stepped clock and now also covers an empty and a zero value.
   - Done: spawn profiles. `commands-integration.test.ts` (14.5 s, 55 cases):
     457 spawns, 272 of them real `git`, from the production code under test;
     `createGitWorktreeWithOrigin` builds its repository once. No fixture waste.
     `tmux-session.test.ts` (15.7 s, 71 cases): 237 spawns, almost all to the
     fake `tmux`; the time is the real 250 ms poll loop (`POLL_INTERVAL_MS`).
   - Done: `tmux-session.test.ts` steps the poll. Nine hook and notification
     cases use the existing `pollTick` seam (`pollTickStepper()`): each former
     wait for the 250 ms tick is one `ticks.step()`, and the snapshot-failure
     case steps the 3 ticks its 750 ms wait covered and now also asserts the
     warning fired 3 times. The stepper fails if the loop does not park again
     within 5 s instead of hanging. The `delay(25)` before each "nothing
     happened" assertion stays: it waits for the notification's promise chain,
     not a tick. 18.5 s to 8–12 s (sum of cases 17.8 s to 10.4 s); 8 runs
     passed; 9 mutations of `tmux-session-manager.ts` each failed a case.
5. **Done (2026-10-22): skipped settings test.** It runs again, stepping the
   controlled debounce per attempt.
6. **Done (2026-10-25): desktop test gaps.**
   - `BackendProcess.launch` startup boundaries (2026-10-22).
   - `main.ts` window and connection bookkeeping now lives in
     `apps/desktop/electron/desktop-window-contexts.ts` (`DesktopWindowContexts`,
     injected Electron dependencies, in the style of `RealmContexts`), and
     `main.ts` wires it. `apps/desktop/tests/desktop-window-contexts.test.ts`
     has 16 tests: registration and focus, `forEvent` for windows, realms and
     unknown or closed senders, the teardown order on close, focus hand-off,
     `emitToConnection` reaching only that connection's renderers and portals,
     `useConnection` swapping the previews and leaving them when the switch
     fails, and a window closing mid-switch. 41 mutations each failed a test
     (one was a no-op). The desktop package passed (1,253 pass, 14 skip).
7. **Flakes.**
   - Done (2026-10-25): triage of 0694–0849. Of 59 rows (0697 aside), 10 are
     resolved (four duplicates folded: 0765 into 0746, 0791 previews into
     0780, 0800 into 0791 bridges, and run records whose owners have cases),
     13 are environmental (documented load around 50 or more, or live Docker
     and profiles on the same host) and 36 stay open, each with a concrete
     next step in its case.
   - Done (2026-10-25): resolved with a shown cause 0179 (the ACP harness
     child announced `ready` before installing its SIGTERM handler), 0697,
     0875 (the fake ACP agent now holds composer RPCs, so all three race
     orders overlap deterministically; removing the bridge's claim or busy
     check fails them), 0876, 0877, 0878 and 0879. 0258 (fixture digest) got
     the explicit 30 s budget its case asked for after failing alone 3 of 3 at
     load 45, then passed 3 of 3.
   - Done (2026-10-25): the gateway-auth part of 0006 is resolved: no
     recurrence since the 2026-09-21 fixture correction, and 10 of 10 runs
     passed. The rest of 0006 (a 2026-09-08 aggregate timeout cluster) stays
     open.
   - **Still to do:** 0182 (Cursor HTTP hooks) and 0672 (Chromium page crash)
     on CI. Owner cases
     the triage suggested but did not create (no numbers were free):
     `media-stream.browser.test.ts` (timed out in 0694, 0801 and 0825),
     `cursor-bridge/src/initial-run.test.ts`, `RemoteWorkspaceRegion.test.tsx`
     (five `postMessage` calls instead of zero), `workspace-setup-preserve.test.ts`
     and the two desktop shutdown-deadline cases in 0720. One more: `a
     cooperative command queued on the host does not hold the local runner slot`
     (`review-validation-worker.test.ts`) failed once in a baseline run and
     passed alone and in three full runs; its message was not captured.
   - Not flakes, found by the triage: `workspace-realm-electron.spec.ts:409`
     and the annotation Notes focus check fail alone too (0740, 0772, 0789,
     0790), and `AgentLaunchDialog.spec.ts`'s branch suggestion fails on
     `main` (tracked only in 0493). They need a bug or todo of their own.
     0723 points at a likely product race: `commands-servers.ts:295` decides
     the error on `exit`, before stderr ("database is locked") may arrive.
8. **Done (2026-10-25): dev profiles report the real version.**
   `desktopApplicationVersion(app)` (`apps/desktop/electron/app-version.ts`)
   returns `app.getVersion()` when packaged and the desktop `package.json`
   version otherwise, and `main.ts` passes it to the backend.
   `apps/desktop/tests/app-version.test.ts` fails with `Received: "45.0.0"`
   without the fix. Live: a `dev:test` profile (`t0030-version`, stopped and
   reset afterwards) logged
   `Host executable discovery ready: version=2.30.0-beta`. The banner itself
   was not looked at in a browser. Electron's app name and `userData` are
   unchanged.
9. **Done (2026-10-25): Electron specs no longer leak their Vite server.**
   `ownProcessGroup` (`e2e/process-cleanup.ts`) records each detached group
   and kills any still recorded when the worker exits; a worker-scoped
   automatic fixture (`e2e/agent-testing/electron-fixtures.ts`) stops them in
   teardown; `closeElectronWithin` (`e2e/agent-testing/design-electron-cleanup.ts`)
   bounds `close()` and kills the Electron tree when it hangs or fails. Every
   `*-electron.spec.ts` uses them. `tests/unit/electron-spec-process-ownership.test.ts`
   (5 tests) fails with each part removed. A throwaway Playwright run with a
   2 s timeout leaked the old pattern's process group and left nothing with
   the new one. Not run: a real Electron spec with a hung `close()`.
10. **Done (2026-10-22): the Codex bridge listened on import in a test**
    ([flake 0660](../../tests/flaky-tests/agent-bridges/0660-codex-item-to-parts-inherited-port.md)).

### Qualification

- Three consecutive green `CI` runs on `main` after the branch merges (item 1).
  The branch's evidence is one GitHub Actions run of the same jobs on the same
  runner image, not `main`.
- 0145 needs stock Ubuntu 24.04 and 26.04 hosts; CI only proves the runner.
- If speed work resumes, start from the CI timings above and one quiet warm
  local run. Record queue and execution time separately (the aggregate
  `elapsedMs` includes admission waiting), peak process-tree memory, and a
  two-worktree contention check.

### Deferred until measured

- **ACP transcript matrix.** `bridges/acp-bridge/src/acp-transcript.test.ts`
  spawns a bridge in 77 places. Direct tests of the parse and merge functions
  already exist in `acp-tools.test.ts`, but the subprocess cases also assert
  ordering, acknowledgement and transport lifecycle. Re-measure before moving
  any.
- **Longest-first bridge scheduling.** Still not warranted: on CI, ACP
  (140–152 s) is about as long as the other four bridges combined (about
  140 s).
- **Barrel and type-only runtime tests** were kept on purpose: they exercise
  import initialisation. `apps/web/src/types/index.test.ts` is also compiled by
  the web typecheck.
- **Split backend `test:workspace`** into source tests and the
  artifact-consuming tests. Not now (see Open questions).

## Constraints and rationale

- Do not use retries, skips, weaker assertions, disabled isolation or higher
  concurrency as speed fixes. A speedup that adds flakes, memory pressure or
  incomplete validation is not accepted.
- Test-result caching stays off while the flake registry is active. Keep the
  8-worker aggregate ceiling and memory admission.
- Never change production debounce or retry constants to make tests cheaper.
- **Timer rules** (also in the testing guide's "Controlled time").
  - A negative assertion needs evidence that its deadline has passed. Do not
    shorten a sleep without that.
  - Fake time in the parent cannot advance a child process; use an explicit
    completion signal or a controllable fixture boundary.
  - Avoid global fake time across a real HTTP handshake.
  - Never run all timers on loops that re-arm themselves (retries, polling).
  - Install controlled time before rendering, advance inside `act`, settle the
    promises the advance triggers, and restore real time even when an
    assertion fails.
  - Do not swap a sleep for an async query that waits the same wall time.
- Keep subprocess tests wherever the assertion depends on transport, restart,
  replay, acknowledgement or lifecycle.
- **Similar names are not duplicates.** Root and web `gitUrl`, `utils`,
  `CreateEnvironmentDialog` and `NativeMessage` suites test different things.
  The ACP and Cursor attachment suites guard separate implementations of one
  trust boundary. The root and backend path-safety suites protect different
  readers and writers. Remove a case only with an old-to-retained mapping.
- Keep coverage of the reliability invariants at more than one boundary:
  inactive-environment catch-up, SSE replay, at-most-once dispatch, fail-closed
  approvals, generation loss, bounded buffers and subprocess cleanup. Keep real
  SDK and transport regressions and packaged-backend and CLI smoke tests.
- **Task-graph rationale.** Source-only tests must not wait for their
  package's production build, but every build stays in the authoritative run.
  Web, web-public, desktop and protocol tests consume no build output. Backend
  and CLI keep the build dependency because some of their tests consume `dist`.
  Requesting `build` and `test:workspace` in one Turbo invocation keeps every
  build while letting independent tests overlap them. The first measurement
  saw web tests start 3.6 s into the group instead of after a 136 s build.

## Open questions

- **Is backend the critical path of the workspace group, so that splitting
  its build-dependent tests is worth it?** Answered 2026-10-25 from CI: yes,
  backend is the critical path (700–755 s of a 1,215–1,296 s group), but a split
  would only let backend's source tests start before its build, which is a
  small part of that. Most of the group's time is that four cores give it
  Turbo `--concurrency=1` and one backend worker, so backend and web run one
  after the other. Changing that is a concurrency change, which the
  constraints rule out without measurements. Not split.
- **Should the testing guide carry current reference timings?** Answered: yes.
  [`testing-guide.md`](../../development/testing-guide.md) now gives the
  GitHub runner's group and package times (dated) beside the old 18-core
  figures, and says the workspace group is the group closest to the 30-minute
  group limit.

## Needs verification

- **The workspace group's margin.** On CI it takes 20–22 minutes against the
  runner's 30-minute group deadline (`DEFAULT_TEST_GROUP_TIMEOUT_MS`) and the
  job's 45 minutes. Watch it as the backend package grows.
- **The 2026-10-24 runner shutdowns.** The cause is inferred from which
  commits bracket them; if they return, capture the runner's memory (for
  example a background `free -m` loop in the job) before the next attempt.

## Assumptions and decisions

Decisions made on 2026-10-25 for this round, with the options weighed.

- **D1. How to get GitHub Actions evidence without a pull request.**
  - Options: (a) open a draft pull request; (b) wait for the merge and use
    `main`'s runs; (c) push a throwaway branch and dispatch an existing
    `workflow_dispatch` workflow whose file on that branch runs `ci.yml`'s jobs;
    (d) rely on a local Linux container.
  - Choice: (c), plus (d) for quick iteration.
  - Why: the brief said not to open a pull request, `CI` has no manual
    trigger, and a container did not reproduce the runner (the sandbox passed
    in a privileged Debian container). Only the real runner showed Ubuntu
    26.04, its AppArmor profiles and its zsh directories.
  - Pros: real runner, real image, this branch's exact tree and job
    definitions. Cons: uses Actions minutes; the check names carry a
    "(todo 0030 probe)" suffix and the checks are not attached to `main`, so it
    does not count towards the three green runs.
- **D2. The Claude sandbox on the runner.**
  - Options: (a) skip the positive cases on Linux CI; (b) relax the test to
    accept a failing command; (c) change the runner's AppArmor policy so the
    CLI's nested namespace works, and check it in the setup step; (d) run the
    test in a privileged container.
  - Choice: (c), with the product gap filed as 0145.
  - Why: (a) and (b) hide a real defect. Probe run 40195484352 showed neither
    sysctl is enough; only removing `bwrap-userns-restrict` and
    `unprivileged_userns` lets the nested namespace work, so CI applies exactly
    the tested combination.
  - Pros: the qualification proves real containment on Linux again; a policy
    regression fails at setup with a clear message. Cons: CI no longer matches
    a stock Ubuntu host, which is exactly where 0145's users fail.
- **D3. Mermaid size-limit case.**
  - Options: (a) render the five diagrams one at a time; (b) give that runner
    a longer render budget; (c) shrink the 2,000-note diagram; (d) raise the
    production 5 s deadline.
  - Choice: (b), 20 s, under the 30 s worker wall budget.
  - Why: the case tests the size limits, and the deadline has its own
    watchdog case. (a) loses the concurrent admission it also covers, (c)
    risks no longer exceeding 5,000 elements, and (d) changes production.
  - Pros: smallest change, production unchanged. Cons: on a host slow enough
    to pass 20 s it would fail again, now as an obvious timing problem.
- **D4. zsh and fish completion tests.**
  - Options: (a) `skipIf` without zsh, as fish already did; (b) install both
    shells on CI and keep skips for local hosts; (c) require them everywhere.
  - Choice: (b), with a contract test that the install line lists `zsh`,
    `fish`, `bubblewrap` and `socat`; `compinit -u`; the fish short-flag check
    asks for completions of `-`.
  - Why: (a) alone leaves both tests vacuous on CI. Ubuntu's fish 4.2 and 3.7
    differ on completing a finished `-h`, and the runner's completion
    directories are world-writable.
  - Pros: both scripts run on CI against real shells. Cons: two more apt
    packages in the job; `-u` skips an audit that does not concern the test.
- **D5. Firefox favicon (0697).**
  - Options: (a) ignore `/favicon.ico` in the sink; (b) give every sink
    response a `data:` icon (already done, not enough); (c) turn off Firefox's
    site icons.
  - Choice: (c).
  - Why: the request comes from the browser's UI, not the document, so it is
    not something the policy governs; (a) would weaken a sink that must see
    nothing. A probe showed 1 request by default and 0 with the preference.
  - Pros: the zero-hit assertion is unchanged. Cons: the failure did not
    reproduce here, so the fix rests on the mechanism check, not an A/B run.
- **D6. ACP harness port (0876).**
  - Options: (a) let the bridge bind port 0 and report its port; (b) make
    readiness prove it is our child and replace a child that exits while
    starting.
  - Choice: (b), up to three fresh-port attempts.
  - Why: (a) changes the bridge's startup contract for a test problem. (b)
    retries only the port allocation, never a request the test asserts on.
  - Pros: harness-only, reproduced and fixed. Cons: a bridge that keeps dying
    at startup is reported after three attempts instead of one.
- **D7. Cross-test preference writes (0877).**
  - Options: (a) await the write in the one test that failed; (b) settle every
    pending preference write in the shared `afterEach`.
  - Choice: (b), through `settleSessionPreferenceWritesForTesting()`.
  - Why: 11 tests in the file end with a write pending, so any of them can
    leak into the next. Pros: closes the whole class. Cons: a test-only export
    in a production module.
- **D8. `public-api-exec` default-grace case.**
  - Options: (a) one end-to-end case on the real 5 s grace (about +5 s);
    (b) keep the 500 ms override everywhere and rely on `exec-worker.test.ts`,
    which runs the real worker script on a stepped clock.
  - Choice: (b).
  - Why: (b) already pins the exact default (absent, empty, zero, invalid),
    and the item's purpose is a faster suite. Pros: no added time. Cons: no
    wall-clock proof of the 5 s escalation in the full exec path.
- **D9. Literal waits that stay.** Nine `AgentNativeTab` waits stay because
  nothing observable signals the end of their window and no production timer
  is involved; converting them would mean adding production hooks only for
  tests. The coalescing clock is installed around each dispatch rather than
  before render, so unrelated 50 ms timers in the tree stay out; a collision
  still fails on the armed and dropped checks.
- **D10. Dev version (item 8).**
  - Options: (a) have the dev launcher export a version; (b) read the desktop
    `package.json` version when `app.isPackaged` is false; (c) point Electron
    at `apps/desktop`.
  - Choice: (b).
  - Why: nothing reads a launcher variable today and the backend environment
    deliberately overwrites `ORKESTRATOR_VERSION`; (c) may move `userData`.
  - Pros: covers `dev` and `dev:test`, no launcher change. Cons: assumes the
    desktop and web manifests match, which `set-version.ts` keeps true.
- **D11. Electron spec cleanup (item 9).** A worker-scoped automatic fixture,
  not per-test, because two specs start Vite in `beforeAll`; plus a
  synchronous exit hook for a worker torn down mid-test, and a 20 s bound on
  `close()`. A worker killed with SIGKILL still cannot clean up.
- **D12. Flake triage cut-off.** Load timeouts are environmental only when
  the record shows load around 50 or more, or live Docker suites or profiles
  on the same host; single 5 s timeouts at moderate load stay open with
  "explicit budget, or environmental if it does not recur". Suggested owner
  cases were listed instead of created, because only five new case numbers
  (0875–0879) were available and they went to the CI failures.
- **D13. The ruleset.** Unchanged from the version approved on 2026-10-15; only
  its inputs were rechecked. It is not applied: applying it is the
  maintainer's call, after three green `main` runs.

## Related

- [Flake registry](../../tests/flaky-tests/0000-index.md); this round:
  [0179](../../tests/flaky-tests/agent-bridges/0179-acp-harness-child-exit-publication.md),
  [0672](../../tests/flaky-tests/design-canvas-and-artifacts/0672-preview-interactive-chromium-page-crash.md),
  [0697](../../tests/flaky-tests/design-canvas-and-artifacts/0697-artifact-engine-firefox-favicon-sink-hit.md),
  [0875](../../tests/flaky-tests/agent-bridges/0875-acp-composer-patch-prompt-overlap-assumption.md),
  [0876](../../tests/flaky-tests/agent-bridges/0876-acp-harness-port-squatter-401.md),
  [0877](../../tests/flaky-tests/agent-bridges/0877-claude-session-preference-write-crosses-tests.md),
  [0878](../../tests/flaky-tests/native-agents-and-transcripts/0878-interaction-hold-fixture-clock-boundary.md),
  [0879](../../tests/flaky-tests/design-canvas-and-artifacts/0879-mermaid-limits-render-deadline-on-ci.md);
  still open from earlier rounds:
  [0006](../../tests/flaky-tests/aggregate-validation-runs/0006-2026-09-08-coordinator-action-validation.md),
  [0182](../../tests/flaky-tests/agent-bridges/0182-cursor-auth-readiness-aggregate-timeout.md).
- [0145-claude-linux-sandbox-apparmor-nested-userns.md](../agent-engines/0145-claude-linux-sandbox-apparmor-nested-userns.md):
  the product side of the CI sandbox failure.
- [0731-ci-backend-test-spawns-real-codex.md](0731-ci-backend-test-spawns-real-codex.md):
  the schedule tests that run the real Codex naming call, split out.
- [0031-live-provider-and-platform-qualification.md](0031-live-provider-and-platform-qualification.md)
  for runs CI cannot do.
- [0023-environment-and-disk-cleanup.md](../containers-and-environments/0023-environment-and-disk-cleanup.md) for test
  temp-directory leaks.
- Other residuals from the 2026-09-15 security review: restricted containers
  still need `NET_ADMIN`
  ([0018-container-network-and-credential-isolation.md](../containers-and-environments/0018-container-network-and-credential-isolation.md)).
  Renderer windows keep `sandbox: false` as a documented exception for ESM
  preloads (`apps/desktop/electron/window.ts`); emitting CJS preloads would
  allow `sandbox: true`.
- Living-doc drift: the flake registry reuses IDs on two or three case files
  each: 0147, 0151, 0161–0164, 0176, 0512–0518, 0672, 0694 (three), 0721,
  0724, 0785, 0786, 0790 (three) and 0791. Renumbering means rewriting prose
  references across case files; decided not to renumber, and new entries
  take numbers assigned per branch.

## Replaces

- `docs/improvements/streamlining-tests.md`
- `docs/improvements/streamlining-tests/plan/00-index.md`
- `docs/improvements/streamlining-tests/plan/01-baseline-and-coverage-inventory.md`
- `docs/improvements/streamlining-tests/plan/02-gateway-expiry-fixture.md`
- `docs/improvements/streamlining-tests/plan/03-settings-autosave-time.md`
- `docs/improvements/streamlining-tests/plan/04-terminal-and-native-session-time.md`
- `docs/improvements/streamlining-tests/plan/05-test-ownership-and-duplicates.md`
- `docs/improvements/streamlining-tests/plan/06-runtime-preloads.md`
- `docs/improvements/streamlining-tests/plan/07-acp-test-layers.md`
- `docs/improvements/streamlining-tests/plan/08-backend-and-command-fixtures.md`
- `docs/improvements/streamlining-tests/plan/09-build-and-test-task-graph.md`
- `docs/improvements/streamlining-tests/plan/10-bridge-package-scheduling.md`
- `docs/improvements/streamlining-tests/plan/11-validation-and-rollout.md`
- `docs/reviews/2026-09-15-fable-review.md` (residuals: branch protection and
  red CI, desktop test gaps, and pointers for `NET_ADMIN` and the renderer
  sandbox)

## CLI matrices second main merge validation (2026-10-18)

Merged `origin/main` at `c85ab60a` into branch baseline `9467f965`. Formatting, lint, typechecking, backend and renderer build tasks, all local Markdown link targets, and eight production public-site browser cases passed. The full non-iOS suite exited 1 after 1132.1 seconds: root/support passed 3084 tests with one skip; every workspace package except backend passed; backend reported 9081 passed, 41 skipped and 11 failed across 9133 tests. Claude's one bridge fixture race passed its unchanged owner; all other bridges and protocol regeneration passed.

Focused backend reruns passed the orphan-age, terminal-history, skill-scan, capability-version, environment-status, retaining-close, startup-readiness and observation-baseline owners. Coordinator bound-discard still timed out after the aggregate with late SQLite fixture errors (56 passed, one failed across its file and the baseline owner). Details are in flaky-test cases 0151, 0165, 0177, 0212, 0213, 0385, 0441 and 0442. No test skip, assertion, timeout or implementation was changed for this validation.

`mise run test:browser` reported 339 passed, 80 skipped and 13 failed. The nine unchanged owners rerun with one worker reported 96 passed, 15 skipped and three failed: both canvas viewports timed out, and mobile diff-viewer Monaco was absent. The seven other owners passed. Commands and bounded failure evidence are in cases 0173, 0174, 0254 and 0382. The public-site task ran separately after the component command short-circuited and passed all eight cases.

The isolated browser run selected 61 cases and reported 27 passed, 32 skipped and two failed. The gateway-only rerun on a fresh credential-free profile selected 20 cases and reported 13 passed, five skipped and two failed. The first run's narrow host-picker failure passed in the rerun, but these gateway assertions remain unresolved:

- `persisted diff baselines keep Files, the badge and diff tabs aligned after background changes and reload` (`browser-gateway.spec.ts:2182`): the `vs <tip>` header was absent at its five-second deadline in both runs.
- `signed-out Codex recovery and account reads survive reload and environment switches` (`browser-gateway.spec.ts:880`): the exact `Sign in to Codex` button was absent at its 60-second deadline in the owning-file rerun. It passed in the aggregate, but the whole owner did not pass; no new flake classification is made here.

Exact isolated/gateway commands, profile names and evidence paths are in case 0224. Both disposable profiles were stopped and reset. Docker lifecycle, Electron main/preload and iOS code were unchanged, so those scenario suites were omitted. Credentialed live-provider suites retain their explicit opt-ins and were not enabled; the credential-free inactive/reload paths were exercised.
