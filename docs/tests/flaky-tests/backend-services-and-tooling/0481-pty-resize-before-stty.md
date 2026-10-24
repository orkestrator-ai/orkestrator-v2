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

## Latest main compatibility refresh — 2026-10-24

- **Parents:** `37ecb753fa8da75ae546984af7c72ba5e166d503` and `a3111c7c67e3423b161b77156c070cd105c6a489`.
- **Original command:** `mise run test:logged -- --name main-refresh-suite -- mise run test`, default workspace/root/bridge/protocol worker reservations of four/one/two/one, alongside component and isolated-browser validation.
- **Failure:** the same resize test received the default `24 80` instead of `31 93` at line 106 (43.98 ms). Backend counts were 10,791 passed, 77 skipped and fifteen failed across 10,883 tests; the other fourteen failures were the recorded OpenCode version mismatches. Root/support, bridges, protocol and all other workspace packages passed. The aggregate retained exit 1 (581.6 s logged).
- **Complete unchanged owner:** `mise run test:logged -- --name main-refresh-pty-owner -- bun --cwd=apps/backend test ./src/core/pty.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed (0.1 s logged).
- **Evidence:** host temporary artifact `orkestrator-test-run.YR13Ws/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; passing owner summary `orkestrator-test-run.Iq5ovQ/summary.json`.
- **Assessment:** recurrence of the recorded resize-before-stty race; the complete unchanged owner passed. No implementation, assertion, timeout or skip changed during resolution.
