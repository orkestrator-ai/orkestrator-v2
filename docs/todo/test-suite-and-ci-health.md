# Test suite and CI health

Checked against `main` at `2459b05c` (2026-10-15).

`mise run test` should be fast and green, and stay that way, without weakening
what it proves. Every test file has exactly one owner, waits are controlled
rather than slept, and setup matches what each assertion needs. Most of the
2026-09-21 streamlining review landed in #815, and #966 moved the backend and
desktop suites into their packages. What remains is a set of slow owners, one
untracked skipped test, and two desktop test gaps. More urgently, CI is red on
`main` and nothing requires it to be green.

## Current state

- **CI.** `.github/workflows/lint.yml` runs on pushes to `main` and on pull
  requests, with three jobs: "oxfmt and oxlint", "Typecheck", and "Unit and
  integration tests". `validate-bun-runtime.yml` builds the bundled Bun per
  platform and runs the container smoke.
- **`main` is unprotected.** `gh api repos/{owner}/{repo}/branches/main/protection`
  answers 404 "Branch not protected", and the repository has no rulesets.
- **`main` is red.** The five most recent `main` runs all failed or were
  cancelled. Among the last 300 `lint.yml` runs on `main`, the newest success is
  from 2026-09-30. At `2459b05c` (run 38727237741), lint and typecheck pass and
  the test job fails three tests:
  - `in-container Claude credential write > an empty payload leaves an existing
    in-container credential intact` (`apps/backend/tests/claude-credential-injection.test.ts`);
  - `GitHub CLI setup > reports a missing gh` (`apps/backend/src/core/github-cli-setup.test.ts`),
    which finds the runner's installed `gh` and reports it as installed;
  - `independent commands overlap, output stays in artifacts, and reconnect
    does not redispatch` (`apps/backend/src/core/review-validation-worker.test.ts`).

  The first two also failed in run 38719540712, and both pass locally on
  macOS, so they depend on the host. That run also failed
  `tests/unit/runtime-env-wiring.test.ts` (Claude setup block) and
  `bridges/cursor-bridge/src/conformance-interactions.test.ts` (steering at
  capacity across a restart). The macOS arm64 job of `validate-bun-runtime.yml`
  failed with `EMFILE` while building the unpacked Electron app.
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

1. **Get the test job green on `main`, then protect it.** Fix or register the
   failures above. The two host-dependent ones need their fixtures to stop
   reading the runner's environment. Then require "oxfmt and oxlint",
   "Typecheck" and "Unit and integration tests" as branch-protection checks on
   `main`. Decide whether the bundled-Bun matrix should be required too.
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
   criteria are met; the file now runs in well under a second. Flake 0166 (the
   OpenCode probe deadline, in a suite #815 assigned an owner) recurred on
   2026-10-15. The Multi Review benchmark flake 0171 is owned by
   [multi-review-scale-and-cost.md](multi-review-scale-and-cost.md).

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
  [0171](../tests/flaky-tests/0171-multi-review-admission-benchmark-load.md).
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
