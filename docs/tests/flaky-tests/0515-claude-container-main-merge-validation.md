# Claude container login main-merge validation

- **ID:** 0515
- **Status:** open
- **Date observed:** 2026-10-21
- **Merge:** `origin/main` at `d4171748` into `d8a964dc` on
  `fix-claude-container-refresh-token-3b0191a06501`.
- **Scope:** credential isolation and profile seeding, backend registry and
  catalogue tests, Electron backend environment, and documentation. No test
  assertion, timeout, skip, or implementation was changed during validation.

## Focused backend recurrence

`mise run test:logged -- --name merge-backend-focused -- bun test --cwd apps/backend
--preload ../../tests/setup-node.ts ./src/core/host-model-catalog-refresh.test.ts
./tests/commands-integration.test.ts ./tests/commands-registry-servers.test.ts
--parallel=1 --only-failures` exited 1 after 167.3 seconds: 84 passed, five
failed, 667 assertions across 89 tests in three files.

All failures were in `commands-integration.test.ts`:

- `backend-owned diff statistics > computes counts for a tracked local environment and announces them`: 5283.63 ms.
- `backend-owned diff statistics > refreshes a tracked environment on explicit request`: 5157.54 ms.
- `backend-owned diff statistics > clears published counts when a repository config retarget cannot be scanned`: 5235.52 ms.
- `backend-owned diff statistics > enables git's scan caches on a newly created worktree`: 6015.39 ms.
- `deletes an environment only after all three local server kinds exit`: 5145.11 ms.

Each exceeded its 5000 ms deadline. The complete unchanged owner passed alone:
`mise run test:logged -- --name merge-backend-integration-owner -- bun test
--cwd apps/backend --preload ../../tests/setup-node.ts
./tests/commands-integration.test.ts --parallel=1 --only-failures`, exit 0,
89.6 seconds. This confirms intermittence for this observation; host contention
is a hypothesis. Earlier resolved cases [0162](0162-electron-diff-statistics-aggregate-timeout.md)
and [0220](0220-local-server-deletion-aggregate-timeout.md) describe older causes;
this observation does not establish that those causes returned.

Evidence: `orkestrator-test-run.QuaQON/merge-backend-focused.log.gz` below the
host temporary directory.

## Focused desktop recurrence

`mise run test:logged -- --name merge-desktop-focused -- bun test --cwd apps/desktop
--preload ../../tests/setup-node.ts ./scripts/dev/profile-io.test.ts
./tests/backend-process.test.ts --parallel=1 --only-failures` exited 1 after
168.6 seconds: 114 passed and one failed, 523 assertions across 115 tests in
two files. `adopts and removes an owned Serve route after an ungraceful backend
restart` exceeded its 30-second deadline at 30321.73 ms. The credential-snapshot
profile tests passed.

The complete unchanged `backend-process.test.ts` owner passed alone:
`mise run test:logged -- --name merge-desktop-supervisor-owner -- bun test
--cwd apps/desktop --preload ../../tests/setup-node.ts
./tests/backend-process.test.ts --parallel=1 --only-failures`, exit 0,
119.2 seconds. This confirms intermittence for this observation; contention
remains a hypothesis.

Evidence: `orkestrator-test-run.wvFFUh/merge-desktop-focused.log.gz` below the
host temporary directory.

## Electron validation limitations

`mise run test:logged -- --name merge-electron -- mise run test:agent:electron`
exited 1 after 843.8 seconds, one worker: nine passed, four failed, one skipped,
and nine did not run.

- `electron-main.spec.ts`: independent windows exceeded 120 seconds; remote
  nicknames failed the native TIFF clipboard seed (`seeded.status` was 1).
- `terminal-input-resume-electron.spec.ts`: `Expand project origin` or the
  environment entry never became visible within 30 seconds.
- `web-annotations-electron.spec.ts`: the Home preview's Browser address
  textbox did not appear within five seconds; later tests did not run.

The whole unchanged `electron-main.spec.ts` rerun used
`ORKESTRATOR_AGENT_TEST_RUN_ID=merge-claude-main-owner mise run test:logged --
--name merge-electron-main-owner -- bunx playwright test
--config e2e/agent-testing/playwright.electron.config.ts
e2e/agent-testing/electron-main.spec.ts --workers=1`: exit 1 after 228.9 seconds,
two passed, one failed and one skipped. Independent windows passed; remote
nicknames failed later at line 452, waiting five seconds for `Workstation`.
The whole file did not pass, so this is not a confirmed flake.

The unchanged terminal owner rerun used
`ORKESTRATOR_AGENT_TEST_RUN_ID=merge-claude-terminal-owner mise run test:logged --
--name merge-electron-terminal-owner -- bunx playwright test
--config e2e/agent-testing/playwright.electron.config.ts
e2e/agent-testing/terminal-input-resume-electron.spec.ts --workers=1`: exit 1,
135.4 seconds, the same visibility failure. Its screenshot shows the GitHub CLI
startup dialog covering the workspace; the terminal assertion was never reached.

Evidence below the host temporary directory:
`orkestrator-test-run.u5Xjlw/merge-electron.log.gz`,
`orkestrator-test-run.gngoU9/merge-electron-main-owner.log.gz`, and
`orkestrator-test-run.pfBEHs/merge-electron-terminal-owner.log.gz`.
Playwright traces and screenshots are under `output/agent-testing/electron-smoke/`,
`output/agent-testing/merge-claude-main-owner/`, and
`output/agent-testing/merge-claude-terminal-owner/`.

The complete unchanged annotation owner passed alone:
`ORKESTRATOR_AGENT_TEST_RUN_ID=merge-claude-annotations-owner mise run test:logged --
--name merge-electron-annotations-owner -- bunx playwright test
--config e2e/agent-testing/playwright.electron.config.ts
e2e/agent-testing/web-annotations-electron.spec.ts --workers=1`, exit 0,
382.4 seconds. This establishes intermittence for its original Browser address
visibility failure. It does not resolve the independent nickname and terminal
owner failures above.

## Aggregate infrastructure deadline

`mise run test:logged -- --name merge-tests -- mise run test` exited 1 after
1800.0 seconds when the outer logged command reached its absolute deadline.
All groups initially queued for the 18-slot shared host: workspace was admitted
after 1429.0 seconds, root/support after 1611.4 seconds, protocol regeneration
after 1744.9 seconds, and bridges after 1751.7 seconds. Protocol regeneration
passed; the other groups were terminated with SIGTERM before finishing. This
is incomplete infrastructure evidence, not a completed failing test suite.

Evidence: `orkestrator-test-run.TdULk9/merge-tests.log.gz` below the host
temporary directory. A one-off retry uses
`ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=3600000 mise run test:logged --
--name merge-full-retry -- mise run test` to allow queue time. No test assertion,
no-progress watchdog, or host-capacity setting was changed.

## Retry root/support results

The retry admitted root/support after 79.3 seconds, bridges after 147.2 seconds,
protocol regeneration after 217.2 seconds, and workspace after 320.3 seconds.
Bridges and protocol regeneration passed.

Root/support reported 3152 passed, one skipped, two failed and one between-tests
error across 3155 tests in 149 files (279.36 seconds execution). One failure,
`honours a per-group deadline and lets the environment override it`, was caused
by the diagnostic invocation: `isolatedRunnerEnvironment()` inherits
`ORKESTRATOR_TEST_GROUP_TIMEOUT_MS`, overriding the fixture's 75 ms deadline
and causing the test itself to exceed five seconds. This is not classified as
a product regression or flake. The complete root/support command is rerun with
the default environment.

The other failure was `Pi bridge runtime vendoring > loads Pi's supported SDK
from the staged runtime closure`, at 30000.03 ms. The complete unchanged owner
passed alone: `mise run test:logged -- --name merge-pi-vendor-owner -- bun test
./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`, exit 0,
14.4 seconds. This confirms another recurrence of [0178](0178-pi-vendor-runtime-aggregate-timeout.md).

The complete root/support group then passed unchanged with the default
environment: `mise run test:logged -- --name merge-root-clean-env -- bun test
./tests ./e2e/agent-testing/artifact-sanitizer.test.ts
./e2e/agent-testing/design-live-usage.test.ts
./e2e/agent-testing/design-live-heartbeat.test.ts
./e2e/agent-testing/mcp-apply-live-support.test.ts
./e2e/agent-testing/mcp-apply-live-safety.test.ts
./scripts/opencode-live-compatibility-probe.test.ts
./test-fixtures/agent-project/server.test.ts --parallel=1 --only-failures`,
exit 0, 183.1 seconds. This includes the runner deadline test and the Pi owner.

The retry completed after 773.7 seconds with workspace, bridges and protocol
regeneration passing. Its command exit was 1 because of the root/support
failures described above; the separate complete default-environment root/support
run passed. Combined evidence covers every non-iOS group. Electron nickname
synchronization and terminal startup-dialog visibility remain non-green.

Retry artifacts: `orkestrator-test-run.WUyftW/` (per-group logs and summary)
and `orkestrator-test-run.zRUWl3/merge-full-retry.log.gz` (outer command), below
the host temporary directory. Formatting, lint, typechecking and the desktop
production build passed. Browser, design, Docker lifecycle, published-CLI
scenario and iOS suites were omitted because the paths imported by this merge
do not change those areas; credentialed live-provider checks retained their
opt-ins. The Electron suite and owning-file reruns used disposable fixtures
with their built-in cleanup.

## Main refresh on 2026-10-22

Merged `c66604e25` into `7a165b7f` as `85ad91e25`. The four conflicts were the
container-account implementation and tests, this register's index, and the old
TODO index. Resolution preserves access-only Claude delivery and host renewal,
main's truthful Codex restart markers, and a single captured identity/home/login
generation for credential, identity and marker writes. Focused account/login
checks passed (`merge2-account-tests`, 5.6 s), as did format (0.6 s), lint (2.3 s),
typecheck (11.6 s), the desktop production build (124.1 s), frozen installs, and
the packaged CLI scenarios (97.2 s). No assertion, timeout or skip was relaxed.

`ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=3600000 mise run test:logged -- --name
merge2-full-suite -- env -u ORKESTRATOR_TEST_GROUP_TIMEOUT_MS mise run test`
exited 1 after 1043.8 s. The outer deadline allows host admission time; the child
suite receives its default environment. Protocol regeneration passed. Workspace
packages other than backend passed; backend reported 9954 passed, 69 skipped and
three failed. Root/support reported 3219 passed, one skipped, two failed and one
between-tests error. Codex reported 2251 passed, 34 skipped and two failed;
the other bridges passed. Failure evidence is below the host temporary directory
in `orkestrator-test-run.UUvwOn/` and `orkestrator-test-run.YGBcDG/`.

- Codex runtime-env and deleted-session retry recurred ([0093](0093-runtime-environment-refresh-sources-configured-r.md),
  [0492](0492-codex-deleted-session-initial-retry-race.md)). Complete unchanged owners
  passed individually with the Node preload and `--parallel=1`: logged names
  `merge2-codex-env-owner` (0.5 s) and `merge2-codex-prompt-owner` (6.5 s).
- The root tmux reactivation-scroll case ([0482](0482-claude-tmux-reactivation-scroll-timing.md))
  passed its unchanged whole owner alone, `merge2-tmux-owner` (6.8 s).
- The disk-report checkout case ([0259](0259-disk-report-aggregate-timeout.md))
  timed out in aggregate (5020.48 ms) and its whole-file rerun (5075.26 ms,
  four passed, one failed and one error). This observation is not a confirmed
  flake. Evidence: `orkestrator-test-run.ifAx42/merge2-disk-owner.log.gz`.
- Backend failures were the Mermaid watchdog (13143.47 ms), driven observation
  baseline (5086.75 ms) and hanging-provider teardown elapsed bound (386.29 ms;
  observed elapsed 361.44 ms against 250 ms). Those owners were not rerun;
  the full suite remains non-green.

`mise run test:logged -- --name merge2-browser -- mise run test:browser` exited 1
at 663.7 s: 386 passed, 81 skipped, 13 failed. All nine unchanged owning files
then passed individually with one worker, both viewport projects and private
fixture port 14582. The logged command for each is
`ORKESTRATOR_E2E_PORT=14582 mise run test:logged -- --name merge2-browser-owner-<owner>
-- bunx playwright test --config e2e/playwright.config.ts e2e/<owner>.spec.ts
--workers=1 --output=output/playwright/merge2-<owner>`:

| Owner | Seconds |
| --- | --- |
| PaneBreakpoint | 27.7 |
| SetupRecovery | 7.4 |
| TranscriptPaging | 48.4 |
| AgentUsage | 34.6 |
| ClaudeInteractions | 16.9 |
| DesignCanvas | 21.6 |
| GlobalSettings | 10.7 |
| GlobalStyles | 14.2 |
| MonacoRuntime | 5.9 |

The component aggregate's evidence is `orkestrator-test-run.FwOuqb/merge2-browser.log.gz`.
Public-site browser checks passed separately (`merge2-public-browser`, 12.7 s).

The complete Electron suite (`merge2-electron`) had 28 passed, one skipped and
one failed in 579.0 s: the remote nickname reload missed its five-second bound.
The complete unchanged `electron-main.spec.ts` owner passed alone (three passed,
one platform skip, 58.1 s), using logged name `merge2-electron-main-owner` and
run id `merge2-claude-electron-owner`. The original evidence is
`orkestrator-test-run.Rw0w5U/merge2-electron.log.gz`; the owner traces are under
`output/agent-testing/merge2-claude-electron-owner/`.

The workspace development image built (`merge2-docker-image`, 128.9 s). The
Docker fixture suite (`merge2-docker`, profile `merge-claude-main-20261022`, run
id `merge2-claude-docker`) passed: ten passed, two credentialed/live skips,
223.7 s. The profile used fabricated credentials only, was stopped and reset,
and exact-owner cleanup removed two containers, four volumes, one network and
its disposable state. No billed live-provider qualification or iOS suite ran.

After these checks, `origin/main` moved to `b83ae534a`. Inspection confirmed a
backlog-document reorganization and reference updates, including comments and
test input paths, without behavioral changes. Per the user's explicit request,
that update is merged without additional tests, typechecks or builds. Its
conflicts retain the new ranked folders, access-only Claude documentation and
completed account-identity synchronization, removing the superseded flat index.

The isolated real-stack browser check already started before the documentation
refresh also completed: `merge2-isolated-browser`, exit 1 at 648.9 s, 27 passed,
51 opt-in skips and two failed (`browser-gateway.spec.ts` narrow SSH socket
picker, and `cli-ui.spec.ts` CLI-to-UI persistence). These owners were not rerun.
Evidence: `orkestrator-test-run.WbRSOH/merge2-isolated-browser.log.gz`; traces
under `output/agent-testing/qa-browser-47055d41-4c9/browser/`. The one-shot
runner stopped and reset that profile and removed its disposable state. The
later documentation merge received text/conflict/link inspection only, with
no new test, typecheck or build invocation.
