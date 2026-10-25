# CLI `client-exit` fails around `environment start` at extreme host load

- **ID:** 0671
- **Status:** open
- **Date observed:** 2026-10-22
- **File:** `packages/cli/scenarios/cases.ts` (`setup-failure`, `client-exit`), driven by `packages/cli/scripts/run-scenarios.ts`.
- **Test:** `client-exit` (local only). Only this isolated-passing case is registered as a flake.
- **Related unconfirmed observation:** `setup-failure` failed again alone; the historical evidence below does not register it as a flake.
- **Original command:** `mise run test:cli:scenarios` on the `todo-0014-cli-qualification` branch (based on `b83ae534`), macOS (Darwin 25.6.0, arm64), Bun 1.4.3, with other worktrees busy on the same host.
- **Failure:**
  - `setup-failure`: `run wait` on the `environment launch` operation exited 4 `connection-failed` after 53 s (a read the backend did not answer in time), so the scenario failed with `undefined is not an object (evaluating 'receipt.state')`. `environment create` alone took 21.6 s in the same run.
  - `client-exit`: SIGINT 2.5 s into `environment start --wait ready` exited 130 `observation-interrupted` with no receipt printed, so the scenario failed with `no receipt was printed on interruption` (the start had not been answered yet).
- **Suite result:** 5 of 7 passed (`read-only`, `local-lifecycle`, `retry-and-retention`, `exec`, `wrong-profile`).
- **Owning-file rerun:** `--scenario setup-failure --scenario client-exit` at load average 204 rising to 404: `client-exit` passed (19.0 s); `setup-failure` failed again after 1051.9 s with `launch ended running, expected partial`.
- **Assessment:** load-dependent; the host load average was 150 to 400 during the reruns. The failing stages (`environment start`, `environment launch`, `run wait`) are not touched by the branch, whose changes are `environment.exec` launcher settlement, `session start/prompt --wait` recovery and Pi/Cursor/Grok scenario staging. `setup-failure` did not pass alone, so it is not yet a confirmed flake: rerun both on a quiet host. No implementation, assertion, timeout or skip changed.

## Control MCP voice main-merge validation — 2026-10-24

- **Merge parents:** `fc04c130d805d2c52b064d0d504eadc6188ac540` and `0014505caeed69395b3cc996dd541fcc6df12c23`.
- **Original command:** `mise run test:logged -- --name merge-cli-scenarios -- mise run test:cli:scenarios`; credential-free local scenarios, serial within the runner, alongside browser checks and other worktrees on this host.
- **Result:** six passed and only `client-exit` failed: `no receipt was printed on interruption` (56.3 s); the complete command exited 1 after 300.9 s.
- **Owner rerun:** `mise run test:logged -- --name merge-cli-client-exit-owner -- mise run test:cli:scenarios --scenario client-exit` reproduced the same failure (49.8 s; command 52.3 s, exit 1).
- **Evidence:** host temporary-directory artifacts `orkestrator-test-run.cVBpQf/merge-cli-scenarios.log.gz` and `orkestrator-test-run.XHtkYk/merge-cli-client-exit-owner.log.gz`; scenario manifests under `output/cli-scenarios/2026-10-24T14-03-57-486Z-7dba99da/` and `output/cli-scenarios/2026-10-24T14-09-37-426Z-e042ea62/`.
- **Assessment:** the host load average exceeded 100 during validation. This observation remains unresolved because the case failed alone too; it does not independently confirm a flake or its cause. No implementation, assertion, deadline or skip changed for this recurrence.


## Interaction review fixes validation — 2026-10-25

- **Revision:** `db35fb35f` plus the interaction review fixes on `todo-0001-agent-interactions-db4f03351da7`, macOS arm64, Bun 1.4.4.
- **Original command:** `mise run test:logged -- --name cli-scenarios -- mise run test:cli:scenarios`.
- **Result:** eight scenarios passed; `client-exit` failed with `no receipt was printed on interruption` (9.9 s). Its environment cleanup succeeded. The repository tests were running concurrently.
- **Owner rerun:** `mise run test:logged -- --name cli-client-exit -- mise run test:cli:scenarios --scenario client-exit` passed (12.8 s including preparation).
- **Evidence:** `output/cli-scenarios/2026-10-25T18-25-16-554Z-488fa2fd/manifest.json`; private failure log `orkestrator-test-run.C5xhRf/cli-scenarios.log.gz` in the host temporary directory.
- **Assessment:** confirmed recurrence of the intermittent interruption-receipt failure; no timeout, assertion, skip or implementation was changed to hide it.
