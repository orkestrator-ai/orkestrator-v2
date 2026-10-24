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

## Separate deterministic failure on a BSD tool PATH (2026-10-15)

`docs/2026-10-14/05-real-stack-suite-host-dependencies.md` recorded a case in
this file failing on every run. That was not this timeout. Without the
testing guide's GNU-tool PATH, macOS `date` rejects the `date -d` that
`docker/firewall-domains.sh` uses for range stamps and expiry times. The
fixture now puts Homebrew's GNU tools first on its own PATH
(`tests/unit/gnu-shell-tools.ts`), and the date-dependent case skips with the
install command when they are absent. This open entry still tracks only the
aggregate-load timeouts.

## Canonical allowlist change — 2026-10-22

- **Original command:** `mise run test:logged -- --name changed -- mise run test:changed`, host load average about 69.
- **Failure:** twelve `firewall allowlist refresh and edits` cases exceeded five seconds (exit code `null` from the spawned script), including the new `a missing default list allows nothing beyond GitHub`.
- **Owning-file reruns:** passed alone at the default deadline before the aggregate run, and passed with `--timeout 30000` afterwards (shared run with 0192: 39 passed, 39.75 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.pQullD/root-and-agent-support-tests.log.gz`.
- **Assessment:** same load-bound deadline; no assertion, timeout or skip changed.

## Session lifecycle validation recurrence — 2026-10-23

- **Original command:** `mise run test:logged -- --name full-test -- mise run test` on `todo-0002-session-lifecycle-e3d0745d06fa` after merging `origin/main`, default worker plan, while no browser suite was running.
- **Failure:** `firewall allowlist refresh and edits > policy 3 refreshes the stored tuples and add/remove edit them` hit the five-second timeout (5003.39 ms). It was the only failure in the root group.
- **Owning-file rerun:** `mise run test:logged -- --name firewall-owner -- bun test ./tests/unit/firewall-refresh.test.ts --parallel=1 --only-failures` passed the complete unchanged file, exit 0 in 5.0 seconds.
- **Evidence:** `orkestrator-test-run.IoyN8C/full-test.log.gz` under the host temporary directory. No assertion, timeout or skip changed.

## Control MCP voice main merge — 2026-10-24

- The testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-full-tests -- mise run test` (one root worker) timed out `add and remove edit the stored list through the same swap` (5012.53 ms) and `adding to an empty stored list keeps the image defaults` (5006.92 ms). Root result: 3,368 passed, 15 failed across 162 files, 863.15 s execution.
- The same PATH with `mise run test:logged -- --name merge-0041-firewall-refresh-owner -- bun test ./tests/unit/firewall-refresh.test.ts --parallel=1 --only-failures` passed the complete unchanged owner in 33.6 s.
- Evidence: host temporary-directory `orkestrator-test-run.LK1I3Y/root-and-agent-support-tests.log`, retained from the interrupted aggregate. No implementation, assertion, deadline or skip changed.
