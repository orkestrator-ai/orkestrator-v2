# `Electron tmux backend command registration` — three lifecycle tests (`tests/unit/electron/tmux-backend.test.ts`)

- **ID:** 0056
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Affected tests:** `serializes stop behind an in-flight start so no tmux session is orphaned` (2,010.43 ms), `keeps per-environment hook state under the shared runtime root and removes it on stop` (154.62 ms), and `environment teardown kills live sessions, restores settings and removes the runtime root` (1,469.94 ms).
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests-2.log`
- **Worker configuration:** the root and agent-support group ran `bun test ./tests ./e2e/agent-testing ./apps/desktop/electron ./apps/desktop/scripts/dev --parallel` while the workspace, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** all three failed as `error: timed out waiting for condition` from the file's own `waitFor` helper (`tmux-backend.test.ts:830`), reached through `withFakeTmuxRuntime`. The surrounding output also shows the fake runtime's `claude` shim missing during a probe: `ENOENT ... /T/ork-tmux-runtime-rXh3aJ/bin/claude`.
- **Suite counts:** root and agent-support group: 3 failed; the workspace, bridge, and protocol-lockfile groups all passed in the same run.
- **Isolated rerun:** `bun test tests/unit/electron/tmux-backend.test.ts` -> 173 passed, 0 failed.
- **Pre-existing:** unrelated to the OpenCode provider-filter change, which touches no tmux, PTY, or runtime-root code. These three did not fail in the immediately preceding full run of the same tree, which failed a different pair of tests instead; the group's failures move between runs.
- **Hypothesis:** the three failures share `withFakeTmuxRuntime`, which builds a temporary runtime root with executable shims and waits on real spawn/kill transitions. The `ENOENT` on the shim path suggests the fake runtime was torn down or not fully written while another test in the same worker was still probing it, so the awaited condition never became true. Whether the shared temp-root lifecycle is worker-safe should be established before any timeout is raised.
