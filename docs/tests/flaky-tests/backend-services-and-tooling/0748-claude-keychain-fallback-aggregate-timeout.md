# Claude Keychain fallback exceeds the aggregate test deadline

- **ID:** 0748
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `host Claude credential resolution on macOS > falls back to disk when the Keychain lookup fails`.
- **Owning file:** `apps/backend/tests/claude-credential-injection.test.ts`.
- **Original command:** `mise run test:logged -- --name merge-suite-retry -- mise run test`, default four/one/two/one workspace/root/bridge/protocol admission plan, with two isolated backend workers.
- **Failure:** five-second generic test deadline at 5002.92 ms; one dangling process was killed. The test stubs `security` on PATH and expects the fixture's disk credential after the stub exits 1.
- **Suite counts:** backend 10,678 passed, 115 skipped and fifteen failed across 10,808 tests in 635 files (948.01 s execution). The other fourteen failures are the unchanged OpenCode version assertions recorded in aggregate case 0493.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-claude-credential-owner -- bun test --cwd apps/backend ./tests/claude-credential-injection.test.ts --parallel=1 --only-failures` passed (4.0 s logged).
- **Evidence:** host temporary artifacts `orkestrator-test-run.fljCCp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `orkestrator-test-run.Aly6dQ/merge-suite-retry.log.gz`.
- **Context:** merge parents `3b5f889149d8c3603c869cd15b51d67af39c9aa6` and `0014505caeed69395b3cc996dd541fcc6df12c23`; the owning file matches main.
- **Hypothesis:** subprocess scheduling under aggregate host load; no cause has been established. No assertion, timeout or skip changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** single observation. The case spawns a stub `security` and reads the disk fixture under Bun's default five-second budget. The owner passed alone today (32/32, 1.4 s; Bun 1.4.4).
- **Next step:** give the case an explicit budget if it recurs; if it does not recur by the next sweep, reclassify it as environmental.
