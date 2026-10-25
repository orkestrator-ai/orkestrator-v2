# Configured askpass through a controlling terminal

- **ID:** 0200
- **Status:** open
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
