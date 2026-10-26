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
| `tests/unit/flaky-tests-index.test.ts` | Case [0887](../environments-and-containers/0953-container-rebuild-dialog-after-reload.md) had no `- **ID:**` / `- **Status:**` lines. | A defect already on `main` (#1279), fixed here by adding them. |
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

## Review follow-up validation (2026-10-26)

`mise run test:logged -- --name aggregate -- mise run test` repeated a firewall
shell-fixture deadline in the root/support group (one worker):
`container firewall policy > the root entrypoint runs the firewall itself and records the outcome per mode`
failed at 5,003.30 ms, with `exitCode` null instead of zero. That group ran
3,472 tests: 3,471 passed and one failed. Workspace and bridge groups ran
concurrently using the repository's normal capacity reservations.

The complete unchanged owner passed alone in 34.4 s:

```sh
mise run test:logged -- --name firewall-alone -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures
```

This is further recurrence evidence for the existing shell-fixture budget
condition. The workspace run also observed the new stopped-snapshot aggregate
assertion before its final protection was in place; it passed in the focused
regression rerun after that fix. This implementation failure is not classified
as a flake. The original root/support group output is retained in `orkestrator-test-run.8rxhqH/root-and-agent-support-tests.log.gz`
under the host temporary directory. No assertion or timeout was changed.

The review follow-up Docker fixture run used the checkout's rebuilt
`orkestrator-v2:dev-328f789706d7` image and disposable `stop-races-qa` profile
with Codex and Grok enabled and no agent credentials. It passed 13 scenarios,
skipped three opt-in live scenarios, and failed only the known annotation
filename expectation from [0942](0942-service-preview-rollout-0042-validation.md):
`web-annotations-gateway.spec.ts:904` expects the unnormalized request ID,
while the backend materializes the bounded normalized name. An earlier run
omitted Codex from the profile and could not select that destination; correcting
the profile exposed the existing assertion mismatch. No product assertion was
changed for these results.

The util-linux setup-lock owner passed inside a network-disabled Linux
container on this Mac, including the new failed-orphan rerun case. The
credential-free Grok server/staging owners passed with exact `expires_at`
assertions for the isolated profile HOME and GROK_HOME renewal. A real Grok
turn remains unqualified because the host login is expired; synthetic staging
evidence does not claim authenticated provider qualification.

The final complete non-iOS rerun (`mise run test:logged -- --name aggregate-final -- mise run test`)
finished in 614.8 s. Workspace tests (including the new runtime-stop regressions),
all bridges and the Codex protocol lockfile passed. Only root/support remained
non-green: the same root-entrypoint firewall case timed out at 5,006.30 ms
(3,471 passed, one failed). Artifact:
`orkestrator-test-run.lQKOnZ/root-and-agent-support-tests.log.gz`.
The unchanged firewall owner had passed alone as recorded above; no further
retry or timeout change was used to present the aggregate as green.

Final focused backend owners, save-warning tests, format/lint/type checks,
flake-register validation and Linux setup-lock checks all passed. The
disposable Docker profile and its exact-owner resources were stopped/reset.
