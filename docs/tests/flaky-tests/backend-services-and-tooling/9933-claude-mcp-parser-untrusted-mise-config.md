# Claude MCP parser probe runs a mise shim that cannot see its trust state

- **ID:** 9933
- **Status:** open
- **Date observed:** 2026-11-10
- **Test:** `Claude's installed parser accepts the generated agent MCP config`.
- **File:** `apps/backend/tests/tmux-session.test.ts` (line 194).
- **Observing branch:** `action-search-modal-1162dc5c0a2a-r1`, base `53340356c`, at `10fb2128f`. The branch changes only `apps/web` and `docs`.
- **Original command:** `mise run test:logged -- --name review-full-tests-rerun -- mise run test:full`, default worker plan, on a host also running the production app.
- **Failure:** `expect(received).toContain("Invalid MCP configuration")` received only mise's error instead of Claude's output: `mise ERROR error parsing config file: ~/.config/mise/config.toml` / `Config files in ~/.config/mise/config.toml are not trusted` (8.27 ms).
- **Suite result:** backend 21,852 passed, 1 failed of 22,160; web 14,560 passed, 0 failed; root, bridges, guards and protocol lockfile groups passed. The aggregate exited 1 after 1036.6 s.
- **Complete unchanged owner:** the aggregate runner's own one-off rerun of `apps/backend/tests/tmux-session.test.ts` passed alone (81 pass, 0 fail, 3.9 s).
- **Evidence:** `orkestrator-test-run.lYVxbh/` under the host temporary directory (`workspace-…log.gz`, `rerun-apps-backend-tests-tmux-session-test-ts.log.gz`).
- **Hypothesis:** the test spawns `claude` from `PATH` with `HOME` replaced by a fresh temporary directory. On a host where `claude` resolves to a mise shim, mise then reads the user's global config by its absolute path but looks for its trust records under the replaced `HOME`, so it refuses to run. Whether the owner passes therefore depends on which `claude` the process's `PATH` resolves first, not on load; why the solo rerun resolved differently was not established. Not reproduced under controlled conditions. No test, assertion, timeout or skip changed.

## Recurrence (2026-11-13)

- **Base:** `263eea27df362cf541cb9bde9adf7ec4fec1f5fd` (`mise run flaky:recurrence -- 9933`: open, record it).
- **Observed head:** branch `test-core-count-2ea1f7178998-r1` at `ee178dafc`; it does not change `apps/backend/tests/tmux-session.test.ts`.
- **Command:** Multi Review preparation's `mise run test:full`, default worker plan, exit 1 after 1369.4 s.
- **Failure:** the same mise refusal (`Config files in ~/.config/mise/config.toml are not trusted`) in place of Claude's output, at line 194 (26.52 ms).
- **Isolated rerun:** `mise run test:logged -- --name tmux-session-alone -- bun test --cwd apps/backend ./tests/tmux-session.test.ts --parallel=1` passed unchanged in 3.8 s.

