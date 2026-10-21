# Test suite and CI health

Checked against `main` at `830c3abb` (2026-10-15).

`mise run test` should be fast and green, and stay that way, without weakening
what it proves. Every test file has exactly one owner, waits are controlled
rather than slept, and setup matches what each assertion needs. Most of the
2026-09-21 streamlining review landed in #815, and #966 moved the backend and
desktop suites into their packages. What remains is a set of slow owners, one
untracked skipped test, and two desktop test gaps. More urgently, CI is not
reliably green on `main`, and nothing requires it to be.

## Current state

- **CI.** `.github/workflows/ci.yml` runs on pushes to `main` and on pull
  requests, with three jobs: "oxfmt and oxlint", "Typecheck", and "Unit and
  integration tests". `validate-bun-runtime.yml` builds the bundled Bun per
  platform and runs the container smoke. A failing group prints its output
  tail and then Bun's report for every failing test. Since 2026-10-15 that
  includes failures the 256 KiB tail lost: PR #1008's first run failed one web
  test whose name never reached the log. The test job also uploads the
  compressed logs (`test-logs-<run>-<attempt>`) when it fails.
- **`main` is unprotected.** `gh api repos/{owner}/{repo}/branches/main/protection`
  answers 404 "Branch not protected", and the repository has no rulesets
  (checked at `7ccb193e`). The maintainer approved the ruleset in item 1 on
  2026-10-15.
- **`main` is intermittently red.** Lint and typecheck pass on every run. #999
  (`cefcaf69`) made the backend suite finish on CI. Of the four `main` and
  pull-request runs that then completed it, only `5c7517eb` (#1001, run
  38778314321) passed. It was the first green `lint.yml` run on `main` since
  2026-09-30 (run 36746796730). The runs since #999 surfaced three more
  failures, now addressed:
  - **Real-Chromium design renderer** (flake 0246, open): the launch missed
    its 15 s deadline on three of the four runs. The case now allows 45 s and
    prints Playwright's launch log on failure. A separate real-browser case
    uses the production 15 s budget and checks successful rendering or the
    bounded startup failure state; timeout warnings still require follow-up.
    The cause is unconfirmed.
  - **`environment cleanup steps`, the two container cases** (one run): the
    ownership probe before `docker rm` called the runner's real Docker, so an
    unreachable daemon, or `c1` prefixing another object, refused before the
    injected runner ran. Both now pass `containerOwnershipVerified`. The
    probe's verdicts are covered in `container-lifecycle-service.test.ts`.
  - **Multi Review slow-reviewer benchmark** (flake 0171, resolved): 630 ms
    against a 310 ms bound. It now asserts dispatch ordering, not wall time.

  An investigation of the 15 completed runs on 2026-10-14 and 2026-10-15,
  before #999, found these causes; the first five are fixed:
  - **The backend suite never finished on CI.** Turbo's default log order is
    `grouped` in CI, so a package task prints nothing until it exits. The
    four-core runner gives each package one Bun worker, and the backend
    package needs at least eight minutes (481 s locally on one worker), so the
    runner's five-minute no-progress watchdog killed the workspace group on
    every run. Failures after the kill point were never seen. The aggregate
    now pins `--log-order=stream` and `--continue=dependencies-successful`.
  - **Credential write** (`claude-credential-injection.test.ts`): Turbo drops
    `SHLVL`, so `bash -lc` ran Debian's default `~/.bash_logout` on the
    script's early `exit 0`, and `clear_console` failing under `set -e` turned
    it into status 1. The script now guards the write instead of exiting.
  - **`GitHub CLI setup > reports a missing gh`**: the fixture's PATH included
    `/usr/bin`, where the runner has `gh`. The PATH is now hermetic.
  - **Two `review-validation-worker.test.ts` cases**: an unmeasured command
    asks for four host slots and the budget defaults to the core count, so on
    four cores commands the tests expect to overlap ran one after another. The
    fixture now pins an eight-slot host.
  - **Bundled Bun (macos-arm64)** failed on every `main` push with `EMFILE`
    while ad-hoc signing the app; pull requests skip signing and passed. The
    job now raises the descriptor limit and signs pull requests too.
  - **Load flakes** recorded in the registry: 0160 (runtime-env-wiring, 5 of
    16 runs; its Claude setup block case now has the 15-second budget its
    Codex sibling already had), 0176 (InitializationLogs), 0232 (ACP close fixture) and the new
    0240 (Cursor steering at capacity, resolved on 2026-10-15 with 0216: both
    cases made hundreds of real fsyncs, which a loaded Linux runner could not
    finish inside Bun's timeouts).

  A full backend run under CI emulation (one worker, `CI` and
  `GITHUB_ACTIONS` set) also exposed: `AgentRegistry > lists every
  agent tab and coordinator with live state and counts` compared two
  snapshots whose `generatedAt` stamps could differ by a millisecond (23 of
  300 reruns failed). It now ignores only the stamp.
- **Worktree persist-failure test (fixed 2026-10-18).** `Electron backend
  environment lifecycle commands > removes a newly created worktree and its
  branch when persisting them fails`
  (`apps/backend/tests/commands-registry-environments.test.ts`) failed with
  "Received promise that resolved" on some runs, never on a commit boundary.
  The cause was the test, not the product. Since #955 (2026-10-13) the start
  path stores the canonical worktree root (`validateWorktreeLocation`, then
  `realpath`), but the storage mock failed only an update whose `worktreePath`
  equalled `path.join(context.worktreeDir, …)` spelled as given. The fixture
  root is `ORKESTRATOR_WORKTREE_DIR`, else `os.tmpdir()`. The
  `tests/setup-node.ts` preload makes the first canonical. A bare
  `bun test <file>` from `apps/backend` loaded no preload, so the root was the
  shell's `ORKESTRATOR_WORKTREE_DIR` or a temp directory under a symlink
  (macOS `/tmp`, `/var/folders/…`). The mock then never fired, the start
  succeeded, and the outcome depended on the shell. The product compensation
  was correct throughout: it removes the worktree and branch it created, by
  the path it created.
  - **Fix.** The mock fails the first update that persists any worktree path,
    and the test asserts that path equals the expected one, so a mismatch
    reads as a path diff. `expectedManagedWorktreePath`
    (`apps/backend/tests/command-fixtures.ts`) canonicalizes the root as
    production does. `apps/backend/bunfig.toml` now preloads
    `tests/setup-node.ts`, so a bare run gets the suite's isolated worktree
    root and Git config instead of writing under a shell-exported root.
  - **Evidence** (Bun 1.4.3, macOS, branch from `a5d338c1`). Before: the
    bare single-test run failed deterministically (root `/tmp/…`, worktree
    created under `/private/tmp/…`); the same run with
    `--preload ../../tests/setup-node.ts` passed. After, with only the test
    change: 3 of 3 bare runs passed. After the full change: 20 of 20
    sequential bare runs, 8 of 8 concurrent bare runs, 3 of 3 with
    `TMPDIR=$(getconf DARWIN_USER_TEMP_DIR)`, and the whole owning file 3 of
    3 (`bun test --preload ../../tests/setup-node.ts
    tests/commands-registry-environments.test.ts --parallel=1
    --only-failures`, 68 of 68, 31–41 s). A probe confirmed a bare run
    overrides an inherited `ORKESTRATOR_WORKTREE_DIR`, and that a preload
    named in both `bunfig.toml` and `--preload` is evaluated once.
    `mise run check` passed, and one full `mise run test` passed every
    group (workspace 406.4 s, root 220.3 s, bridges 115.2 s, exit 0).
  - **Not reproduced.** The 2026-10-17 report also saw it fail in the
    Grok-trust build's full `mise run test`, where the preload makes the
    root canonical. That run's command and environment were not recorded,
    and no in-tree path with the preload produces a different spelling. A
    recurrence now fails on the path assertion, which names both paths.
- **Ownership guard.** `tests/unit/test-suite-ownership.test.ts` derives owners
  from `buildConcurrentGroups` (`scripts/test-all.ts`) and the package test
  selectors. It also rejects root tests that import backend or desktop
  sources.
- **Controlled time.** `tests/helpers/controlled-timeout.ts`
  (`installControlledTimeout`, with collision detection and `assertDrained`) is
  tested by `tests/unit/controlled-timeout.test.ts`. The `GlobalSettings`,
  `GlobalSettingsDefaults` and `PersistentTerminal` suites use it.
- **Task graph.** `apps/web`, `apps/web-public`, `apps/desktop` and
  `packages/protocol` set `test:workspace.dependsOn: []` in their `turbo.json`.
  Backend and CLI inherit the root `dependsOn: ["build"]`, because
  `apps/backend/tests/standalone.test.ts` and `packages/cli/tests/cli.test.ts`
  consume `dist`. The workspace group asks Turbo for `build` and
  `test:workspace` in one invocation. `planWorkers` caps the aggregate at
  `MAX_AGGREGATE_TEST_WORKERS` (8) with `MIN_BRIDGE_WORKERS` (2). Bridge
  `test:bridge` scripts preload `tests/setup-node.ts`.
- **Timing.** These come from 18 local Bun timing profiles written on
  2026-10-15. They are cumulative per-file times, and host contention is
  unknown.

  | Owner or file | Cumulative time |
  | --- | ---: |
  | Backend package (about 440 files) | 482–745 s |
  | Web package (about 427 files) | 183–315 s |
  | Root group (about 136 files) | 148–204 s |
  | ACP bridge | 60–140 s |
  | `tests/unit/components/AddProjectDialog.test.tsx` | 55–57 s in every profile |
  | `apps/backend/src/core/review-validation-worker.test.ts` | 40–48 s |
  | `apps/backend/src/core/public-api/public-api-exec.test.ts` | 31–36 s |
  | `apps/backend/tests/tmux-session.test.ts` | 23–27 s |
  | `apps/backend/tests/commands-integration.test.ts` | 23–107 s |
  | `apps/web/src/components/terminal/PersistentTerminal.test.tsx` | about 21 s |

## Outstanding work

### Code

1. **Confirm `main` stays green, then apply the approved ruleset.** Every
   failure the completed CI runs have shown so far is fixed, registered or
   mitigated (see Current state). Once `main` passes three `CI` runs in a
   row, create the ruleset below with
   `gh api -X POST repos/orkestrator-ai/orkestrator-v2/rulesets --input <file>`,
   then check it with `gh api repos/{owner}/{repo}/rulesets`. If a run fails
   first, fix or register the failure and restart the count; the 0246 launch
   log says why the real-Chromium case failed. The maintainer approved this
   ruleset on 2026-10-15. Track production-budget timeout warnings separately;
   green functional runs alone do not resolve flake 0246:

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
             { "context": "oxfmt and oxlint", "integration_id": 15368 },
             { "context": "Typecheck", "integration_id": 15368 },
             { "context": "Unit and integration tests", "integration_id": 15368 }
           ]
         }
       }
     ]
   }
   ```

   - The three contexts are the `ci.yml` job names, reported by
     `github-actions` (app 15368), as checked on `7ccb193e`. `actor_id` 5 is
     the repository Admin role.
   - Strict up-to-date checks stay off at first: about 226 pull requests a
     month and a 12-minute test job would serialise merges. Revisit with a
     merge queue, which needs a `merge_group:` trigger in `ci.yml`.
   - Repository admins may bypass, because version bumps are pushed to `main`
     directly (44 such pushes since 2026-09-15). Moving them to pull requests
     would allow pull-request-only bypass.
   - The Bundled Bun and Container checks are not required: that workflow is
     path-filtered, so a required check would stay pending on unrelated pull
     requests.
   - Once active, the app's merge (`gh pr merge` without `--admin`,
     `apps/backend/src/core/commands-review.ts`) is refused until the three
     checks pass. That is intended; the maintainer chose not to add `--admin`
     or `--auto`.
2. **`AddProjectDialog.test.tsx`**, which is new since the review and the root
   group's long pole. It runs about 47 tests (including `test.each` rows) in
   55 s, with real 1.2 s, 2.15 s and 2.3 s sleeps and 3 s `waitFor` timeouts.
   Find the timers behind remote detection and validation, and drive them with
   `installControlledTimeout` where that is faithful.
3. **Remaining literal waits.**
   - `PersistentTerminal.test.tsx`: 14 waits, about 7.9 s.
   - `apps/web/src/components/native-agent/AgentNativeTab.test.tsx`: 33 waits,
     about 2.4 s, including fifteen 120 ms resource-event waits.
   - Convert a wait only where the production timer can be captured or an
     explicit completion signal exists; otherwise record why it stays. The
     ActionBar suite's residual waits (about 0.3 s) are not worth converting.
4. **Backend slow owners.** `review-validation-worker.test.ts` still has 23
   literal waits and has grown from about 30 s. Profile
   `public-api-exec.test.ts`, `commands-integration.test.ts` and
   `tmux-session.test.ts` with process and Git spawn counts before narrowing
   any fixture. `createGitWorktreeWithOrigin` (`apps/backend/tests/command-fixtures.ts`)
   was judged necessary for `commands-integration`; revisit only with counts.
5. **Skipped test.** `stops retrying a persistently failing GitHub credential
   propagation` is a `test.skip` in `tests/unit/components/GlobalSettings.test.tsx`
   with a real 3 s sleep, and nothing else tracks it. Fix the behaviour and
   re-enable it with its original intent, or delete it with a recorded reason.
6. **Desktop test gaps** (see Needs verification):
   - `BackendProcess.launch` (`apps/desktop/electron/backend-process.ts`): no
     test covers the 30 s readiness timeout, an invalid auth file, the child
     exiting between readiness and client setup, or `stop()` racing startup.
     Only "child exits before readiness" is tested
     (`apps/desktop/tests/backend-process.test.ts`).
   - `apps/desktop/electron/main.ts` window and connection bookkeeping:
     `windowContexts`, `contextForEvent`, `emitToConnection`, and the
     `useConnection` handler that swaps the window's preview runtime and rolls
     it back on failure. `apps/desktop/tests/main-ipc.test.ts` replaces
     `useConnection` and `forgetConnection` with mocks. The menu helpers in
     `window-menu.ts` are tested.
7. **Flakes.** Resolve the gateway-auth part of flake 0006 once the registry
   criteria are met; the file now runs in well under a second. Flakes 0166
   (OpenCode probe deadline) and 0171 (Multi Review slow-reviewer benchmark)
   were resolved on 2026-10-15 with a controlled deadline and an ordering
   check. Resolve 0246 (real-Chromium launch) as item 1 describes.
8. **Dev profiles report Electron's version as the backend's.** Found on
   2026-10-17 during the container qualification. The dev launcher starts
   Electron on `apps/desktop/dist/electron/main.js`
   (`apps/desktop/scripts/dev/lifecycle.ts:629`), so `app.getVersion()` returns
   Electron's 44.7.0 and `createBackendProcessEnvironment` exports it as
   `ORKESTRATOR_VERSION`. Every `mise run dev` and `dev:test` browser therefore
   shows "Orkestrator has been updated … the server now runs 44.7.0" over the
   bottom-right of the page. Pass the package version in dev, or point
   Electron at `apps/desktop` so it reads `package.json`.

9. **Electron specs leak their Vite server on a timeout.** The
   `e2e/agent-testing/*-electron.spec.ts` helpers spawn a detached Vite dev server
   and stop its process group in a `finally`. When the test times out while
   `ElectronApplication.close()` hangs, Playwright tears the worker down and
   the `finally` never runs, so the dev server keeps its port. Two leaked on
   2026-10-17 (see the
   [service-preview-rollout.md](service-preview-rollout.md) evidence log). Stop
   the group from a fixture teardown or a worker-exit hook as well, and bound
   the `close()` wait.

10. **The Codex bridge listens on import.** Found on 2026-10-21 during the
    cold-restart qualification
    ([flake 0660](../tests/flaky-tests/0660-codex-item-to-parts-inherited-port.md)).
    `bridges/codex-bridge/src/item-to-parts.test.ts` imports `./index.js`,
    which starts the bridge's HTTP server on `env.PORT`. An Orkestrator agent
    tab exports `PORT` (its own bridge's port), so the suite errors with
    "Failed to start server" whenever it runs from such a tab. Start the server
    only when `index.ts` is the entry point, or move `itemToParts` out of it.

### Qualification

- There is no controlled before-and-after comparison; the streamlining
  validation table was never filled. The 401.9 s (review) and 283.3 s (#815)
  aggregate figures predate #966 and #969.
- If speed work resumes, start from fresh baselines: one quiet warm run and one
  build-cache-miss run. Record queue and execution time separately (the
  aggregate `elapsedMs` includes admission waiting), peak process-tree memory,
  and a two-worktree contention check.

### Deferred until measured

- **ACP transcript matrix.** `bridges/acp-bridge/src/acp-transcript.test.ts`
  spawns a bridge in 77 places. Direct tests of the parse and merge functions
  already exist in `acp-tools.test.ts`, but the subprocess cases also assert
  ordering, acknowledgement and transport lifecycle. Re-measure before moving
  any.
- **Longest-first bridge scheduling.** Not warranted while ACP is about as long
  as the other four bridges combined.
- **Barrel and type-only runtime tests** were kept on purpose: they exercise
  import initialisation. `apps/web/src/types/index.test.ts` is also compiled by
  the web typecheck.
- **Split backend `test:workspace`** into source tests and the
  artifact-consuming tests. This may matter now that backend is the largest
  owner; check with Turbo `--summarize` output first.

## Constraints and rationale

- Do not use retries, skips, weaker assertions, disabled isolation or higher
  concurrency as speed fixes. A speedup that adds flakes, memory pressure or
  incomplete validation is not accepted.
- Test-result caching stays off while the flake registry is active. Keep the
  8-worker aggregate ceiling and memory admission.
- Never change production debounce or retry constants to make tests cheaper.
- **Timer rules.**
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

- Is backend now the critical path of the workspace group, so that splitting
  its build-dependent tests is worth it?
- Should the testing guide carry current reference timings? Its 188 s cold and
  75 s warm figures are from an older 18-core run.

## Needs verification

- Both desktop gaps (item 6) were found by searching the tests for the failure
  strings and handlers. Confirm with coverage before writing tests.
- The root cause of the `AddProjectDialog` cost.
- Current wall-clock group times, which need Turbo `--summarize` from a quiet
  run.

## Related

- [Flake registry](../tests/flaky-tests/0000-index.md); entries
  [0006](../tests/flaky-tests/0006-2026-09-08-coordinator-action-validation.md),
  [0166](../tests/flaky-tests/0166-opencode-probe-deadline-exit-code.md),
  [0171](../tests/flaky-tests/0171-multi-review-admission-benchmark-load.md),
  [0246](../tests/flaky-tests/0246-design-renderer-real-chromium-launch-deadline.md).
- [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md)
  for runs CI cannot do.
- [environment-and-disk-cleanup.md](environment-and-disk-cleanup.md) for test
  temp-directory leaks.
- Other residuals from the 2026-09-15 security review: restricted containers
  still need `NET_ADMIN`
  ([container-network-and-credential-isolation.md](container-network-and-credential-isolation.md)).
  Renderer windows keep `sandbox: false` as a documented exception for ESM
  preloads (`apps/desktop/electron/window.ts`); emitting CJS preloads would
  allow `sandbox: true`.
- Living-doc drift to fix:
  - [`testing-guide.md`](../development/testing-guide.md), "Caching and
    duration history", says `test:workspace` "still depends on" `build`. Only
    backend and CLI do now; describe the overrides and the single Turbo
    invocation instead. The guide also does not describe
    `tests/helpers/controlled-timeout.ts`, the timer rules, or how the
    ownership guard derives owners (it mentions only the import rule).
  - The flake registry has two entries numbered 0163
    (`0163-claude-credential-injection-aggregate-hang.md` and
    `0163-desktop-isolated-browser-aggregate-timeout.md`).

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
