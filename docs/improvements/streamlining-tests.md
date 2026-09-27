# Streamlining the test suite

Status: Review findings and proposed work; no implementation changes.

Reviewed 2026-09-21 at commit
`88c2f9ccfaa68045573b658dd4f172bc5ff7c51b`.

## Recommendation

Yes, the suite can be streamlined without materially reducing assurance.
Start by removing repeated real-time waits and unnecessary setup, then move
exhaustive behavioral matrices to their owning unit suites. Delete a smaller
number of demonstrated duplicates. Cutting a percentage of the test count
would target the wrong thing: the protocol package ran 886 tests in about one
second, whereas two settings component files took about 42 seconds between
them.

The strongest candidates are:

| Priority | Change | Expected benefit | Assurance requirement |
| --- | --- | --- | --- |
| 1 | Replace settings and terminal timer waits with controlled time | Remove tens of seconds of cumulative waiting | Keep all timing boundaries, retries, cancellation and stale-result assertions |
| 1 | Reduce subprocess use for ACP transcript shape tests | Reduce the slowest bridge package's work | Keep real transport, replay, restart and lifecycle integration cases |
| 1 | Separate source tests from unnecessary production-build prerequisites | Earlier feedback, especially on build-cache misses | Retain explicit build and packaged-artifact gates |
| 2 | Schedule the slowest bridge package first | Shorter bridge completion time with the same two slots | Execute every package and preserve admission/cleanup rules |
| 2 | Use the existing non-DOM preload for server-only suites | Less import/setup cost and memory per isolated file | Preserve environment isolation and bounded diagnostics |
| 2 | Consolidate proven duplicate merge tests and redundant smoke assertions | Small runtime saving; clearer ownership | Preserve unique cases and consumer wiring checks |
| 3 | Narrow large UI and command fixtures | Less rendering and repeated process/Git setup | Keep integration tests for actual cross-layer failure modes |

These benefits overlap. Cumulative file time is not aggregate wall time, and
none of the proposed savings has been established by a before/after change.

## Scope and measurement

The review inspected the [testing guide](../development/testing-guide.md),
[runner](../../scripts/test-all.ts), [Turbo configuration](../../turbo.json),
package scripts, preloads, CI, the flake index, and representative expensive
and overlapping suites. This is a targeted review, not a case-by-case proof
that every remaining test is necessary.

There are **898 tracked JavaScript/TypeScript test/spec files**. The measured
default run collected 869 of them and reported 19,609 cases, including skips:

| Default group/package | Files |
| --- | ---: |
| Root plus agent-support fixtures | 203 |
| Web | 309 |
| Backend | 150 |
| Desktop | 8 |
| Public web | 3 |
| CLI | 1 |
| Protocol | 51 |
| Five bridges | 144 |

The remaining files comprise 25 browser/agent specs, two deliberately failing
diagnostic fixtures, one script-local test and one desktop test outside the
package's explicit test list. Reducing browser coverage would
not speed up `mise run test`: browser, Electron-agent and Docker-agent suites
are separate. iOS is also outside the default command.

A default-suite run was measured on this Linux host with 12 logical CPUs and
Bun 1.4.2. Another worktree was testing concurrently. Build cache state was
mixed: backend, CLI and protocol build hits, with renderer/public-web build
misses. Treat the measurements as a contended diagnostic sample, not a clean
performance baseline or a replacement for the guide's older reference timings.

`mise run test` completed in **401.9 seconds (6m 42s)** with exit status 1:

| Group | Time from submission to completion | Result and execution detail |
| --- | ---: | --- |
| Workspace | 401.9 s | Passed; web build 160.6 s, then web tests 240.7 s |
| Root and agent support | 119.0 s | 4,342 passed, 4 skipped, 1 failed; three workers |
| Bridges | 245.7 s | Passed; 119.0 s waiting, then about 126.7 s executing |
| Codex protocol lockfile | 360.2 s | Passed; about 359.7 s waiting and 0.5 s executing |

The protocol check regenerated against the pinned Codex binary; it did not use
the missing-binary fallback. The renderer build, rather than bridge or protocol
queueing, lay on this run's final critical path. Public web also spent 98.3 s
building before running under one second of source tests.

Evidence: `/tmp/orkestrator-test-run.vjXOtb/summary.json`, its compressed group
logs, this worktree's `.turbo/runs/` summaries, and the Bun profiles under
`/tmp/orkestrator-test-timings.e3d5c84482cb172489ae.adb9dcb894101ea1d6c5/`.
Temporary artifacts expire; the relevant numbers are preserved here. No
controlled cold/warm comparison, coverage/mutation analysis or peak-memory
measurement was performed.

The failure was
`remote gateway > closes an established event stream when its agent-test session expires`
in [gateway-auth.test.ts](../../tests/unit/electron/gateway-auth.test.ts):
`Event stream never connected`, after 2,016 ms. The test sets expiry only
40 ms ahead **before** opening the event stream, creating a plausible
load-sensitive connection/expiry race. This is a hypothesis from inspection,
not a confirmed product defect. Establish the connection before driving expiry
in a future fixture fix, while retaining the separate rejection-of-expired-auth
coverage. Do not delete the expiry test to make this run green.

The owning file then passed alone in 1.3 seconds with
`mise run test:logged -- --name streamlining-gateway-auth -- bun test ./tests/unit/electron/gateway-auth.test.ts --parallel=1 --only-failures`.
This supports treating the aggregate failure as a credible flake; it does not
establish the exact cause or turn the failed aggregate into a passing run.

Representative file durations from this run's Bun timing profiles:

| File | Duration | Interpretation |
| --- | ---: | --- |
| `tests/unit/components/GlobalSettings.test.tsx` | 32.23 s | Repeated autosave waits |
| `tests/unit/components/GlobalSettingsDefaults.test.tsx` | 10.13 s | Same autosave helper pattern |
| `tests/unit/electron/tmux-session.test.ts` | 23.48 s | Mix of helpers, real parser and lifecycle checks |
| `tests/unit/electron/commands-integration.test.ts` | 22.54 s | Command delegation plus real fixtures |
| `tests/unit/components/CreateEnvironmentDialog.test.tsx` | 21.52 s | Large UI suite, plus some pure helper cases |
| `apps/web/src/components/terminal/PersistentTerminal.test.tsx` | 22.09 s | Bootstrap, retry and terminal lifecycle cases |
| `apps/web/src/components/layout/ActionBar.test.tsx` | 17.43 s | Large action/control matrix |
| `apps/web/src/components/native-agent/AgentNativeTab.test.tsx` | 15.33 s | Resource events, recovery and polling |
| `apps/backend/src/core/review-validation-worker.test.ts` | 30.36 s | Real worker/control processes and queue behavior |
| `bridges/acp-bridge/src/acp-transcript.test.ts` | 34.35 s | Many bridge launches for transcript cases |
| `bridges/acp-bridge/src/acp-context.test.ts` | 22.10 s | Process-backed context/reconciliation cases |
| Entire protocol package, 51 files | 1.04 s | Cheap coverage worth retaining |

## 1. Eliminate repeated wall-clock waits before deleting behavior tests

[GlobalSettings.test.tsx](../../tests/unit/components/GlobalSettings.test.tsx)
defines `flushAutoSave()` as an `act()` around a **450 ms real sleep**. There
are 70 call sites; 14 are inside an already skipped test and therefore must
not be counted as current runtime. The remaining 56 sites represent about
25 seconds of explicit waits before accounting for loop expansion.
[GlobalSettingsDefaults.test.tsx](../../tests/unit/components/GlobalSettingsDefaults.test.tsx)
adds another 16 calls to the same 450 ms pattern, or 7.2 seconds.

Use controlled timers for these component tests. Exercise the actual debounce
callback, flush the resulting asynchronous updates, and retain assertions that
nothing saves before the boundary, rapid edits coalesce, the latest edit is
saved, failed writes remain retryable, and unmount cancels pending UI work.
Merely changing the helper to call a save method directly would bypass the
behavior being tested. Restore timers and state after each case.

Other concrete candidates:

- [PersistentTerminal.test.tsx](../../apps/web/src/components/terminal/PersistentTerminal.test.tsx)
  has 15 literal `setTimeout(resolve, ...)` waits totaling 8.26 seconds in
  source. For example, the bootstrap-cancellation test waits 400 ms after
  unmount just to establish that a retry did not run. Advance through that
  deadline and assert the unchanged call count instead. This file already
  has a narrowly scoped disconnected-notice timer controller.
- [AgentNativeTab.test.tsx](../../apps/web/src/components/native-agent/AgentNativeTab.test.tsx)
  repeatedly waits 120 ms after resource events, and waits 1,700 ms to prove a
  creation failure survives the polling loop. Drive the debounce/poll cycle
  explicitly while retaining the inactive-tab, recovery and stale-session cases.
- [ActionBar.test.tsx](../../apps/web/src/components/layout/ActionBar.test.tsx)
  already uses controlled timers in some cases but still has a 1,025 ms real
  wait elsewhere. Apply the existing discipline consistently.

Do not mechanically shorten all sleeps. A negative assertion needs evidence
that the relevant deadline or operation has passed. Parent-process fake time
also cannot advance a separate child process: cross-process tests need an
explicit completion signal or a controllable fixture boundary.

## 2. Move ACP shape matrices below the subprocess boundary

The ACP package took about **105.6 seconds** in the observed run, considerably
more than any other bridge. Its
[transcript suite](../../bridges/acp-bridge/src/acp-transcript.test.ts) contains
76 `await spawnBridge(...)` call sites. These are source counts, not an
instrumented count of processes created during the run.

Some cases genuinely require a bridge restart or live replay. Others launch a
bridge, create a session over HTTP, submit a fake prompt, poll until idle, then
assert the shape of a todo list. Examples are `renders an ACP plan update as a
single todo_list part` and its `v2 plan_update` counterpart.

Keep the full input/output matrix, but run normalization and update-order
cases directly through existing production functions such as
`applySessionUpdate`, `applyAcpPlanUpdate`, `parseAcpPlanEntries` and
`mergeCursorTodos` in [acp-session.ts](../../bridges/acp-bridge/src/acp-session.ts)
and [acp-tools.ts](../../bridges/acp-bridge/src/acp-tools.ts). They are already
exported; this does not inherently require a production refactor.

Keep representative wire-level cases for each distinct notification/request
path, and all cases whose assertion depends on restart, persisted replay,
missed events, request acknowledgement, generation changes, cancellation or
non-blocking output. A direct function call cannot prove those properties.
Preserve subprocess isolation for cases with incompatible startup environment
variables; replacing per-case children with one mutable shared server would
trade speed for order dependence.

The backend's
[review-validation-worker.test.ts](../../apps/backend/src/core/review-validation-worker.test.ts)
is another expensive process owner. Its polling helpers launch a fresh control
process for every status read. Investigate reading the authoritative persisted
status for intermediate waits, while keeping direct control-command tests and
an end-to-end reconnect/status case. Keep real processes for cancellation,
orphan cleanup, admission, immutable evidence and HEAD-change checks. This is
a candidate for a narrower harness, not a reason to delete lifecycle coverage.

## 3. Stop making every source suite wait for a production build

[turbo.json](../../turbo.json) declares `test:workspace.dependsOn = ["build"]`
for every workspace. Consequently the renderer runs TypeScript, Vite and
precompression before its source tests; public web also runs TypeScript and
Vite. Vite alone reported **1 minute 3 seconds** for the renderer in this run.
The [CI workflow](../../.github/workflows/lint.yml) separately runs a typecheck
job, so compilation also overlaps the assurance provided by that job.

Separate source-only tests from tests that consume built artifacts. Let source
suites start without their package production build, while retaining an explicit
build gate in authoritative validation. Keep build dependencies for
[backend standalone tests](../../apps/backend/tests/standalone.test.ts) and
[CLI tests](../../packages/cli/tests/cli.test.ts): they read/launch `dist`
artifacts and test packaged behavior. Do not remove the dependency globally.

This primarily improves cold-build feedback and exposes more scheduling
opportunities. If the full validation still performs the same builds, their
cost has not disappeared. Ensure their execution stays within the same host
budget. A dedicated typecheck/build arrangement must still verify all the
configurations currently checked, not assume one `tsc` invocation covers them.

The root default already uses explicit discovery paths and does not blindly
run every package twice. The package `test` aliases are not all invoked by the
aggregate runner. Rationalize the actual task graph rather than deleting
apparently similar script names.

## 4. Start the longest bridge package first

The bridge task summary shows Cursor and Pi starting first. ACP started about
21 seconds later, after Cursor completed, and finished last. With two package
slots, the bridge group spent about 126.7 seconds executing. ACP alone required
about 105.6 seconds; the other four packages totaled about 101 seconds.

A longest-first package schedule could therefore have shortened this group's
execution by roughly **21 seconds in this sample**, without dropping a test or
increasing worker count. That is a scheduling estimate, not a measured speedup,
and it would not necessarily shorten the overall run if the workspace group
remains slower.

Bun file-duration profiles already exist; they do not solve the ordering of
Turbo's package tasks. Use package-duration evidence to guide the aggregate
scheduling change, retaining two bridge slots, streamed logs, cancellation and
the shared host admission queue. Do not launch an extra unreserved ACP job.

## 5. Stop loading a browser environment into server-only suites

All five bridge scripts explicitly preload
[register-dom.ts](../../tests/register-dom.ts) and
[setup.ts](../../tests/setup.ts). That imports Happy DOM, Testing Library,
renderer-native mocks and Sonner across 144 isolated test files. Many root
tests also check backend, protocol or repository contracts without needing DOM.

The repository already has [setup-node.ts](../../tests/setup-node.ts), which
preserves Git-config isolation, `CODEX_BRIDGE_NO_SERVER` and bounded console
diagnostics. Audit and move server-only suites to it. Partition the mixed root
suite into explicit DOM and non-DOM discovery lists with a coverage check so
files cannot fall between them or execute twice.

Do not just delete the preload flags: package invocations do not inherit the
root Bun configuration. Audit tests using the saved native fetch/abort/Response
constructors; the [ACP harness](../../bridges/acp-bridge/src/acp-test-harness.ts)
already has a non-DOM fallback, but that is not proof every bridge test does.
Measure import/setup and peak memory before claiming a particular saving.
Preserve file isolation and stable mock registration.

## 6. Delete demonstrated duplication, not similarly named files

### A concrete consolidation

[The renderer pane-layout merge suite](../../apps/web/src/lib/pane-layout-merge.test.ts)
has 35 named cases also present in
[the protocol suite](../../packages/protocol/src/pane-layout-merge.test.ts),
which has 44 named cases. The renderer implementation
[re-exports the merge and delegates the validator](../../apps/web/src/lib/pane-layout-merge.ts)
to that same protocol implementation.

Keep the exhaustive merge/validation cases in protocol. Replace the renderer's
repeated matrix with a small consumer contract: the exported merge is usable
with renderer tab metadata, and the validator delegates correctly. Check the
actual fixtures/assertions for unique metadata before dropping each case;
matching titles alone are not proof of equivalence. This could reduce roughly
35 renderer cases to two while retaining the exhaustive shared behavior suite.
It is principally an ownership improvement: the entire protocol merge file
took only 19 ms, so this is not the major performance win.

### Small, low-risk removals

- [StatusIndicator.test.tsx](../../tests/unit/components/StatusIndicator.test.tsx)
  has four `renders without crashing` cases asserting only that the render
  container is truthy. The same file renders all four statuses again and checks
  their actual labels, plus the creating spinner. Remove those four redundant
  smoke cases; retain the behavioral assertions. The whole file took 225 ms,
  so the runtime gain is small.
- Barrel tests such as [projects-index.test.ts](../../tests/unit/components/projects-index.test.ts),
  [hooks/index.test.ts](../../apps/web/src/hooks/index.test.ts),
  [stores/index.test.ts](../../apps/web/src/stores/index.test.ts) and
  [components/github/index.test.ts](../../apps/web/src/components/github/index.test.ts)
  import large graphs just to assert that exports are functions. Prefer an
  existing behavioral consumer importing through the public barrel, or a
  compiler-checked export contract where runtime initialization is irrelevant.
  Do not assume typechecking proves import-time behavior. The projects barrel
  file alone took 400 ms in this sample.
- [types/index.test.ts](../../apps/web/src/types/index.test.ts) contains only
  type assertions and belongs in compiler validation. Keep it included by a
  checked TypeScript configuration if moving it outside runtime discovery.
  [web-client-types.test.ts](../../tests/unit/types/web-client-types.test.ts)
  also asserts against objects/functions defined in the test itself; its useful
  contract is their assignability to production types. Root test files are not
  automatically covered by the package typecheck tasks, so relocation needs an
  explicit compiler owner.

### Similarity that should not trigger deletion

- Root and web `gitUrl.test.ts` test URL validation/normalization versus GitHub
  page-link conversion. Root and web `utils.test.ts` test class merging versus
  session-key parsing. These are complementary.
- Root and web `CreateEnvironmentDialog.test.tsx` and `NativeMessage.test.tsx`
  contain different regressions. Co-locating them may clarify ownership, but
  is not evidence that either suite can be removed.
- ACP and Cursor attachment tests share 11 titles but exercise independent
  implementations of a filesystem trust boundary. Keep per-implementation
  traversal, symlink, size and changed-file checks.
- The root/backend path-safety suites overlap on payload limits but also
  protect different readers and writers. Preserve their unique race and
  confinement cases; do not remove either wholesale.

## 7. Narrow expensive integration fixtures selectively

[command-fixtures.ts](../../tests/unit/electron/command-fixtures.ts)
initializes a bare repository and working repository, configures identity,
commits and pushes in `createGitWorktreeWithOrigin()`. The helper is used even
by some broad delegation tests whose storage is otherwise mocked. Use an empty
temporary directory where Git state is irrelevant; keep real Git for worktree,
branch, diff, rollback and upstream semantics. Consider a per-file immutable
seed copied into independent fixtures only after measuring setup cost. Sharing
one mutable repository between tests would weaken isolation.

For large UI suites, distinguish rules from wiring. Keep exhaustive settings
precedence in [protocol agent-settings tests](../../packages/protocol/src/agent-settings.test.ts)
and renderer-specific assembly tests. At dialog level, keep representative
default selection, user override, submission and live-config-change flows.
The root create-dialog suite already tests some pure helpers directly, so
count actual renders before proposing a saving there.

Likewise, exercise leaf controls directly for their full state matrices and
retain parent tests that prove the controls receive the right state and dispatch
the right action. Parameterizing the same expensive setup once per row only
reduces source code, not execution. Splitting a giant file alone also does not
save work when that package has one Bun worker, and can repeat costly imports.

## Coverage that should remain

Retain authoritative backend state, inactive-environment catch-up, missed-event
recovery, SSE replay ordering/cursors, at-most-once dispatch, fail-closed
approvals, generation loss, bounded queues/buffers and subprocess cleanup.
These are the repository's explicit reliability invariants and justify tests
at more than one boundary.

Keep real SDK/transport regressions such as
[OpenCode disposal](../../apps/backend/src/core/opencode-provider-dispose.test.ts),
parser compatibility checks and packaged-backend/CLI smoke tests. A mock of
the failing SDK boundary is not an equivalent replacement. Preserve the Codex
protocol regeneration gate, including clarity about its missing-binary fallback.

Do not use retries, skipped flakes, weaker assertions, disabled file isolation
or indiscriminately higher concurrency as performance fixes. Test-result
caching is deliberately disabled while the
[flake registry](../tests/flaky-tests/0000-index.md) remains active. Build
caching and timing-based scheduling already exist; neither is a new proposal.
Most browser cases already select the relevant mobile/desktop project, and
viewport-dependent behavior warrants both where it is actually different.

Also make test discovery auditable before narrowing it. The default scripts
currently omit
[agent-platform-selection.test.ts](../../apps/desktop/electron/agent-platform-selection.test.ts)
and [opencode-live-compatibility-probe.test.ts](../../scripts/opencode-live-compatibility-probe.test.ts).
Neither appears in the measured timing profiles or the aggregate's selected
paths. Assign them an explicit validation owner; accidentally uncollected tests
are an assurance gap, not a successful performance optimization.

## Suggested implementation and acceptance

1. Establish a quiet warm baseline and a separate run with relevant build-cache
   misses. Record commit, host, active workloads, cache hits, group queue and
   execution time, package/file durations, peak process-tree memory and failures.
   The current aggregate `elapsedMs` starts before admission, so it includes
   waiting; do not call that test execution time.
2. Convert settings waits first, then terminal/native-session timer cases.
   Retain the same behavioral cases and compare their focused durations.
3. Consolidate the merge and smoke duplicates with an explicit old-case to
   retained-case mapping. Handle the non-DOM preload and build-graph changes
   separately so their benefits and failures can be attributed.
4. Move selected ACP shape cases to direct production-function tests. Keep an
   explicit list of retained transport/lifecycle cases. Measure process counts
   as well as seconds. Then revisit package scheduling using the new durations.
5. Run the owning suites in their normal isolated mode, required static checks,
   and the full aggregate. Runner/preload changes need both warm and cold-enough
   observations. Repeat under normal multi-worktree contention before adopting
   them. Do not accept a speedup that increases flakes, memory pressure or
   incomplete validation.

Use the existing focused-test and `test:changed` workflows during development,
then the required full gate at handoff. `test:changed` is already available and
is not safe as the sole proof for shared configuration, dynamic dependencies or
a stale `main` baseline. Avoid running overlapping complete commands twice;
the scheduler's existing `covers` declarations already support deduplication.

The aim should be substantially less elapsed time and fewer expensive fixture
executions with the important behavioral contracts intact, rather than a target
number of deleted tests.
