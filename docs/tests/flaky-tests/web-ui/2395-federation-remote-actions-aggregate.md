# Federation remote project and folder tests fail together in one aggregate

- **ID:** 2395
- **Status:** open
- **Date observed:** 2026-11-01
- **Tests:**
  - `apps/web/src/components/federation/WorkspaceRealmHost.test.tsx`: `grouped by repository, remote project name opens Home in a leaf realm`; `grouped by repository, remote project Open Board opens Coordinator in a leaf realm`; `grouped by machine, remote project name opens Coordinator in a leaf realm`; `grouped by machine, remote project Open Board opens Coordinator in a leaf realm`; `grouped by project, remote project name opens Coordinator in a leaf realm`.
  - `apps/web/src/components/federation/federation-ui.test.tsx`: `CL-05: machine identity visual rules > CL-05: an environment row is named by environment, machine and activity`; `CL-05: machine identity visual rules > another machine's clean PR stays plain without leaf monitor health`; `remote folder actions submit owner-specific changes and expand the destination`; `remote folder actions roll back failed writes`.
- **Original command:** `mise run test` on branch `shared-logger-foundation-and-electron-r1-slice-1-2a438948d729` based on `2d183a53c`. Web: 9 failed.
- **Failures:** elements not found in the realm host tests, `expect(describedBy).toBeNull()` receiving `_r_5t_` at `federation-ui.test.tsx:756`, and `waitFor` timeouts of about 1,000 ms in the folder actions.
- **Isolated rerun:** `mise run test:logged -- --name federation-web -- bun --cwd=apps/web test src/components/federation/WorkspaceRealmHost.test.tsx src/components/federation/federation-ui.test.tsx --parallel=2 --only-failures` passed (2.2 s), after rebasing onto `066fcb497`.
- **Later aggregate:** `mise run test` on the rebased branch: web 11,124 passed, 0 failed.
- **Hypothesis:** not established. The isolated rerun and the later aggregate are on the newer base, so a fix in `406f5074b` or `066fcb497` is not ruled out; the owners were not rerun alone on `2d183a53c`. The branch changes nothing under `apps/web`.
