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
