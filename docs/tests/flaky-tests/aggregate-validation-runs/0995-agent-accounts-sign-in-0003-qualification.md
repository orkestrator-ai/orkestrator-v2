# Agent accounts and sign-in (0003) qualification validation

- **ID:** 0995
- **Status:** environmental
- **Date observed:** 2026-10-26, node mbp3
- **Scope:** todo 0003 branch (`todo-0003-agent-accounts-sign-in-7ea5f29c4c61`) on `main` at `93018933`, after the live qualification fixes.

## Non-iOS repository suite

`mise run test` exited 1 after 811.5 s, at host load averages of 20 to 40
(`uptime` during the reruns: 20.28 23.37 40.79). Bridges (codex 2414, cursor
796, claude 1646, pi 631 and acp 698 tests) and the Codex protocol lockfile
passed. Web 9833 passed, 10 skipped; backend 11729 passed, 135 skipped;
protocol 1881, web-public 41, toolchain 91 and CLI 324 tests passed. Desktop
had 1317 passed, 14 skipped and 4 failed; root and agent-support 3470 passed
and 2 failed.

| Owner | Failure | Complete owner rerun |
| --- | --- | --- |
| `apps/desktop/scripts/dev/isolated-browser.test.ts` | Three `isolated browser overrides an inherited live … opt-in` cases hit Bun's five-second budget (5002 to 5012 ms). | Passed alone (9.0 s). Recurrence of [0163](../electron-and-desktop/0163-desktop-isolated-browser-aggregate-timeout.md). |
| `apps/desktop/tests/backend-process.test.ts` | `Electron backend process supervisor > adopts and removes an owned Serve route after an ungraceful backend restart` failed a `toMatchObject` after 12,657 ms. | Passed alone (15.5 s). The branch does not touch the desktop backend supervisor. |
| `tests/unit/firewall-policy.test.ts` | `the root entrypoint runs the firewall itself and records the outcome per mode` timed out (5291 ms, `exitCode` `null`). | Failed alone too (32 passed, 2 failed at ~5,005 ms each): the host-load condition of [0632](../environments-and-containers/0632-firewall-policy-probe-budget.md) and [0192](../environments-and-containers/0192-firewall-bootstrap-shell-timeout.md), which `main` shares. Not classified as a new flake. |
| `tests/unit/flaky-tests-index.test.ts` | `environments-and-containers index lists every case file and stores a status for each row`: case 0887 had no `- **ID:**` / `- **Status:**` lines. | A deterministic defect already on `main` (from `c55807f96`); this branch gives 0887 the metadata lines and the owner passes (11 passed). |

Owner rerun commands, from the repository root:

```sh
mise run test:logged -- --name isolated-browser -- bun --cwd=apps/desktop test scripts/dev/isolated-browser.test.ts --parallel=1 --only-failures
mise run test:logged -- --name backend-process -- bun --cwd=apps/desktop test tests/backend-process.test.ts --parallel=1 --only-failures
bun test ./tests/unit/firewall-policy.test.ts
bun test ./tests/unit/flaky-tests-index.test.ts
```

Aggregate artifacts below the host temporary directory:
`orkestrator-test-run.6lQsB5/root-and-agent-support-tests.log.gz` and
`orkestrator-test-run.6lQsB5/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

No test was disabled, no deadline was increased, and no Git hook was bypassed.
