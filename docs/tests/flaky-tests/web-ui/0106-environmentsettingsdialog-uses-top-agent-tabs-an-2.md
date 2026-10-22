# `EnvironmentSettingsDialog > uses top agent tabs and shows MCP servers, plugins, and skills for each agent` (`tests/unit/components/EnvironmentSettingsDialog.test.tsx:304`)

- **ID:** 0106
- **Status:** resolved
- **Date observed:** 2026-08-13
- **Original command:** `bun run test` on an 18-logical-core macOS host, whose root group is `bun test tests --parallel=<planWorkers rootShare>`
- **Failure:** `expect(received).toEqual(expected)` — `screen.getAllByRole("tab")` returned `["Claude", "Codex", "OpenCode", "Rendered", "Raw"]` against the expected `["Claude", "Codex", "OpenCode"]`. Duration 20.69 ms.
- **Suite counts for that run:** root group 3,910 passed, 1 skipped, 1 failed; the workspace, bridges, and Codex protocol lockfile groups all passed.
- **Isolated rerun:** `bun test tests/unit/components/EnvironmentSettingsDialog.test.tsx` -> 20 passed, 0 failed, 93 assertions. The file is self-sufficient.
- **Hypothesis (evidence-backed, root cause not confirmed):** the two surplus tabs are not rendered by this dialog. `apps/web/src/components/settings/SkillsSettings.tsx:509-514` renders a `Tabs` with exactly `rendered` and `raw` triggers, and `tests/unit/components/SettingsPage.test.tsx` is the only file in the root group that mounts `SkillsSettings`. `--parallel` implies `--isolate`, so each file gets a fresh module registry and therefore a fresh Testing Library container registry — but `document.body` is shared by every file a worker process runs in sequence. A container left mounted by an earlier file is invisible to this file's `cleanup()` and still visible to `getAllByRole`, which queries the whole document. That makes the failure depend on which files happen to share a worker.
- **Reproduction attempts, all on 2026-08-13:**
  - `bun test tests --parallel` (the root group alone) -> 3 of 3 runs clean, 3,911 passed / 1 skipped / 0 failed each. The failure has so far appeared only under a full `bun run test`, where the root group runs concurrently with the workspace group's full web suite and the machine is far more loaded.
  - `bun test tests/unit/components/SettingsPage.test.tsx tests/unit/components/EnvironmentSettingsDialog.test.tsx` (both files, one process) -> 27 passed, 0 failed. Forcing the suspected pair together did not reproduce it, so file pairing alone is not sufficient.
  - `bun test tests/unit/components` (whole directory, single process) does reproduce this failure, **but that result is not evidence for this entry.** Without `--isolate` the run also triggers the `mock.module` cross-file leakage documented in `AGENTS.md`, cascading roughly twenty unrelated failures. Any future investigation must stay in `--parallel`/`--isolate` mode.
- **Next step:** capture which files shared the worker on a failing run rather than guessing the pairing, since the leak is scheduling-dependent and the obvious pair is already ruled out.
- **Do not** narrow the assertion to "contains" to make this pass: the test asserts the exact agent tab set, and a leaked container is a real isolation defect worth locating.
