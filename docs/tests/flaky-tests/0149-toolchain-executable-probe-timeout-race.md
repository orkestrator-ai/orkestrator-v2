# Toolchain executable-probe timeout race

- **ID:** 0149
- **Status:** resolved
- **Date observed:** 2026-09-19
- **Test:** `pinned desktop toolchain cache > reports executable probe spawn,
  nonzero-exit, and timeout failures`
  (`tests/unit/electron/toolchain-manager.test.ts:1117`)
- **Original command:** `mise run test`
- **Worker configuration:** root group under the host-capacity runner with up to
  four Bun workers while workspace and bridge groups also ran.
- **Failure:** the nonzero-exit fixture expected `version check failed (code 7`
  but received `claude version check timed out` after 5,009.16 ms.
- **Suite counts:** root group: 4,316 total, 4,307 passed, 2 skipped, 7 failed,
  4 between-tests errors.
- **Isolated rerun:** `mise run test:logged -- --name toolchain-manager -- bun
  test ./tests/unit/electron/toolchain-manager.test.ts --parallel=1
  --only-failures` → passed in 2.9 s.
- **Hypothesis:** under aggregate load, the executable that immediately exits 7
  was not observed before its five-second process deadline, so the timeout path
  won the race.
- **Root cause:** spawn-error and nonzero-exit cases used a five-second internal
  process timeout even though neither case is intended to exercise timeout
  behavior.
- **Fix:** give those two probes 15 seconds while retaining the explicit 10 ms
  timeout in the case that verifies timeout reporting.
- **Verification:** the changed root files, including this owner, passed together
  with one Bun worker in 58.2 s; `mise run test` then passed all four groups under
  the full eight-worker host budget in 142.3 s, and `mise run test:all`
  subsequently passed those groups plus iOS.
