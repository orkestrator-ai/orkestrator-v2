# Dialog default width branch validation

- **ID:** 1251
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

## Review repair validation (2026-10-28)

The review repair (`22f7041f7`) waits for the approval dialog's opening animation,
parses JSX and local class constants in the width guard, and adds rendered-width
checks for source, file, gallery, Mermaid and table viewers at phone, desktop
and wide-desktop widths.

Targeted checks passed:

- `mise run test:logged -- --name dialog-width-unit -- bun test --cwd apps/web ./src/components/ui/dialog.test.tsx --parallel=1 --only-failures` (1.5 s).
- `mise run test:logged -- --name dialog-width-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentsMdApproval.spec.ts e2e/ExpandedViewers.spec.ts --repeat-each=5 --workers=4` (110 passed, 70.4 s), including the immediately resolved approval preview in both viewport projects.
- Scoped web and browser typechecks (`bun check -p apps/web/tsconfig.json` and `bun check -p e2e/tsconfig.json`), oxlint and formatting checks on the changed source files, through `test:logged`.
- `tests/unit/playwright-spec-loading.test.ts` (30.7 s) and `tests/unit/flaky-tests-index.test.ts` through `test:logged`, with one Bun worker.

Preparation had already passed the default suite and full static checks; those
passing aggregate commands were not repeated. Its failed browser and Electron
commands were rerun exactly:

| Command | Result | Evidence under the host temporary directory |
| --- | --- | --- |
| `mise run test:logged -- --name browser -- mise run test:browser` | 855 passed, 42 failed, 105 skipped; nine workers, 1,566.0 s. The component failure prevented the public-site stage from running. | `orkestrator-test-run.menF4P/browser.log.gz` |
| `mise run test:logged -- --name agent-electron -- mise run test:agent:electron` | 33 passed, four failed, one skipped, six not run; one worker, 608.9 s. | `orkestrator-test-run.Fk5GUs/agent-electron.log.gz` |

Both evidence directories are under
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/`.

The browser run accumulated navigation/reload and interaction timeouts across
many unchanged specs, alongside the native datalist failure. Host load averages
were 121.61 / 109.61 / 82.65 at 14:47 and 102.66 / 112.52 / 100.64 at 14:59;
load is an observation, not a proven cause. The mobile unrendered-frame layer
failure passed in its complete unchanged owner (14 cases, one worker, 419.7 s)
and is tracked in [1249](../design-canvas-and-artifacts/1249-design-layer-tree-unrendered-row.md).

The new desktop `source viewer preserves its expanded width inside the viewport`
case also exceeded its 30-second test deadline in `page.goto`, waiting for
`load`, before any width assertion. Its complete unchanged owner then passed
all ten cases across both viewports in 33.7 s:

```sh
mise run test:logged -- --name expanded-viewers-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ExpandedViewers.spec.ts --workers=1
```

This records a credible navigation flake in that owner; no layout assertion was
skipped, relaxed, or changed. The remaining broad browser failures were not
individually rerun or newly classified as flaky in this repair.

The Electron failures were the existing design graceful-quit deadline
([1131](../design-canvas-and-artifacts/1131-design-electron-graceful-quit-deadline.md)),
service-preview HMR not applying v3 in place, annotation descendant processes
remaining alive during the zoom/DPR journey, and a workspace-realm screenshot
not appearing. No new isolated diagnosis is claimed for those failures.

Playwright owns the component fixture server and disposable Electron fixtures.
No named `dev:test` profile was started by this repair; no matching live test
launcher remained after the runs. Compressed failure logs and Electron artifacts were retained.
