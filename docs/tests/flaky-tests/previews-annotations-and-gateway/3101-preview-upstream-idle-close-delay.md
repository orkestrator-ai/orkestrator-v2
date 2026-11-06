# Preview upstream idle socket close is delayed in aggregate validation

- **ID:** 3101
- **Status:** resolved
- **Observed:** 2026-11-03
- **Test:** `PreviewUpstreamPool > idle connections expire, and one the application closes is never handed out`
- **File:** `apps/backend/src/preview-upstream-pool.test.ts`
- **Original command:** `mise run test`, at `ced9dbce70ca0cab52b304fb548b58e15af716c2`.
- **Workers:** four backend file workers; concurrent workspace, root and bridge groups.

The case failed after 713.05 ms at line 85: expected `client.destroyed=true`,
received false. Backend totals were 13,378 passed, 99 skipped, two failed;
root totals were 3,451 passed, two failed and one error.
Evidence: `.orkestrator/review-artifacts/review-validation-305987e4-d185-4d3f-bd05-a72e0c7df530/validation-04.stdout.txt`.

The complete unchanged owner passed alone, exit 0 in 0.1 s:

```sh
mise run test:logged -- --name preview-pool-rerun -- bun test --cwd apps/backend ./src/preview-upstream-pool.test.ts --parallel=1 --only-failures
```

Host contention delaying socket-close observation is a hypothesis, not an
established cause. No assertion, timeout, skip or unrelated implementation changed.

## Exact aggregate rerun and target-branch reproduction

The repair aggregate repeated the destroyed=false assertion at line 85 after
807.92 ms. Backend totals were 13,379 passed, 99 skipped, one failed; root and
protocol groups passed. A Codex runtime helper timeout was the other aggregate
failure. Evidence:
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.91L4AS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The owning implementation and tests have no diff in `origin/main...HEAD`.
A detached `origin/main` worktree at
`a1218b081d9fa328db99a4c83b4461d3f66336ec`, with its own independently installed
frozen dependencies, reproduced the same assertion in every repetition:
600 passed, 100 failed, 700 total in 67.22 s. The first failure took 649.62 ms
and identified the same idle-connection test and line 85.

```sh
mise run test:logged -- --name r4-main-preview-owner -- bun test --cwd apps/backend ./src/preview-upstream-pool.test.ts --parallel=1 --rerun-each=100 --only-failures
```

Evidence:
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.rxxQDQ/r4-main-preview-owner.log.gz`.
This establishes an existing target-branch failure independently of R4. It does
not establish the cause; the earlier host-contention hypothesis is unconfirmed.

The final aggregate repeated the same assertion after 689.70 ms. On fresh
main at `62e99ff599cfcfa2bfdd23f907b8f05039925d63`, an explicit setup-node preload
also reproduced it in all ten repetitions (60 passed, ten failed, 6.72 s):
`mise run test:logged -- --name r4-main-preview-preloaded -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-upstream-pool.test.ts --parallel=1 --rerun-each=10 --only-failures`.
Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.szuLqe/r4-main-preview-preloaded.log.gz`.

## R4 round 2 review preparation — 2026-11-03

At `3aa4546421145ebee86ecc8890e545a08825b9ef`, `mise run test` repeated the
same assertion after 837.95 ms, with four backend workers. Backend/root/web
reported totals were 28,256 passed, two failed and 109 skipped. The other failure
was the UI deadlines hook tracked in case 2711. Preparation evidence remains at
`.orkestrator/review-artifacts/review-validation-0e5ecfc3-eaa5-4f5a-910f-d4fcb012f586/validation-04.stdout.txt`.

The owning test and implementation still have no diff in `origin/main...HEAD`.
A new detached worktree at `origin/main` commit
`b58d401e1`, with its own `bun install --frozen-lockfile`, reproduced the exact
assertion at lines 85/199 after 736.04 ms (six passed, one failed, 770 ms total):

```sh
mise run test:logged -- --name r4-main-preview-round2 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-upstream-pool.test.ts --parallel=1 --only-failures
```

Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.dr1x7z/r4-main-preview-round2.log.gz`.
No unrelated code or test was changed; the temporary worktree was removed.

## R4 round 3 review repair — 2026-11-03

Preparation at `8d022cf9b` repeated the same assertion after 759.45 ms
(`mise run test`, four backend workers). Original evidence:
`.orkestrator/review-artifacts/review-validation-00bb3ca2-3d93-47b8-a736-2f3fd4bf7ab4/validation-04.stdout.txt`.
The owning implementation and test have no diff in `origin/main...HEAD`.

A detached `origin/main` worktree at `5161688cf`, with its own independently
installed frozen dependencies, reproduced the assertion at lines 85/199:
six passed, one failed, 730 ms total (673.57 ms in the failing case).

```sh
mise run test:logged -- --name r4-main-preview-round3 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-upstream-pool.test.ts --parallel=1 --only-failures
```

Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.PyIOGK/r4-main-preview-round3.log.gz`.
This confirms a target-branch failure, not a diagnostics regression. No
unrelated implementation, timeout, assertion or skip changed.

## Resolution — 2026-11-03

Root cause: a test bug, not host contention and not the pool. The case's
`socket()` helper resolved on the client's `connect` event and the test then
ended `accepted.at(-1)` to simulate the application closing the pooled
connection. On macOS under Bun 1.4.4 the client's `connect` usually fires
before the server's connection callback, so `accepted.at(-1)` was the peer of
the earlier `expiring` client, already closed. Ending it never reached the
pooled client, which the pool correctly kept idle for its 60 s limit, so
`closed(client)` saw `destroyed=false`. The "chatty" step had the same
wrong-peer lookup. This explains why it failed every time on detached `main`
and why the earlier "passed alone" observation was the exception.

Fix: 2920.
`socket()` now waits for the server-side socket whose `remotePort` equals the
client's `localPort` and returns `{ client, peer }`; the case ends and writes
to its own peer. No timeout, poll budget, assertion or skip changed, and the
pool implementation is untouched.

Verification on arktech-mini (macOS, loaded host), base `7b48c23fb`:

- Before the fix: `--rerun-each=5` failed five of five (30 passed, 5 failed),
  line 85 via 199.
- After: `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-upstream-pool.test.ts --rerun-each=100`
  passed 700 of 700, with and without `--parallel=1`.
- After: twenty separate processes of the same command (no rerun flag)
  through `test:logged`, 20 of 20 passed.
- After: `bun test --cwd=apps/backend ./src/preview-upstream-pool.test.ts --rerun-each=20`
  (the workspace's own invocation shape) passed.
