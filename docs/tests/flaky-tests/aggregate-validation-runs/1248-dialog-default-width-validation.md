# Dialog default width branch validation

- **ID:** 1248
- **Status:** open
- **Date observed:** 2026-10-28
- **Branch:** `dialog-default-width-f9e00713408e`, rebased on `origin/main`
  `68c84506c`.
- **Commands:** `bunx playwright test --config e2e/playwright.config.ts`
  (component browser suite, nine workers) and `mise run test`.

## Component browser suite

876 passed, 105 skipped and seven failed in 9.5 minutes, before the branch's
final width change. Two failures were the branch's own and were fixed:
`e2e/MachinesSettings.spec.ts` "Add machine keeps the viewport gutter and
responsive cap at 639px" in both projects, because the first draft capped
dialogs below `sm`. After the fix, the owning spec passed alone with
`AgentsMdApproval.spec.ts` and `AgentLaunchDialog.spec.ts` (84 passed, two
failed: the datalist cases below), and a 276-case rerun of the dialog specs
passed (259 passed, 17 skipped).

| Owner | Aggregate failure | Unchanged owner rerun |
| --- | --- | --- |
| `e2e/AgentLaunchDialog.spec.ts` | "selects a native branch suggestion with the keyboard and confirms" in both projects: the input stayed `rel` instead of `release/2.0`. | Failed alone the same way, both on the branch and with `apps/web/src` and `e2e` checked out from `origin/main`. It needs Chrome's native datalist popup in a graphical session, as in [1155](1155-webkit-title-tooltip-0202-validation.md) and [0790](0790-environment-list-main-merge-validation.md). |
| `e2e/PaneBreakpoint.spec.ts` | Mobile "split panes keep terminal output, scroll positions and the draft across the breakpoint (in the app shell, moveBefore)". | Passed alone with the next two owners (49 passed, one skipped, 40.1 s). |
| `e2e/CodexSubagentCards.spec.ts` | Desktop "Codex sub-agent cards stay one per child through reload and a cold restart". | Passed in the same rerun. |
| `e2e/ToolGroupFold.spec.ts` | Desktop "a waiting group that fits its cap follows appended calls as it starts overflowing". | Passed in the same rerun. |

None of these four owners, or the components they render, changed on this
branch apart from `AgentLaunchDialog`'s width class, which the
failure does not depend on: it fails the same way on `origin/main` sources.

## `mise run test`

Workspace, bridges and Codex protocol groups passed; the root group failed only
`tests/unit/components/AddProjectDialog.test.tsx` "caps the dialog width at
2xl", a branch defect: the test asserted the old `sm:max-w-2xl` class. It was
updated to the new width class and passed alone (47 passed). Evidence:
`orkestrator-test-run.tE6cWO` under the host temporary directory.

A second `mise run test` on the committed branch passed every group
(workspace, root, bridges and Codex protocol; 1,508.8 s under host load).
