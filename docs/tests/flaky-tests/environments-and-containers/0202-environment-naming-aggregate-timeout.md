# Environment naming fixture times out in the aggregate

- **ID:** 0202
- **Status:** open
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
