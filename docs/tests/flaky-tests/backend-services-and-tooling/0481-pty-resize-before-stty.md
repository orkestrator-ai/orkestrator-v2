# Bun PTY resize not yet applied when the shell runs stty

- **ID:** 0481
- **Status:** resolved
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


## Mobile-title coverage review — 2026-10-27

The repository suite repeated `24 80` instead of `31 93` (46.53 ms). `mise run test:logged -- --name pty-owner -- bun test --cwd apps/backend ./src/core/pty.test.ts --parallel=1 --only-failures` passed the complete unchanged owner in 0.1 seconds. Aggregate counts, commands and evidence are in [1155](../aggregate-validation-runs/1155-webkit-title-tooltip-0202-validation.md#coverage-review-validation--2026-10-27). No PTY implementation, assertion, timeout or skip changed.

## Resolution (2026-11-15)

- **Root cause:** a race in the test. It wrote `stty size; …` straight after `terminal.resize(93, 31)`, and the resize reaches the pty asynchronously, so on a loaded host the shell could run `stty` first and print the spawn size `24 80`.
- **Fix:** `apps/backend/src/core/pty.test.ts` has the shell wait on its own terminal (`until [ "$(stty size)" = '31 93' ]; do sleep 0.02; done`) before printing the size and the ready marker. The resize is still proved by the output (`/^31 93\r?$/m`, which ignores the echoed command line); the 3 s exit race became a 50 s hang watchdog and the test's own 5 s third argument was removed (the default 60 s budget applies).
- **Reproduced:** no — the `24 80` answer was not re-created on demand.
- **Stress:** `mise run test:logged -- --name f2-cont-pty -- bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/pty.test.ts --rerun-each=3` passed.

## Recurrence (2026-11-16): the resolution's assertion rejected a prompt-prefixed line

- **Recurrence check:** `mise run flaky:recurrence -- 0481 --base c1fcc573bc079b4d856d53e31c45d5ebf2485d11 --registry-ref origin/main` said resolved, and the base contains its fix (6302f96c69), so this is a real recurrence. The case was reopened and is resolved again below in the same change.
- **Observed:** GitHub Actions CI, `Tests (backend)` shard (Linux x64, `mise run test:full` sharded), on runs 43785231111 (`release/v2.39.0-beta`), 43784353311 (`fix-flaky-tests-57033d2a4f0e-r1`) and 43785776990 (`prepare-upstream-issues-cbdb7609166a-r1`), all on bases containing 6302f96c69. Backend counts on 43785231111: 22,159 passed, 354 skipped, 1 failed.
- **Failure:** `expect(output).toMatch(/^31 93\r?$/m)` at `pty.test.ts:117` (7.45 ms). The output was the echoed command, then `$ 31 93`, then `__PTY_READY__`. The resize had arrived; the line simply began with the shell's prompt.

## Resolution (2026-11-16)

- **Root cause:** a race in the test's assertion, not the PTY. The command is written before `/bin/sh` prints its first prompt. When the terminal echoes the typed line before the prompt appears, the prompt (`$ `) is printed after the echo and `stty size` writes `31 93` on the same line as it. The 2026-11-15 resolution's anchored `/^31 93\r?$/m` accepted only the other ordering.
- **Fix:** `apps/backend/src/core/pty.test.ts` accepts an optional prompt before the size, `/^(?:[$#] )?31 93\r?$/m` (`#` for a root shell). The echoed command line still cannot match, because the size is not at its end, and a default `24 80` still fails.
- **Reproduced:** no. The prompt ordering depends on when the shell starts relative to the write and was not forced on demand. The new pattern was checked against the exact output CI received: it matches that output and the unprefixed form, and it does not match a `$ 24 80` answer.
- **Stress:** `mise run test:logged -- --name watcher-pty -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-watcher-large-ignored.test.ts ./src/core/pty.test.ts --rerun-each=20 --parallel=2 --only-failures` passed (macOS arm64; the prompt ordering seen on CI did not occur locally).
