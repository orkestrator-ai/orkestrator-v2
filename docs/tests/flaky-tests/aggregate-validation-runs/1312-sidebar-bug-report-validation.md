# Sidebar bottom bar and Report a bug branch validation

- **ID:** 1312
- **Status:** resolved
- **Date observed:** 2026-10-29
- **Command:** `mise run test` on branch `env-list-bottom-6d738241d2a2-r1`
  (uncommitted, on `672074860`). The diff adds the sidebar bottom bar, moves
  global settings out of the ActionBar, adds ⌘, and the Report a bug sheet
  with its `bug-report:<id>` backend runtime, and shares the `--fix` prompt.
- **Host load:** load average about 43–45 while the aggregate ran (657 s).
- **Groups:** bridges and the Codex protocol lockfile passed. Workspace:
  backend 10,173 passed, 87 skipped, 0 failed; CLI 300 passed; web 10,332
  passed, 10 skipped, 1 failed. Root and agent-support failed on one test.
- **Evidence:** `orkestrator-test-run.To59Nm` under the host temporary
  directory.

| Owner | Aggregate failure | Rerun |
| --- | --- | --- |
| `apps/web/src/components/federation/node-action-requests.test.tsx` | `root-change approval handles over-limit and still permits rejection` timed out at 5,000 ms (5,762 ms). | The complete unchanged owner passed alone twice (6.4 s, 7.0 s). Same owner as 1247, 1285, 1290 and 1295. |
| `tests/unit/flaky-tests-index.test.ts` | `case numbers are unique across and within groups` found case number 1304 used twice. | Fails alone too. Not a flake: `main` already holds `agent-bridges/1304-claude-cold-dispatch-resend-503.md` (#1414) and `previews-annotations-and-gateway/1304-preview-setup-terminal-root-timeout.md` (#1417). Neither is touched on this branch. |

Neither owner, nor the code it exercises, changed on this branch, and no
assertion, timeout or skip was changed. The aggregate result remains failed.

## Review fixes and validation (2026-10-29)

- The duplicate preview case was renumbered to
  `previews-annotations-and-gateway/1306-preview-setup-terminal-root-timeout.md`,
  retaining its evidence and status. The original preparation result above is
  historical.
- The exact failed command, `mise run test`, now passes all four default-tier
  groups (165.5 s). No flaky test assertion, timeout or skip was relaxed.
- Focused logged owners pass: bug-report service/runtime; native-agent service
  base, project commands and host catalogue seeding; bridge coordinator/server
  lifecycle; backend startup and local-server reaping; bug-report sheet and
  mobile shell.
- `MobileAppShellLayout.spec.ts` passes in both configured viewport projects.
  Relevant backend, web and agent-testing typechecks, changed-file lint,
  `mise run format:check` and `git diff --check` pass.
- The first isolated browser rerun reached and exercised both repaired 390px
  Settings scenarios. It also exposed a separate project-selection transition
  closing the tools popover in the narrow repository path-picker helper. That
  helper now retries the complete user action with bounded clicks, without
  bypassing the UI or loosening an assertion.

- The exact isolated command, `mise run test:agent:browser:isolated`, was rerun
  against the final helper: **37 passed, 73 opt-in skips, zero failures**
  (482.52 s including startup and cleanup). Both 390px Settings cases and the
  narrow repository path-picker case passed. Evidence is under
  `output/agent-testing/qa-browser-a0709f73-932/browser/`; the disposable profile
  was stopped and reset successfully. The preceding failed run is retained
  under `output/agent-testing/qa-browser-6c3b4c00-773/browser/`.
- Live-provider and Docker qualification remain opt-in; this round adds focused
  deterministic tests for report session authority, briefing/retry and discard
  races, bridge identity/MCP isolation, and filing security/failure paths.

- **Merge register repair (2026-10-29):** renumbered from 1305 to 1311
  because `main` independently assigned 1305 to the Claude cold-dispatch
  restart-admission case; all original evidence and status are retained.

- **Subsequent merge register repair (2026-10-29):** renumbered from 1311
  to 1312 because `main` independently assigned 1311 to the graph-designer
  keyboard case; all original evidence and status are retained.
