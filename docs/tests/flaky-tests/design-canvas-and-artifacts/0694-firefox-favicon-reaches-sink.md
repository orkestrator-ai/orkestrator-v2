# Executable document policy in Firefox: a favicon request reaches the sink

- **ID:** 0694
- **Status:** open
- **Date observed:** 2026-10-23
- **Test:** `executable document policy in firefox > popups, new-window links and top navigation reach the sink zero times`
- **Owner:** `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts:924`
- **Scope:** found while validating the todo 0019 qualification branch (`todo-0019-container-platform-qual-562f4e8c595a`, base `06297124`), which does not touch transcript artifacts, the content server or browser dependencies.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test` (the workspace group), host load average 12–60 from other environments.
- **Failure:** `expect(sink.hits).toEqual([])` received `["GET /favicon.ico"]` (about 3.3 s). Firefox requested the sink origin's favicon; no popup, new-window or navigation attempt reached it, and every `restricted[attempt]` count was 0.
- **Suite counts:** the workspace group failed with this case and `move_environment > moves a worktree with nested submodules (copy)` (a 5 s timeout, case [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md)); root, bridges and the codex protocol lockfile groups passed.
- **Isolated reruns:** the owning file alone failed the same way (`mise run test:logged -- --name engines-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/content-server.engines.test.ts --parallel=1`, 39 tests, 98 s). With `-t firefox`, the branch passed 1 of 3 runs, and a clean worktree of unchanged `main` (`06297124`) passed 2 of 5 runs, failing the same way. So it is intermittent and predates the branch.
- **Hypothesis:** Firefox fetches `/favicon.ico` for a page it navigated to or a popup it began to open, depending on timing, and the sink counts that fetch as a hit. Not proven.
- **Evidence:** `orkestrator-test-run.Gqog9k` (aggregate) and `orkestrator-test-run.fjNMnf` (owning file) below the host temporary directory.
- **Assessment:** open intermittent failure on `main`. No source, assertion, timeout or skip changed.
