# Container qualification follow-ups (0061) validation

- **ID:** 0986
- **Status:** open
- **Date observed:** 2026-10-26, node mbp3 (macOS, arm64, Bun 1.4.4)
- **Scope:** todo 0061 branch (`todo-0061-container-qual-follow-ups-56ae439cf200`) on `main` at `93018933`, while six live Docker suites had just run on the same host (load average 11 to 36).

## First non-iOS repository suite

`mise run test` exited 1 after 734.3 s. Every failure was sorted by rerunning
its owning file alone.

| Owner | Failure | Outcome |
| --- | --- | --- |
| `tests/unit/ci-workflows.test.ts`, `tests/unit/components/GlobalSettings.test.tsx`, `tests/unit/test-diagnostic-bounds.test.ts`, `tests/unit/runtime-env-wiring.test.ts`, `apps/backend/tests/commands-registry-servers.test.ts`, `apps/backend/tests/commands-registry-environments-status.test.ts`, `apps/backend/tests/commands-process-coverage.test.ts`, `packages/cli/tests/scenario-provider-homes.test.ts` | Reproduced alone. | Real defects in the branch, fixed in it, not flakes: a cleanup unit test named like a live suite, a Settings warning without a `support` guard, a forbidden `queryBy… toBeNull`, source-text and mount tests pinned to the old Grok source, the Grok source reading `HOME` for every flavor, and a test that assumed OpenCode has no required host. All passed afterwards. |
| `tests/unit/flaky-tests-index.test.ts` | Case [0887](../environments-and-containers/0887-container-rebuild-dialog-after-reload.md) had no `- **ID:**` / `- **Status:**` lines. | A defect already on `main` (#1279), fixed here by adding them. |
| `tests/unit/firewall-policy.test.ts` | Six `container firewall policy` cases at Bun's 5 s budget. | Passed alone (34 passed). Known as [0632](../environments-and-containers/0632-firewall-policy-probe-budget.md) and [0192](../environments-and-containers/0192-firewall-bootstrap-shell-timeout.md). |
| `apps/backend/src/core/public-api/public-api-exec.test.ts` | `the worker survives a backend restart and its result is reconciled, not re-run` | Passed alone (22 passed). |
| `apps/backend/tests/container-replacement.test.ts` | `a kill at any phase before the commit write leaves the original authoritative` at 5 s. | Passed alone (23 passed). |
| `bridges/acp-bridge/src/acp-http.test.ts` | `the enhanced session catalogue still reads as the old command list`: `stale` instead of `ready`. | The second full run's bridges group passed (698 ACP tests). |

## Second non-iOS repository suite

After those fixes, `mise run test` exited 1 after 811.8 s. Bridges (cursor
796, codex 2411, pi 631, acp 698, claude 1646 tests) and the Codex protocol
lockfile passed; web 9841, backend 11888 and root/support 3472 tests ran.

| Owner | Failure | Outcome |
| --- | --- | --- |
| `apps/backend/tests/container-replacement.test.ts` | `settles when the daemon is lost by producer and helper at once`: `daemonUnavailable` false. | A racy assertion this branch had added (the helper's exit can kill the fake producer before it prints), removed; the owner then passed (23 passed). |
| `tests/unit/firewall-policy.test.ts` | Four cases at 5 s. | Alone: 36 passed, 4 failed in one run (with `disk-report.test.ts`), 34 passed in another, 33 passed and 1 failed in a third. The base commit `93018933` in a scratch worktree did the same under the same load: 34 passed, then 32 passed and 2 failed. Load, as in 0632 and 0192; not caused by the branch. |
| `tests/unit/disk-report.test.ts` | `reports an isolated checkout and only fixes named legacy Turbo artifacts` at 5 s. | Passed alone. Known as [0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md). |

## Third non-iOS repository suite

After the racy assertion was removed, `mise run test` exited 1 after 487.2 s
(load average about 13). Workspace (web, backend, desktop, web-public, cli,
protocol, toolchain), bridges and the Codex protocol lockfile passed; root
and agent-support ran 3472 tests with 3471 passed and one failure:
`container firewall policy > firewall uses stored domains and tolerates a
repeated GitHub bootstrap range` at 5,002.70 ms, case
[0192](../environments-and-containers/0192-firewall-bootstrap-shell-timeout.md).
Artifact: `orkestrator-test-run.GpF3r5/root-and-agent-support-tests.log.gz`.

Owner rerun commands, from the repository root:

```sh
mise run test:logged -- --name owners-0061 -- bun test ./tests/unit/firewall-policy.test.ts ./tests/unit/disk-report.test.ts --parallel=1 --only-failures
(cd apps/backend && bun test --preload ../../tests/setup-node.ts ./tests/container-replacement.test.ts)
```

Artifacts below the host temporary directory: `orkestrator-test-run.UPAvEu`
(first run), `orkestrator-test-run.hgtxE0` (second run) and
`orkestrator-test-run.1h1d3M` (owner rerun).

No test was skipped or loosened to pass, apart from the racy assertion above,
which this branch had itself added.
