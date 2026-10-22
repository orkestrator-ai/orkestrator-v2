# Bun PTY resize not yet applied when the shell runs stty

- **ID:** 0481
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `Bun PTY adapter > supports terminal input and resize without crossing a native-addon fd boundary`
- **File:** `apps/backend/src/core/pty.test.ts:106`
- **Original command:** `mise run test:logged -- --name full-test-merged -- mise run test`
  on branch `qualify-transcript-paging-live-mr-c2fa28c0ecdd` after merging
  `origin/main` (the branch changes only web transcript views and an opt-in
  e2e spec, not the PTY adapter).
- **Worker configuration:** the workspace group concurrent with the root,
  bridges and codex-protocol groups on a shared macOS arm64 host running
  several other agents' test profiles.
- **Failure:** at 33.22 ms the output did not contain `31 93`: the shell
  answered `stty size` with the default `24 80`, then printed the ready marker
  and exited 0. The backend reported 9,041 passed, 41 skipped and this one
  failure; every other workspace package, root/support, bridges and protocol
  passed.
- **Isolated rerun:**
  `mise run test:logged -- --name pty-isolated-N -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/pty.test.ts --parallel=1 --only-failures`
  passed three times in a row, and a plain run of the file passed 8 of 8 in
  63 ms.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.hbryCf/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

## Current assessment

The test resizes the terminal and writes the command straight after spawn. A
size of `24 80` means the shell ran `stty` before the resize reached the
terminal, which a loaded host makes more likely. Waiting for the shell prompt,
or for the resize to be observable, before writing would remove the race. No
PTY implementation, assertion, timeout or skip changed.
