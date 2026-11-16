# Environment naming fixture times out in the aggregate

- **ID:** 0202
- **Status:** resolved
- **Date observed:** 2026-10-12
- **Test:** `Electron backend command registry > renames environments from prompts using codex exec output`
- **File:** `apps/backend/tests/commands-registry-environments-create.test.ts:934`
- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name move-committed-suite -- mise run test` on code commit `bc8200e0`.
- **Worker configuration:** standard workspace/root/bridges/protocol slots 2/3/2/1; no live dev profile.
- **Failure:** five-second timeout, reported at 5002.39 ms.
- **Suite counts:** root/support 5009 passed, 24 skipped, six failures and one error of 5039 tests across 253 files. Five other failures were in the unchanged firewall policy owner, which also failed alone. The workspace group stopped on a separate desktop runner timeout; bridges and protocol passed.
- **Isolated rerun:** `mise run test:logged -- --name move-environment-naming-isolated -- bun test ./apps/backend/tests/commands-registry-environments-create.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 64.0 seconds.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.0yj1Mb/root-and-agent-support-tests.log.gz`.
- **Hypothesis:** the fixture uses real subprocesses under a five-second outer deadline. The aggregate timeout and independent pass establish timing sensitivity but do not identify the stalled await. No assertion, timeout or skip was changed.

The older branch-rename shim failures in case 0130 cover different cases and remain resolved.

## Resolution (2026-11-15)

- **Root cause:** The naming case runs a fake `codex exec` subprocess; it exceeded Bun's 5 s default in the aggregate.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The owning file sets no smaller file, test or hook budget, and the failing test has no inner wall-clock deadline of its own.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-a -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 15 --burners 6 -- bun test --preload ../../tests/setup-node.ts <the twelve commands-* owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 736 passed, 2 failed, both `serves the Files panel from the scan the badge already ran`, which stays open in [9854](9854-electron-diff-statistics-aggregate-timeout.md); no other case failed.
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
