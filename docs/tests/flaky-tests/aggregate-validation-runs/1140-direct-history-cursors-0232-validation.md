# Direct history cursors (0232) validation

- **ID:** 1140
- **Status:** environmental
- **Date observed:** 2026-10-27, node mbp3
- **Scope:** todo 0232 branch (`todo-0232-direct-history-cursor-minting-cefd99084746`) on `main` at `863b57821`.

## Non-iOS repository suite

`mise run test` exited 1 after 877.9 s, at host load averages of about 40 to
50 (`uptime` right after: 50.27 47.37 39.73). Bridges and the Codex protocol
lockfile passed. Web 9945, protocol 1940, web-public 41, toolchain 91 and CLI
328 tests passed. Backend had 12050 passed, 120 skipped and 6 failed; desktop
1369 passed and 2 failed; root and agent-support 3522 passed and 6 failed.
None of the failing owners is touched by the branch, and every one also fails
alone on a clean `origin/main` worktree at `863b57821`.

| Owner | Failure | Complete owner rerun |
| --- | --- | --- |
| `apps/backend/tests/staged-input-relay.test.ts` | Four `staged input relay > …` cases (a mount node can or cannot read, a revoked provider's emptied mount, links never followed). | Deterministic: 5 passed, 4 failed alone on the branch and on `origin/main`. Not a flake. |
| `apps/backend/tests/docker-image.test.ts` | `pinned image identity > a restricted runtime on a gateway image joins its egress gateway with no capability` and `… a rootless daemon names the host address the reachability check chose`. | Deterministic: 19 passed, 2 failed alone on the branch and on `origin/main`. Not a flake. |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | The two `pruneProfiles` cases with an unexpected `keychainWarning`. | Deterministic, as recorded in [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md): 20 passed, 2 failed on both trees. |
| `tests/unit/migrate-copy.test.ts` | `verified copy helper > a missing listing completion times out as extract-failed` and `… a missing root completion …`: `extract.status` was `2`, not `0`. | Deterministic: 10 passed, 2 failed alone on the branch and on `origin/main`. Not a flake. |
| `tests/unit/firewall-policy.test.ts` | Four policy cases hit Bun's five-second budget (5001 to 5005 ms). | Alone: 0 to 2 cases failed in each of five branch runs and 2 to 4 in each of three `origin/main` runs, at the same deadline. The host-load condition of [0632](../environments-and-containers/0632-firewall-policy-probe-budget.md), [0192](../environments-and-containers/0192-firewall-bootstrap-shell-timeout.md) and [0983](../environments-and-containers/0983-firewall-root-entrypoint-shell-timeout.md); not classified as a new flake. |

Owner rerun commands, from the repository root:

```sh
(cd apps/backend && bun test ./tests/staged-input-relay.test.ts)
(cd apps/backend && bun test ./tests/docker-image.test.ts)
(cd apps/desktop && bun test ./scripts/dev/profile-cleanup.test.ts)
bun test ./tests/unit/migrate-copy.test.ts
bun test ./tests/unit/firewall-policy.test.ts
```

Aggregate artifacts below the host temporary directory:
`orkestrator-test-run.pK3Dnz/root-and-agent-support-tests.log.gz` and
`orkestrator-test-run.pK3Dnz/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

No test was disabled, no deadline was increased, and no Git hook was bypassed.


## Cursor-boundary review regressions — 2026-10-27

- **Change:** `ab318f68c` documents the error-only OpenCode suffix as an intended joined-paging fallback and adds regressions for split error rows, hydrated cursor closures, bounded prefixes and repeated first pages.
- **Focused validation:** 41 tests passed across the three changed history/snapshot owners. `mise run test:logged -- --name static-checks -- mise run check` passed format, lint and all typechecks; existing lint warnings remain.
- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`, with workspace/root/bridges/protocol reservations 4/1/2/1. Other worktrees were validating on the same host.
- **Root/support:** 3,518 passed, ten failed and one error across 3,528 tests in 170 files (423.34 s). Six firewall cases exceeded five seconds (5,003.60–5,046.67 ms); both copy-completion cases again observed extract status `2` instead of `0`; disk-report exceeded five seconds (5,059.41 ms, plus a between-test error); the OpenCode CLI-version deadline case observed another temporary-root list (123.02 ms).
- **Owning-file reruns:** each ran through `mise run test:logged`, with one isolated Bun worker and no changed assertion, deadline or skip:

| Label | Exact command after the logger's `--` | Result |
| --- | --- | --- |
| `isolated-0` | `bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` | 23 passed, 11 five-second failures (96.0 s); no new flake classification. |
| `isolated-1` | `bun test ./tests/unit/migrate-copy.test.ts --parallel=1 --only-failures` | 10 passed, the same two status mismatches failed (5.1 s); consistent with the base-tree evidence above. |
| `isolated-2` | `bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` | Seven passed, the same deadline failed and one between-test error (6.6 s); no new flake classification. |
| `isolated-3` | `bun test ./scripts/opencode-live-compatibility-probe.test.ts --parallel=1 --only-failures` | Complete owner passed (1.4 s); confirmed recurrence recorded in [0242](../agent-bridges/0242-opencode-probe-shared-temp-root.md). |
| `profile-owner` | `bun test --cwd apps/desktop ./scripts/dev/profile-cleanup.test.ts --parallel=1 --only-failures` | 20 passed, the same two unexpected `keychainWarning` results failed (3.7 s); consistent with the base-tree evidence above. |
| `cli-owner` | `bun test --cwd packages/cli ./tests/fix-command.test.ts --parallel=1 --only-failures` | Complete unchanged owner passed (9.1 s). Aggregate `live child suppresses parent SIGINT, receives termination signals, and releases listeners` timed out waiting for `ready` (5,016.61 ms, plus a between-test error). Credible timing flake; process startup contention is plausible but unproven. |

- **Evidence:** aggregate component logs under `orkestrator-test-run.wESThp` below the host temporary directory; owning-file failures retained in `orkestrator-test-run.yHfXe1`, `orkestrator-test-run.x8kse1`, `orkestrator-test-run.vQ297s`, and `orkestrator-test-run.r3Qbhh`. Passing owner logs were deleted by the logged runner.

- **Container reconciliation:** `restart reconciliation > a kill at any phase before the commit write leaves the original authoritative` timed out at 5,023.10 ms with `unreachable` instead of `settled`. `mise run test:logged -- --name container-owner -- bun test --cwd apps/backend ./tests/container-replacement.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (31.0 s). Recurrence recorded in [0244](../environments-and-containers/0244-container-replacement-reconciliation-timeout.md).

- **Change-tracking review owner:** `untracked inventory caps publish non-exact Git scope totals` exceeded five seconds (5,884.75 ms); `advancing provisional endpoints releases obsolete thread-latest pins for collection` then failed (177.25 ms), with late work reporting `Cannot use a closed database`. `mise run test:logged -- --name tracking-owner -- bun test --cwd apps/backend ./src/core/change-tracking/review-regressions.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (11.8 s). Credible timing flake; the log establishes late work after timeout/cleanup, without establishing why the initial budget was exhausted.
- **Container capture owner:** `container capture executor > V14: the container path captures the same manifest as the host path` and `container capture executor > the container restore helper checks and writes at the executor` exceeded five seconds (5,016.16 and 5,013.28 ms), followed by a between-test result of `failed` instead of `applied` for the restore helper. `mise run test:logged -- --name capture-owner -- bun test --cwd apps/backend ./src/core/change-tracking/capture-container.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (3.2 s). Credible timing flakes; host process contention is plausible but unproven.

- **Claude persisted-token startup owner:** both cases in [0775](../backend-services-and-tooling/0775-claude-bridge-persisted-token-aggregate.md) exceeded five seconds (5,004.99 and 5,003.48 ms); the late-arrival case rejected with `Container is not running`. `mise run test:logged -- --name servers-owner -- bun test --cwd apps/backend ./tests/commands-registry-servers.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (32.6 s). No startup implementation or fixture changed.

- **Docker registry owner:** the credential-error case and two container-list identity cases exceeded five seconds (5,004.57, 5,007.46 and 5,003.41 ms). `mise run test:logged -- --name docker-registry-owner -- bun test --cwd apps/backend ./tests/commands-registry-docker.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (12.7 s). Recurrence recorded in [0766](../environments-and-containers/0766-docker-registry-credential-error-aggregate-timeout.md).
- **Pinned-image owner:** the same two host-address assertions documented above failed in the aggregate (531.14 and 629.72 ms). `mise run test:logged -- --name image-owner -- bun test --cwd apps/backend ./tests/docker-image.test.ts --parallel=1 --only-failures` reproduced both failures (19 passed, two failed, 7.5 s; artifact `orkestrator-test-run.SpZEco`). This is consistent with the existing base-tree evidence, not a new flake.

- **Staged-input relay owner:** the same four cases documented above failed in the aggregate (28.60–157.35 ms). `mise run test:logged -- --name relay-owner -- bun test --cwd apps/backend ./tests/staged-input-relay.test.ts --parallel=1 --only-failures` reproduced all four failures (five passed, four failed, 0.4 s; artifact `orkestrator-test-run.QtZ5Pk`), consistent with the prior base-tree reproduction.

### Final review-validation totals

The aggregate exited 1 after 1,124.2 s. Backend reported 12,046 passed, 120
skipped, 16 failed and ten errors across 12,182 tests in 726 files
(1,042.65 s). Desktop reported 1,369 passed, 16 skipped and two failed; CLI
327 passed, one skipped, one failed and one between-test error. Root/support
reported 3,518 passed, ten failed and one error. All failing files were
untouched by `ab318f68c`; every owner was rerun separately as recorded above.

Web (9,945 passed), web-public (41), protocol (1,940), toolchain (91), bridges
and the Codex protocol lockfile passed. The focused 41 history tests, static
checks, flake-index test and final format check passed. Separate browser,
live-agent, Docker-scenario and iOS suites were not run because the change
adds regression tests and documentation without changing runtime behavior.

Final aggregate artifacts: `orkestrator-test-run.wESThp` (component logs and
summary) and `orkestrator-test-run.4OMI0D` (outer logged command), below the
host temporary directory. No unrelated implementation or test was modified
to suppress these failures.
