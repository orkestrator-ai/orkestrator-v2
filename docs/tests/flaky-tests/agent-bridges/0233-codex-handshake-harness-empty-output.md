# Codex handshake failure harness exits without a result

- **ID:** 0233
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `app-server engine over HTTP > reports a bounded, actionable error when the handshake never completes`
- **File:** `bridges/codex-bridge/src/app-server-http.test.ts:161`
- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-latest-full-suite -- mise run test`.
- **Worker configuration:** workspace four slots, root one, bridges two (one Bun worker per bridge task), protocol check one. The component browser suite also ran on the host.
- **Failure:** `harness produced no output (exit 0)` with stderr `Failed to start the app-server engine: app-server is stopped`; test duration 1,151.07 ms.
- **Suite counts:** Codex did not finish its package suite. The bridge group stopped after ACP reported 499 passed, three skipped and one failed.
- **Isolated rerun:** `mise run test:logged -- --name merge-codex-http-isolated -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/app-server-http.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, wrapper duration 6.0 seconds.
- **Evidence:** `bridges.log.gz` in `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.uJ6Ien/`.
- **Hypothesis:** this may be a consequence of Turbo interrupting Codex after the sibling ACP failure, rather than an independent handshake regression. The empty-result failure appeared during that shutdown; the isolated rerun passed. No harness timeout or assertion was changed.
