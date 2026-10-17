# Coordinator fixture digest times out in the aggregate

- **ID:** 0258
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `fixture tree digest > names every class of change a coordinator could make`
- **Owning file:** `apps/desktop/scripts/dev/coordinator-live.test.ts`
- **Original command and workers:** `mise run test:logged -- --name merge-tests -- mise run test`, with system Python and the testing guide's GNU utilities available in PATH. Workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two isolated workers and root used one. Component and isolated-stack browser validation ran alongside it.
- **Failure:** The 5000 ms deadline expired at 5028.75 ms; a racing `git symbolic-ref` exited -1 and produced an error between tests.
- **Suite counts:** Desktop: 729 passed, one failed, one error across 730 tests (51.74 s).
- **Isolated rerun:** `mise run test:logged -- --name merge-coordinator-digest-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/coordinator-live.test.ts --parallel=1 --only-failures` passed the unchanged owning file, exit 0, in 3.1 s, with the same PATH preference.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.Gj6LAK/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** process and filesystem contention on the shared host is plausible but unconfirmed. No assertion, timeout or skip was changed.

## Codex sub-agent review validation recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test` (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots, alongside other worktree validations and the component browser suite.
- **Failure:** the same case exceeded its 5000 ms budget at 5012.40 ms; a racing `git rev-parse` exited -1 and produced an error between tests.
- **Suite counts:** desktop reported 729 passed, one failed and one between-tests error across 730 tests. The aggregate exited 1 after 582.8 seconds; backend timeout recurrences are recorded in 0162, 0165 and 0211. Root failed on the pre-existing missing metadata in case 0265; bridges and protocol verification passed.
- **Owning-file rerun:** `mise run test:logged -- --name fixture-digest-isolated -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/coordinator-live.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 4.9 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.8J9UKQ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Assessment:** the unchanged owning-file pass confirms an intermittent recurrence. Shared-host contention remains a hypothesis. No owning implementation, assertion, timeout or skip changed.

## Container platform qualification recurrence — 2026-10-17

`mise run test` on branch `todo-container-live-qualification-8efe5278910a-r1`
(based on `31d0fb06`, no desktop source changes) timed out again at 5022.08 ms,
again with `git rev-parse exited -1` as an error between tests. Host load
average was about 20–33 on 18 cores, with nine other environments testing. The
unchanged owning file passed alone: `mise exec -- bun test --cwd apps/desktop
--preload ../../tests/setup-node.ts ./scripts/dev/coordinator-live.test.ts
--parallel=2 --only-failures` reported 30 passed in 4.94 s. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.v19VcP`.
No assertion, timeout or skip changed.
