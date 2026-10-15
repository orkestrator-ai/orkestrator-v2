# ACP close state-file failure fixture races a writer

- **ID:** 0232
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `POST /session/:id/close > a failed state-file write answers pending and keeps the session registered`
- **File:** `bridges/acp-bridge/src/acp-session-close.test.ts:416`
- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-latest-full-suite -- mise run test`.
- **Worker configuration:** workspace four slots, root one, bridges two (one Bun worker per bridge task), protocol check one. The component browser suite also ran on the host.
- **Failure:** `EEXIST` creating the directory at `state/state.json` immediately after removing the state file; test duration 247.64 ms.
- **Suite counts:** ACP 503 total, 499 passed, three skipped, one failed. Turbo interrupted the still-running Codex bridge task after the ACP failure.
- **Isolated rerun:** `mise run test:logged -- --name merge-acp-close-isolated -- bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts ./src/acp-session-close.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, wrapper duration 5.4 seconds.
- **Evidence:** `bridges.log.gz` in `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.uJ6Ien/`.
- **Hypothesis:** an outstanding state write may recreate the file between the fixture's remove and mkdir operations. The observed EEXIST and passing isolated rerun support a timing-sensitive fixture, but do not establish the writer responsible. No production code or test assertion was changed.

## Recurrences on GitHub Actions `main` (2026-10-15)

- **Original command:** `mise run test` in the `Unit and integration tests` job
  of `lint.yml` on `ubuntu-latest` (four vCPUs); bridges group two slots, one
  Bun worker per bridge task.
- **Runs:** 38698449919 (`39fc12b2`) and 38748749506 (`9fb4e6a8`).
- **Failure:** the same `EEXIST` from `fs.mkdir(bridge.stateFile)` at line 416,
  in 231.86 ms and 239.14 ms.
- **Suite counts:** ACP 499 pass, 3 skip, 1 fail of 503 (run 38698449919) and
  503 pass, 3 skip, 1 fail of 507 (run 38748749506).
- **Isolated rerun (macOS arm64):** `mise run test:logged -- --name
  rerun-acp-session-close -- bun --cwd=bridges/acp-bridge test
  src/acp-session-close.test.ts --preload ../../tests/setup-node.ts
  --parallel=1 --only-failures` passed all 16 tests, wrapper duration 5.5 s.
- No test or production code was changed.
