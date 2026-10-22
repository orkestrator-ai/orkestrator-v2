# CLI credential-free scenarios fail around `environment start` at extreme host load

- **ID:** 0671
- **Status:** open
- **Date observed:** 2026-10-22
- **File:** `packages/cli/scenarios/cases.ts` (`setup-failure`, `client-exit`), driven by `packages/cli/scripts/run-scenarios.ts`.
- **Test:** `setup-failure` and `client-exit` (local only).
- **Original command:** `mise run test:cli:scenarios` on the `todo-0014-cli-qualification` branch (based on `b83ae534`), macOS (Darwin 25.6.0, arm64), Bun 1.4.3, with other worktrees busy on the same host.
- **Failure:**
  - `setup-failure`: `run wait` on the `environment launch` operation exited 4 `connection-failed` after 53 s (a read the backend did not answer in time), so the scenario failed with `undefined is not an object (evaluating 'receipt.state')`. `environment create` alone took 21.6 s in the same run.
  - `client-exit`: SIGINT 2.5 s into `environment start --wait ready` exited 130 `observation-interrupted` with no receipt printed, so the scenario failed with `no receipt was printed on interruption` (the start had not been answered yet).
- **Suite result:** 5 of 7 passed (`read-only`, `local-lifecycle`, `retry-and-retention`, `exec`, `wrong-profile`).
- **Owning-file rerun:** `--scenario setup-failure --scenario client-exit` at load average 204 rising to 404: `client-exit` passed (19.0 s); `setup-failure` failed again after 1051.9 s with `launch ended running, expected partial`.
- **Assessment:** load-dependent; the host load average was 150 to 400 during the reruns. The failing stages (`environment start`, `environment launch`, `run wait`) are not touched by the branch, whose changes are `environment.exec` launcher settlement, `session start/prompt --wait` recovery and Pi/Cursor/Grok scenario staging. `setup-failure` did not pass alone, so it is not yet a confirmed flake: rerun both on a quiet host. No implementation, assertion, timeout or skip changed.
