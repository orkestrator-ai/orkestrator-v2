# Agent accounts and sign-in (0003) validation

- **ID:** 0740
- **Status:** open
- **Date observed:** 2026-10-24, node mbp3
- **Scope:** todo 0003 branch (`todo-0003-accounts-sign-in-cf5acbb74387`) after merging `origin/main` at `71227437`.

## Non-iOS repository suite

`ORKESTRATOR_TEST_AREA_BASE=$(git merge-base HEAD origin/main) mise run test:logged -- --name full-suite -- mise run test`
exited 1 after 632.0 s. Bridges and the Codex protocol lockfile group passed;
web 9212 passed, 10 skipped, 0 failed; root and agent-support 3370 passed and
14 failed; backend 10363 passed, 115 skipped and 14 failed.

| Owner | Failure | Complete owner rerun |
| --- | --- | --- |
| `tests/unit/test-diagnostic-bounds.test.ts` | `never passes a DOM-producing query result directly to toBeNull` named two test files this branch changed. | A real defect in the branch, not a flake: both files now compare `=== null`. The owner then passed (16 passed). |
| `tests/unit/firewall-policy.test.ts` | Thirteen `container firewall policy` cases hit Bun's five-second budget (~5,003 ms each). | Unchanged owner passed alone (24 passed, 0 failed). Registered as [0632](../environments-and-containers/0632-firewall-policy-probe-budget.md) and [0192](../environments-and-containers/0192-firewall-bootstrap-shell-timeout.md). |
| `apps/backend/src/core/conformance-execution-policy.test.ts` | Fourteen `execution policy conformance: opencode` cases expected OpenCode `1.19.0`; the installed CLI on mbp3 reports `1.19.4`. | Reproduces alone (56 passed, 14 failed): an environmental version mismatch on this host, already seen in [0512](../design-canvas-and-artifacts/0512-mermaid-watchdog-elapsed-under-load.md) and [0310](../native-agents-and-transcripts/0310-codex-subagent-cards-projection-wait-timeout.md). The branch does not touch OpenCode or the conformance suite. |

Owner rerun commands, from the repository root:

```sh
bun test tests/unit/test-diagnostic-bounds.test.ts
bun test tests/unit/firewall-policy.test.ts
(cd apps/backend && bun test --preload ../../tests/setup-node.ts src/core/conformance-execution-policy.test.ts)
```

Artifacts below the host temporary directory:
`orkestrator-test-run.WDlOx0/root-and-agent-support-tests.log.gz` and
`orkestrator-test-run.WDlOx0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

An earlier standalone Codex bridge run on this branch hit
[0093](../agent-bridges/0093-runtime-environment-refresh-sources-configured-r.md);
its unchanged owner passed alone.

## Merge through main `8290f2ca9` — 2026-10-24

The merge parents are `2d55fd59fb24ea9e117150b662b067198d896f61` and
`8290f2ca919206c161f42d327823b3202528a006`. Before any resolution was
staged, all fourteen original unmerged paths were retained as NUL-separated
bytes alongside both parent IDs in this worktree's local Git metadata
(`merge-conflict-records/<parent>--<parent>/original-unmerged-paths.z`).
The combined delta from their common ancestor contains code, configuration,
tests and prose, so validation includes auto-merged changes.

### Conflict resolutions

| Original conflicted file | Resolution |
| --- | --- |
| `apps/backend/src/core/agent-accounts-homes.ts` | Keep the branch's shared Claude credential lookup; discard the now-unused Keychain constant import. |
| `apps/backend/src/core/commands-registry-accounts.ts` | Retain session-free sign-in status and main's machine-account, session-account and terminal sign-in commands. |
| `apps/backend/src/core/commands-registry-accounts.test.ts` | Retain both sets of argument-validation and dispatch tests. |
| `apps/backend/src/core/commands-runtime-state.ts` | Accept main's deletion; move the branch's explicit host Claude config-directory constant into the extracted `agent-credential-files.ts`. |
| `apps/backend/src/core/commands-servers.ts` | Use main's owned local-server runtime while retaining bounded, credential-redacted bridge output. |
| `apps/web/src/components/settings/AgentAccountsSection.test.tsx` | Keep both account-change notification and selected-machine routing coverage. |
| `apps/web/src/components/settings/GlobalSettings.sections.tsx` | Keep the status card and account-change refresh within main's machine scope; render Cursor sign-in once. |
| `docs/architecture/agent-accounts.md` | Document the extracted runtime and the new sign-in surfaces. |
| `docs/tests/flaky-tests/agent-bridges/0000-index.md` | Retain both branches' runtime-environment recurrence observations. |
| `docs/tests/flaky-tests/agent-bridges/0093-runtime-environment-refresh-sources-configured-r.md` | Retain both dated validation histories. |
| `docs/tests/flaky-tests/environments-and-containers/0192-firewall-bootstrap-shell-timeout.md` | Retain both branches' observations. |
| `docs/tests/flaky-tests/environments-and-containers/0632-firewall-policy-probe-budget.md` | Retain both branches' observations. |
| `docs/todo/agent-engines/0000-index.md` | Keep main's per-machine qualification item and the branch's completed sign-in implementation status; renumber ranks. |
| `docs/todo/agent-engines/0003-agent-accounts-and-sign-in.md` | Keep the branch's implementation and qualification notes and reference the extracted runtime. |

Integration fixes also update auto-merged terminal and container-operation calls
to main's runtime APIs. Status reads and Claude reauthentication now use the
same selected machine as the account controls, with a regression test proving
no sign-in command falls back to the local backend. Two native-tab mock
expectations now include the optional machine argument. The Agent Info sign-in
mock returns a valid account snapshot instead of `{}`, which otherwise crashes
main's new account panel and cascades through later tests. The workspace realm
scenario now checks main's intended direct coordinator access for an unmatched
repository, including the absence of pending/error/gate views and presence of
the coordinator panel.

### Verification

All commands use the repository-pinned Bun through mise and the bounded
`test:logged` runner. Passing static checks are `mise run format:check`,
`mise run lint` (existing warnings remain), and `mise run typecheck`.
Focused backend accounts/log-redaction/runtime, web accounts/status/reauth,
container hand-off/terminal/coordinator, native-tab and Agent Info owners pass.
CLI scenarios and public-site browser checks pass. The isolated image build
and Docker suite pass (eleven passed, two opt-in skips); profile
`merge-accounts-main` was stopped and reset, removing only its two owned
containers, four volumes, one network and disposable state. No iOS files
changed; live provider qualification was not enabled.

The original broad runs remain failed; owner reruns do not turn them green:

- `mise run test:logged -- --name merge-browser-fixed -- mise run test:browser`:
  nine workers, 577 passed, 102 skipped, seven failed (694.4 s). The complete
  owners rerun sequentially with one worker using
  `mise run test:logged -- --name merge-browser-owners -- bunx playwright test --config e2e/playwright.config.ts AgentUsage.spec.ts DesignCanvas.spec.ts PaneBreakpoint.spec.ts AgentLaunchDialog.spec.ts MonacoRuntime.spec.ts VirtuosoFollow.spec.ts --workers=1`
  reported twenty passed, four skipped and two failures (127.0 s). Usage,
  canvas, pane, Monaco and follow owners pass unchanged. Native branch
  selection still receives `rel` instead of `release/2.0` in both viewports;
  this spec and its implementation were not changed by this merge resolution.
- `mise run test:logged -- --name merge-electron -- mise run test:agent:electron`:
  one worker, 26 passed, one skipped, one not run, four failed (558.2 s).
  Complete main-window and service-preview owners pass unchanged (three passed
  and one skipped in 97.7 s; fourteen passed in 130.4 s). The annotation owner
  retains native focus failures: a sequential rerun reports six passed, one
  failed and three not run (63.1 s), at `pressControl`'s five-second focus
  check. After correcting the stale coordinator expectation, the workspace
  owner passes that section but fails a later Agent information focus poll
  (`workspace-realm-electron.spec.ts:409`, 34.7 s). These focus observations
  are not classified as newly confirmed flakes.
- Root/support: 3,377 passed, six failed and one error across 161 files
  (546.21 s). Five firewall cases exceeded five seconds; the complete
  unchanged owner rerun reports 21 passed and three failed (47.1 s).
  Disk report exceeded five seconds plus an error between tests; its owner
  rerun reports four passed, one failed and one error (6.0 s). Both owners
  and their supporting implementation match main. These observations remain
  non-green in isolation, rather than newly confirmed flakes.

Owner commands for Electron use `bunx playwright test --config
e2e/agent-testing/playwright.electron.config.ts <owner> --workers=1` through
`test:logged`, with distinct `ORKESTRATOR_AGENT_TEST_RUN_ID` values.
Firewall and disk-report owners use `bun test ./tests/unit/<owner>.test.ts
--parallel=1 --only-failures`, also through `test:logged`.

Private artifacts below the host temporary directory:

- Full repository wrapper/groups: `orkestrator-test-run.eRZshg` /
  `orkestrator-test-run.AdOl8u`.
- Browser original/owners: `orkestrator-test-run.BIyzun` /
  `orkestrator-test-run.ngoXeT`.
- Electron original: `orkestrator-test-run.3IicXN`.
- Annotation sequential owner: `orkestrator-test-run.qZS9rW`;
  corrected workspace owner: `orkestrator-test-run.oFXpu3`.
- Firewall owner: `orkestrator-test-run.IdPXhs`;
  disk-report owner: `orkestrator-test-run.kKsk4G`.

No test was disabled, no deadline was increased, and no Git hook was bypassed.

The complete web package passes after the mock fixes:
`mise run test:logged -- --name merge-web-package -- bun run --cwd apps/web test:workspace`
(exit 0, 196.6 s). The unchanged environment-move owner also passes (33.9 s)
after its five-second aggregate submodule-relink timeout (5133.53 ms), recorded
in [0291](../environments-and-containers/0291-environment-move-submodule-aggregate-timeout.md).

The OpenCode conformance mismatch also reproduces in its complete unchanged
owner: `mise run test:logged -- --name merge-opencode-policy-owner -- bun test --cwd apps/backend ./src/core/conformance-execution-policy.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` reports 56 passed and fourteen failed (6.2 s). Every failure is the existing `1.19.0` expectation receiving `1.19.4`; this owner matches main. Evidence: `orkestrator-test-run.sVfGQt/merge-opencode-policy-owner.log.gz` below the host temporary directory. This is the same mismatch documented earlier in this case; no conformance assertion was changed.

Container-server registration also had a five-second Codex startup timeout
(5002.62 ms) followed by Cursor reaching a removed fixture Docker socket
(3546.12 ms). Its complete unchanged owner passes (31.1 s), command and
evidence recorded in [0750](../environments-and-containers/0750-container-server-startup-aggregate-timeout.md).

### Final default-suite outcome

The complete default suite finished in 1,369.4 s, exit 1. Bridges and Codex
protocol groups passed. Workspace packages public web (41 passed), protocol
(1,835 passed), desktop (1,232 passed, fourteen skipped), toolchain (91 passed)
and CLI (227 passed) passed. Initial web counts were 9,266 passed, ten skipped
and 126 failed: two optional-machine mock expectations and the account-snapshot
mock failure with its subsequent render-error cascade. Those fixture defects
are fixed and the complete web package subsequently passes (196.6 s).
Backend: 10,744 passed, 115 skipped, seventeen failed and two between-test
errors across 637 files (660.82 s execution). Its failures are fourteen
OpenCode version mismatches, the environment-move timeout and two container
server-startup failures described above. The last two complete owning files
pass unchanged; the OpenCode version mismatch remains reproducible alone.
Root/support totals and remaining browser/Electron limitations are recorded
above. These original aggregate exits remain failed, with their private
compressed logs retained. Final formatting, lint, typechecking and relative
documentation-link checks pass. No required check was skipped because the
conflicts included documentation.
