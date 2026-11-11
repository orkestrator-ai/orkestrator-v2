# OpenCode host start: two concurrent environments

- **ID:** 1000
- **Status:** resolved
- **Date observed:** 2026-10-26
- **Test:** `local OpenCode server starts on one host > two environments starting together launch one server at a time`
- **File:** `apps/backend/src/core/opencode-host-start.test.ts` (removed with OpenCode 1.x on 2026-11-11; `git show 5f4e27b1c:apps/backend/src/core/opencode-host-start.test.ts`)
- **Original command:** `mise run test` on branch `todo-0109-rootless-linux-runtime-d03790b22a6c` (omarchy-hp, Linux, a host shared with other workers' suites; the workspace group waited for scheduler slots), backend `test:workspace` with two workers.
- **Failure:** an `expect().toEqual` diff of one line (Expected −1 / Received +1) after 803.99 ms. The bounded aggregate log kept no more of the diff.
- **Suite counts:** backend 11,765 pass, 2 fail (the other is 0785).
- **Isolated rerun:** `mise run test:logged -- --name a-opencode -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts src/core/opencode-host-start.test.ts --parallel=1` passed.
- **Hypothesis:** ordering of the two launches under host load; the branch changed nothing in OpenCode host start. Related: 0723 (same file, shutdown between lock attempts).

## Resolution (2026-11-11)

Retired, not fixed: test removed with OpenCode 1.x (2026-11-11). The owning
file was deleted with the 1.x host start. The root cause was never confirmed.
No surviving test runs this case.
