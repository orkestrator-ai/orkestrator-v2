# Configured askpass through a controlling terminal

- **ID:** 0200
- **Status:** resolved
- **Date observed:** 2026-10-12
- **Test/file:** apps/backend/src/core/shell.test.ts:357
- **Original command:** `mise run test:logged -- --name move-full-suite -- mise run test` with the testing guide GNU-tool PATH; standard 2/3/2/1 group slots. The isolated browser suite ran concurrently.
- **Failure:** `runCommand git environment > uses configured askpass in a Git SSH transport even with a controlling terminal` failed after 2235.34 ms.
- **Suite counts:** Root/support group: 4,997 passed, 24 skipped, 18 failed and 6 errors across 253 files; backend: 5,860 passed, 15 skipped, 2 failed. The compatibility writer regression and move fixture index contention were corrected separately.
- **Isolated rerun:** `mise run test:logged -- --name move-shell-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/shell.test.ts --parallel=1 --only-failures` → passed, exit 0, 5.5 seconds.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.DTErJR/` (compressed group logs).
- **Hypothesis / fix:** The aggregate deadline and unchanged isolated pass suggest subprocess timing sensitivity; the exact stalled operation is unproven.

## Recurrence during 0016 validation (2026-10-24)

- **Failure:** the same case failed in the aggregate at 2,385.76 ms.
- **Original command:** `mise run test:logged -- --name full-test -- mise run test`
  on branch `todo-0016-slash-command-catalogue` (0016 legacy catalogue
  retirement), node mbp3, while a `dev:test` profile and live browser runs
  shared the host.
- **Suite counts:** backend 10,530 passed, 115 skipped, 17 failed across 618
  files (672.7 s). 14 of the 17 are the deterministic OpenCode conformance
  version check (`conformance-execution-policy.test.ts` expects `1.19.0`, the
  pin and host binary are `1.19.4`; fails alone too, unchanged from `main`).
  Root, bridges and protocol groups passed.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.IY8RjI/full-test.log.gz`.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/shell.test.ts` from `apps/backend`: 31 passed, 0 failed.
- **Disposition:** recurrence confirmed by the isolated pass. No assertion,
  deadline or skip was changed.

### Resolution — 2026-11-06

- **Root cause:** a fixed two-second deadline inside the test's Python SSH
  transport. The helper runs `ssh-keygen -y` under a PTY and stops when the
  child exits (EIO) or prompts. It also gave up after `time.monotonic() + 2`,
  killing `ssh-keygen` first. Under aggregate load `ssh-keygen` sometimes had
  not reached `SSH_ASKPASS` within two seconds, so the helper killed it, the
  askpass marker file was never written, and the test failed at about 2.2 to
  2.4 s: the deadline plus key generation. Both recorded failures fall in
  that range.
- **Fix:** `apps/backend/src/core/shell.test.ts` raises the helper's bound to
  15 s, which matters only for a hang, because both normal outcomes end the
  loop at once. `runCommand`'s `timeoutMs` goes from 4 s to 20 s so that it
  stays above the helper's own deadline, and the test gets a 30 s budget.
  Every assertion is unchanged: askpass called, no "Enter passphrase", not
  timed out.
- **Reproduction:** with an `ssh-keygen` shim on PATH that sleeps 2.2 s
  before exec, the unchanged test failed with `ENOENT ... askpass-called`,
  the marker-missing outcome. The fixed test passes under the same shim
  (5.0 s).
- **Verification:** `mise run test:logged -- --name env-askpass-stress -- bun
  --cwd=apps/backend test ./src/core/shell.test.ts --parallel=2
  --rerun-each=8`: PASS in 71.1 s.
