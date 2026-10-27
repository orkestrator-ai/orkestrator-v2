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
