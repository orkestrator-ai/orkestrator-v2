# Queued-steer main merge validation — 2026-10-19

- **ID:** 0501
- **Status:** open

## Scope

Merged `origin/main` at `ef52cca4` into pre-merge HEAD `9da97ff8` on
`queued-prompt-steering-3970ea85ceea-r1`. The 197 changed paths include backend,
renderer, Electron, protocol, CLI, release tooling, configuration and tests.
Conflicts were confined to the flaky-test index and cases 0165 and 0226; both
branches' evidence was retained, including main's relocation of environmental
index entries. No implementation, assertion, timeout or skip was changed to
address validation failures.

## First full run

`mise run test:logged -- --name merge-full -- mise run test`, with the testing
guide's macOS GNU-tool PATH prefix and Bun 1.4.3, exited 1 in 512.0 seconds.
Workspace/root/bridges/protocol reserved 4/1/2/1 slots, alongside component and
isolated browser validation. Evidence is under the host temporary directory:
`orkestrator-test-run.4W0xYA/` (group logs and summary) and
`orkestrator-test-run.1ipHn8/merge-full.log.gz` (outer log).

- Backend: 9140 passed, 41 skipped, two failed and one between-test error
  across 9183 tests in 490 files (371.07 s). Case
  [0165](0165-coordinator-bound-discard-timeout.md) timed out at 5212.81 ms;
  case [0226](0226-deletion-reap-failure-aggregate-timeout.md) at 5942.27 ms.
  Late coordinator Git work produced the between-test error.
- Root/support: 3146 passed, one skipped and one failed. Case
  [0178](0178-pi-vendor-runtime-aggregate-timeout.md) timed out staging the Pi
  SDK at 30005.31 ms.
- Claude bridge: 1575 passed, five skipped and one failed. Case
  [0385](0385-claude-enter-plan-fixture-directory-race.md) recurred in
  `denies EnterPlanMode when its durable preference cannot be written`:
  `.claude` was already a directory (`EISDIR`, 1.88 ms).
- Desktop: the Electron bundle test could not resolve `builder-util-runtime`
  before the newly merged dependency had been linked locally. Both frozen
  installs succeeded; typechecking and the bundle owner then passed. This
  setup failure is not classified as a flake.
- Every other workspace and bridge package, and protocol regeneration, passed.

## Owning-file reruns

Each command used `mise run test:logged -- --name <name> --` and the owning
file's normal preload, with `--parallel=1 --only-failures`:

| Name | Command after the logged prefix | Result |
| --- | --- | --- |
| `merge-desktop-bundle-owner` | `bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/electron-bundle.test.ts --parallel=1 --only-failures` | Passed, 0.2 s |
| `merge-claude-interactions-owner` | `bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-interactions.test.ts --parallel=1 --only-failures` | Passed unchanged, 0.5 s |
| `merge-coordinator-owner` | `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` | Passed unchanged, 12.3 s |
| `merge-deletion-owner` | `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-registry-environments.test.ts --parallel=1 --only-failures` | Passed unchanged, 18.2 s |
| `merge-pi-vendor-owner` | `bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures` | Three passed, one timed out at 30000.38 ms; exit 1, 31.2 s |

The passing owners establish intermittence for the coordinator, deletion and
Claude cases. The first isolated Pi failure does not establish a flake for
this observation. Its evidence is
`orkestrator-test-run.QpdTeT/merge-pi-vendor-owner.log.gz` below the host
temporary directory. Shared-host contention remains a hypothesis.

After the first aggregate and both browser tasks finished,
`mise run test:logged -- --name merge-pi-vendor-post-aggregate -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures`
passed the unchanged owner (exit 0, 5.6 s). This confirms intermittence for
the Pi staging observation; the earlier isolated timeout remains recorded.

## Browser and other checks

- `merge-format`, `merge-lint`, `merge-typecheck-installed` and `merge-build`
  passed. Lint retains existing warnings. The initial typecheck ran before
  the newly merged dependency was linked; the installed rerun passed.
- Both repository-pinned frozen installs passed without changing lockfiles.
- `merge-cli-scenarios` passed in 45.2 s.
- `merge-electron` ran `mise run test:agent:electron` and passed in 113.4 s:
  21 passed, one skipped, no unexpected failures or flaky retries. This
  includes all service-preview transport cases. Results are in
  `output/agent-testing/electron-smoke/electron/results.json`.
- The first component browser invocation found another checkout's fixture on
  port 1422 and refused to use it. `merge-browser-private`, with
  `ORKESTRATOR_E2E_PORT=21422` and `ORKESTRATOR_PUBLIC_E2E_PORT=24423`, passed
  the complete component and public-site task in 216.0 s.
- `merge-agent-browser` ran `mise run test:agent:browser:isolated`: 28 passed,
  36 skipped and one failed in 471.7 s logged. Case
  [0224](0224-host-picker-narrow-tools-popover.md) timed out clicking the
  hidden `Repository settings` button at the 15-second deadline. This run
  alone does not establish intermittence. Profile `qa-browser-a9fc77dc-b70`
  was stopped and removed. Evidence is
  `orkestrator-test-run.5qVT9z/merge-agent-browser.log.gz` below the host
  temporary directory; browser artifacts remain under
  `output/agent-testing/qa-browser-a9fc77dc-b70/browser/`.

The complete gateway owning file was then rerun in fresh credential-free
profile `qa-merge-gateway-3970ea`:
`ORKESTRATOR_AGENT_TEST_PROFILE=qa-merge-gateway-3970ea mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts browser-gateway.spec.ts --workers=1`.
It reported 13 passed, seven skipped and the same narrow picker failure
(exit 1, 124.2 s). This remains unresolved validation, not a confirmed flake
from this occurrence. Evidence is
`orkestrator-test-run.KyrGcS/merge-gateway-owner.log.gz` below the host
temporary directory and `output/agent-testing/qa-merge-gateway-3970ea/browser/`.
The profile was stopped and reset with the repository's lifecycle tasks.

iOS, Docker and credentialed live-provider scenarios were not run: this merge
does not change iOS or Docker lifecycle code, and live-provider qualification
is opt-in.

## Second full run

With the same GNU-tool PATH prefix,
`mise run test:logged -- --name merge-full-warm -- mise run test` exited 1 in
319.1 s. Every workspace package, root/support and protocol regeneration
passed. Backend reported 9142 passed and 41 skipped; web 8019 passed and ten
skipped; desktop 863 passed; root/support 3147 passed and one skipped.

The sole failure was `a warm Claude CLI between turns > failed plan-mode
admission rechecks capacity after restoring idle ownership` in
`bridges/claude-bridge/src/services/session-manager-runtime-idle.test.ts:341`:
the `.claude` fixture was already a directory (`EISDIR`, 1.19 ms). Claude
reported 1575 passed, five skipped and one failed; all other bridges passed.
This is the fixture-directory pattern recorded in case 0385, in another owner.

`mise run test:logged -- --name merge-claude-idle-owner -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/session-manager-runtime-idle.test.ts --parallel=1 --only-failures`
passed the unchanged owning file (exit 0, 0.3 s), establishing intermittence.
No implementation, assertion, timeout or skip changed. Group evidence is in
`orkestrator-test-run.5HRXgC/`; outer evidence is in
`orkestrator-test-run.nXPXGK/merge-full-warm.log.gz`, below the host temporary
directory.
