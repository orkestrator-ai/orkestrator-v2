# Firewall refresh shell fixtures

- **ID:** 0199
- **Status:** open
- **Date observed:** 2026-10-12
- **Test/file:** tests/unit/firewall-refresh.test.ts
- **Original command:** `mise run test:logged -- --name move-full-suite -- mise run test` with the testing guide GNU-tool PATH; standard 2/3/2/1 group slots. The isolated browser suite ran concurrently.
- **Failure:** Five five-second timeouts in the aggregate; owner passed unchanged alone in 16.3 seconds.
- **Suite counts:** Root/support group: 4,997 passed, 24 skipped, 18 failed and 6 errors across 253 files; backend: 5,860 passed, 15 skipped, 2 failed. The compatibility writer regression and move fixture index contention were corrected separately.
- **Isolated rerun:** `mise run test:logged -- --name move-firewall-refresh-isolated -- bun test ./tests/unit/firewall-refresh.test.ts --parallel=1 --only-failures` with the same GNU-tool PATH → passed, exit 0, 16.3 seconds.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.DTErJR/` (compressed group logs).
- **Hypothesis / fix:** Concurrent shell subprocess pressure is plausible. The separate firewall-policy owner also failed in its isolated run and is not classified as a flake from this observation.
