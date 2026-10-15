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
