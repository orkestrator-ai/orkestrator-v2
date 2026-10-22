# Main-merge validation timeout cluster

- **ID:** 0691
- **Status:** open
- **Date observed:** 2026-10-22
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`
- **Baseline:** `5528187a7e0dbc4d09f3a5c428724e16cc3d7a4c`; merged `origin/main` before committing.
- **Worker configuration:** default bounded aggregate; root 1 worker, bridges 2 package tasks with 1 worker each, workspace 2 package tasks with 2 workers each. Component browser, Electron and isolated Docker image build were also running.
- **Failure:** timeouts and follow-on assertions; the root group reached its 300-second no-output watchdog. Several individual elapsed times greatly exceeded their configured deadlines.
- **Suite counts:** protocol lockfile passed; workspace 11/13 tasks successful without final web/backend counts; root stopped before final counts. Claude bridge 1602 pass, 5 skip, 1 fail; ACP 654 pass, 3 skip, 1 fail. All 18 complete failing owner files passed unchanged alone.
- **Hypothesis:** resource contention is supported by observed host load averages of 156.45/53.82/22.81 during the first run and unchanged complete-owner passes. This does not establish a product cause or make the original aggregate green.
- **Original evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.HE0c2p/` (compressed group logs), outer logged run `orkestrator-test-run.FwU4xS`.

## Original failures

| Owner | Exact test and elapsed time |
| --- | --- |
| `bridges/claude-bridge/src/services/session-manager-core.test.ts` | `claude usage snapshot > discards a context report that arrives after the deadline [102836.54ms]` |
| `bridges/acp-bridge/src/acp-session.test.ts` | `ACP bridge > applies each racing resume's own controls to one adopted session [106694.50ms]` |
| `apps/web/src/components/terminal/PersistentTerminal.test.tsx` | `PersistentTerminal > surfaces a launch warning after bounded unsuccessful bootstrap attempts [101554.20ms]` |
| `apps/web/src/components/build-pipeline/BuildChatTab.test.tsx` | `BuildChatTab backend projection > releases a pinned Tests selection when the validation run is removed [101416.54ms]` |
| `apps/web/src/components/environments/EnvironmentRecoveryCopies.test.tsx` | `environment recovery copies > a restore is reported from the backend's record, not from the call returning [20792.34ms]` |
| `apps/web/src/components/native-agent/AgentNativeTab.progressive.test.tsx` | `AgentNativeTab progressive controller > keeps Claude agent-card position through failed-read until authority returns [21424.48ms]` |
| `apps/web/src/components/native-agent/AgentNativeTab.progressive.test.tsx` | `AgentNativeTab progressive controller > keeps Claude agent-card position through unavailable-state until authority returns [1740.34ms]` |
| `apps/web/src/components/environments/EnvironmentRecoveryCopies.test.tsx` | `environment recovery copies > a copy produced while the list is open appears when the record changes [5000.56ms]` |
| `apps/web/src/components/terminal/TerminalContainer.view.test.tsx` | `TerminalContainer > restores the persisted layout, not a default terminal, when a stopped container starts again [21580.21ms]` |
| `apps/web/src/components/review/MultiReviewFlowGraph.test.tsx` | `zoom and pan > keeps a node reached from the keyboard in view [6566.92ms]` |
| `apps/web/src/components/kanban/ProjectNotesView.test.tsx` | `ProjectNotesView > re-persists a draft that is edited again after a discard [22610.74ms]` |
| `apps/web/src/lib/pane-layout-persistence.test.ts` | `pane layout persistence > does not write before hydration and primes a restored snapshot without echoing it [22288.43ms]` |
| `apps/web/src/lib/pane-layout-persistence.test.ts` | `pane layout persistence > persists an active-pane-only change immediately [32.81ms]` |
| `apps/web/src/lib/pane-layout-persistence.test.ts` | `pane layout persistence > flushPaneLayoutNow orders its write behind an in-flight debounced write [74.11ms]` |
| `apps/web/src/lib/pane-layout-persistence.test.ts` | `pane layout persistence > does not install a save after hydration becomes stale during dependency loading [36.42ms]` |
| `apps/web/src/lib/pane-layout-persistence.test.ts` | `pane layout persistence > announces a settled write chain on success and on failure [23.07ms]` |
| `apps/web/src/lib/pane-layout-persistence.test.ts` | `pane layout persistence > isolates a throwing settled handler from later handlers [20.65ms]` |
| `apps/web/src/lib/pane-layout-persistence.test.ts` | `pane layout persistence > uses the production backend-intent path immediately and installs its authoritative result [21.31ms]` |
| `apps/web/src/lib/pane-layout-persistence.test.ts` | `pane layout persistence > reports a production backend-intent failure and keeps later writes usable [42.49ms]` |
| `apps/web/src/components/layout/AgentInfoMcpSection.test.tsx` | `AgentInfoMcpSection links into saved configuration > each runtime row links to its server by name, provider and environment [21741.63ms]` |
| `apps/backend/src/core/review-validation-worker.test.ts` | `a healthy quiet command runs until its declared timeout without an opted-in watchdog [23581.22ms]` |
| `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts` | `executable document policy in chromium > popups, new-window links and top navigation reach the sink zero times [491883.31ms]` |
| `apps/web/src/components/chat/NativeMessage.part-meta.test.tsx` | `tool card duration > a refused call never ran, so it has no runtime [456052.49ms]` |
| `apps/backend/src/core/review-validation-worker.test.ts` | `worktree drift during host admission still runs and records the changed files [456468.23ms]` |
| `tests/unit/pi-bridge-vendor.test.ts` | `Pi bridge runtime vendoring > loads Pi's supported SDK from the staged runtime closure [112073.68ms]` |
| `tests/unit/run-logged.test.ts` | `scripts/run-logged.ts > a live design heartbeat keeps an unchanged wait alive beyond the silence deadline [24388.46ms]` |
| `tests/unit/release/release-desktop.test.ts` | `release checkout guards > accepts a matching lightweight tag on a real remote [22844.08ms]` |
| `tests/unit/components/SortableSidebarItems.test.tsx` | `sortable sidebar items > SortableProjectGroup tooltip describes an empty project without a local path [22154.00ms]` |

## Complete unchanged owning-file reruns

Every command used `mise run test:logged -- --name <label> --` and `--parallel=1 --only-failures`.
Web/backend owners ran with `bun --cwd=<package> test ./<package-relative-file>`; root owners used `bun test ./<file>`.

| Owner | Result | Logged duration |
| --- | --- | --- |
| `apps/web/src/components/terminal/PersistentTerminal.test.tsx` | pass | 21.2 s |
| `apps/web/src/components/build-pipeline/BuildChatTab.test.tsx` | pass | 5.0 s |
| `apps/web/src/components/environments/EnvironmentRecoveryCopies.test.tsx` | pass | 3.5 s |
| `apps/web/src/components/native-agent/AgentNativeTab.progressive.test.tsx` | pass | 7.4 s |
| `apps/web/src/components/terminal/TerminalContainer.view.test.tsx` | pass | 4.2 s |
| `apps/web/src/components/review/MultiReviewFlowGraph.test.tsx` | pass | 1.3 s |
| `apps/web/src/components/kanban/ProjectNotesView.test.tsx` | pass | 1.1 s |
| `apps/web/src/lib/pane-layout-persistence.test.ts` | pass | 1.7 s |
| `apps/web/src/components/layout/AgentInfoMcpSection.test.tsx` | pass | 0.4 s |
| `apps/web/src/components/chat/NativeMessage.part-meta.test.tsx` | pass | 0.5 s |
| `apps/backend/src/core/review-validation-worker.test.ts` | pass | 44.1 s |
| `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts` | pass | 88.0 s |
| `tests/unit/pi-bridge-vendor.test.ts` | pass | 19.3 s |
| `tests/unit/run-logged.test.ts` | pass | 5.4 s |
| `tests/unit/release/release-desktop.test.ts` | pass | 4.0 s |
| `tests/unit/components/SortableSidebarItems.test.tsx` | pass | 3.2 s |
| `bridges/claude-bridge/src/services/session-manager-core.test.ts` | pass | 10.4 s |
| `bridges/acp-bridge/src/acp-session.test.ts` | pass | 5.6 s |

The bridge commands were `bun --cwd=bridges/claude-bridge test ./src/services/session-manager-core.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` and `bun --cwd=bridges/acp-bridge test ./src/acp-session.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`, through the logged runner.
An earlier ACP attempt from the repository root loaded the DOM preload and failed with an incompatible AbortSignal; it is not the isolated evidence above. Two attempts with a space-separated Bun `--cwd` were rejected before running tests. No test or implementation was changed.

The Pi staging recurrence is also recorded in [0178](../agent-bridges/0178-pi-vendor-runtime-aggregate-timeout.md). Browser/Electron results are tracked separately in their existing cases.

## Electron and native UI limitations

The original one-worker `mise run test:logged -- --name merge-electron -- mise run test:agent:electron` returned 18 passed, 4 failed, 1 skipped and 7 not run (846.4 s). `Run interactive opens a sandboxed host view that relays readiness, size and input, and Stop tears it down` in `e2e/agent-testing/artifact-host-electron.spec.ts:188` exceeded 120 seconds; its complete unchanged owner passed alone through `test:logged` with `bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts --workers=1 artifact-host-electron.spec.ts` (8.5 s). Nickname and service-picker recurrences are recorded in 0515 and 0620.

The unchanged complete `web-annotations-electron.spec.ts` still failed alone (6 pass, 1 fail, 3 not run; 30.0 s): `the real Notes column shrinks the native view, overlays hide it, and the narrow switch swaps surfaces` expected the Annotations button to be focused, but it was inactive. Evidence: `orkestrator-test-run.ty9sn1/merge-electron-owner-web-annotations-electron.log.gz`. This is unresolved, not independently a confirmed flake.

The unchanged complete `e2e/AgentLaunchDialog.spec.ts` also failed alone (2 pass, 2 fail; 22.0 s): `selects a native branch suggestion with the keyboard and confirms` retained `rel` instead of `release/2.0` in both viewports. Evidence: `orkestrator-test-run.u9nXKH/merge-owner-AgentLaunchDialog.log.gz`. No assertion or implementation was changed to suppress either native UI failure.

## Other merge checks

Formatting, lint, all-package typechecking, the production build, CLI scenarios, the public-site browser suite, isolated Docker image build and Docker fixture suite passed. Docker startup first timed out; a clean stop/reset and retry reached ready, then the full Docker fixture suite passed (79.6 s). Profile `merge-interactions-qa` was stopped and reset afterward, removing only its owned containers, volumes, network and disposable state. No iOS suite or opt-in billed provider qualification ran because the merge has no iOS changes and this task does not qualify live providers.

The complete isolated browser task `mise run test:logged -- --name merge-real-browser -- mise run test:agent:browser:isolated` returned 28 passed, 51 skipped and 1 failed in 453.9 s. `host picker creates and browses folders through the authenticated gateway above fullscreen settings (narrow)` in `e2e/agent-testing/browser-gateway.spec.ts:150` timed out clicking `Repository settings` (15 s); the button became invisible. Profile `qa-browser-94c24402-4c4` was automatically stopped/reset. Evidence: `orkestrator-test-run.4QEM7V/merge-real-browser.log.gz`. This observation alone does not classify the failure as flaky.

The complete unchanged gateway owner was then rerun in a fresh credential-free Codex fixture: `ORKESTRATOR_AGENT_TEST_PROFILE=merge-browser-owner-qa ORKESTRATOR_AGENT_TEST_RUN_ID=merge-browser-owner-qa mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts --workers=1 browser-gateway.spec.ts`. It repeated the same narrow Repository settings click timeout (13 passed, 10 skipped, 1 failed; 130.3 s). This remains an unresolved validation limitation. Evidence: `orkestrator-test-run.ljxB3h/merge-gateway-owner.log.gz`. The profile was stopped/reset after the run.

## Final non-iOS aggregate retry

`mise run test:logged -- --name merge-tests-retry -- mise run test` finished in 500.9 s. The complete workspace group passed (500.7 s), the complete root/support group passed (230.6 s), and the Codex protocol lockfile check passed. The bridge group remained non-green solely because of the existing Claude plan-exit persistence race ([0513](../agent-bridges/0513-claude-bridge-plan-exit-persistence.md)); its complete unchanged owning file passed separately in 0.2 s. The other four bridge packages passed. Aggregate evidence: `orkestrator-test-run.f3gD5p/`, outer logged evidence `orkestrator-test-run.v3Sllg/`, beneath the host temporary directory. These results do not claim a green full aggregate, component browser or Electron suite.

All 142 code/configuration/test paths imported relative to the pre-merge HEAD were compared with fetched `origin/main` (`e5dc4809caae97490ffb1259b330ef4233773b84`) and matched exactly. The manual conflict resolution retained both branches' flake entries, the branch's newer 0175 observation, and main's newer 0174 observation. No conflict markers or missing local links remained in changed documentation.
