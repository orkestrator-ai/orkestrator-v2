# Tmux teardown cleanup rejects under aggregate load

- **ID:** 0236
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `Electron tmux environment teardown > a start queued behind environment teardown rejects the deletion tombstone`
- **File:** `apps/backend/tests/tmux-commands-teardown.test.ts:458`
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU-tool PATH.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; the backend package used two isolated Bun workers. Component browser validation also ran.
- **Failure:** `await expect(cleanup).resolves.toBeUndefined()` at line 503 received a rejected promise instead of a resolved promise (234.65 ms). The captured assertion did not identify the rejection reason.
- **Suite counts:** backend reported 7,890 passed, 39 skipped and one failed across 433 files (319.44 seconds). Workspace finished with 12 successful tasks out of 13. The root group separately hit the known Pi runtime timeout (0178); bridges and protocol passed.
- **Isolated rerun:** `mise run test:logged -- --name merge-tmux-teardown-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/tmux-commands-teardown.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 2.2 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.j0YfiD/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** aggregate load may expose ordering or process-cleanup timing in the fake tmux runtime; the isolated pass establishes intermittency, not its cause. The owning test and implementation were unchanged by this merge. No assertion, timeout or skip was changed.
