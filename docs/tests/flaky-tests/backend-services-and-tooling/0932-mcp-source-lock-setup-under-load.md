# MCP source-store lock setup races its fixed wait under aggregate load

- **ID:** 0932
- **Status:** open
- **Date observed:** 2026-10-25
- **Tests:** `McpSourceStore > takes over a lock left by a dead process but not one held by a live process`; `McpSourceStore > a live holder whose identity cannot be verified is never taken over on age`.
- **File:** `apps/backend/src/core/mcp-management/source-store.test.ts`.
- **Original command:** `mise run test:logged -- --name resume-repository -- mise run test`; standard workspace/root/bridge/protocol reservations 4/1/2/1, with other checkout suites on the same host.
- **Failures:** the first test's fixed 20 ms setup wait finished before the lock file appeared, so `lockFile.endsWith` threw on `undefined` (23.32 ms). The following case then observed `ENOENT` opening its lock instead of the expected busy error (307.20 ms).
- **Complete unchanged owner:** `mise run test:logged -- --name resume-mcp-source-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/mcp-management/source-store.test.ts --parallel=1 --only-failures` passed (exit 0, 0.8 s).
- **Evidence:** `orkestrator-test-run.gciHk4/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory; compressed from partial inner logs after the outer watchdog stopped the run. Outer run: `orkestrator-test-run.aqhArP/`.
- **Hypothesis:** the fixed delay does not establish lock acquisition under load. The early failure also bypasses `release()` and `await held`, so its still-running holder may cross test cleanup into the next case. The cascade is plausible but has not been reproduced under controlled scheduling. No MCP implementation, assertion, timeout or skip changed; aggregate failures remain reported.

- **Suite result:** the outer 30-minute watchdog stopped the aggregate after a 876.2 s workspace capacity wait. Backend had three failed cases and no final test counts; the aggregate is incomplete, with its observed assertion failures preserved.


## Queued-prompt keyboard review recurrence — 2026-10-28

Preparation at `91513d96d` ran `mise run test` alongside the nine-worker
component browser suite. The workspace reserved six slots (backend four Bun
workers); root, bridges and protocol reserved one, two and one. Both known
source-store cases failed: the missing `lockFile` at 22.57 ms and the next
case's `ENOENT` at 263.87 ms. Backend reported 10,153 passed, 87 skipped and
six failed; the aggregate failed after 332.2 s. Evidence: `.orkestrator/review-artifacts/review-validation-23a7a6f9-6912-45a3-b66d-327817cf8f1d/validation-04.stdout.txt`.

The complete unchanged source-store and fsmonitor owners passed sequentially
with one Bun worker (exit 0, 9.8 s):

```sh
mise run test:logged -- --name recorded-backend-owners -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/git-fsmonitor.test.ts ./src/core/mcp-management/source-store.test.ts --parallel=1 --only-failures
```

The passing logged runner discarded detailed output. No source-store code,
assertion, timeout or skip changed; the setup-delay hypothesis remains unproven.

The exact original aggregate command then passed (exit 0, 274.7 s):

```sh
mise run test:logged -- --name review-repair-tests -- mise run test
```

The successful rerun does not establish a flake fix; this case remains open.


## Transcript media snapshot review repair — 2026-10-29

Preparation at `63b8a00d7` repeated the two live-holder setup failures:
`lockFile` was undefined at line 191, then the next case got `ENOENT` instead
of `busy` at line 231. The complete unchanged owner passed alone (exit 0,
0.5 s):

```sh
mise run test:logged -- --name preparation-backend-owner -- bun test --cwd apps/backend ./src/core/mcp-management/source-store.test.ts --parallel=1 --only-failures
```

Preparation evidence is `validation-04.stdout.txt` under
`.orkestrator/review-artifacts/review-validation-d2902dab-3f13-48a3-aea0-29fb21e09960/`.
No source-store implementation, assertion, timeout or skip changed.

The exact failed aggregate command was rerun after the media fixes and passed
(exit 0, 156.7 s):

```sh
mise run test:logged -- --name review-repair-tests -- mise run test
```


## Failed-turn attention review repair — 2026-10-30

At implementation `90fc74138`, `mise run test:logged -- --name failed-turn-default-suite -- mise run test` finished with exit 1 in 1564.1 s, including approximately 1138 s queued for host capacity. Root, bridges and protocol passed; the workspace's only reported failures were the same two unchanged source-store cases: undefined `lockFile` at line 191 (55.19 ms), followed by `ENOENT` at line 231 (292.48 ms).

The complete unchanged owner passed alone (exit 0, 0.9 s):

```sh
mise run test:logged -- --name failed-turn-mcp-store-owner -- bun test --cwd apps/backend ./src/core/mcp-management/source-store.test.ts --parallel=1 --only-failures
```

Evidence: `orkestrator-test-run.oROs6h/failed-turn-default-suite.log.gz` and the inner `orkestrator-test-run.O6Rkzg/` directory beneath the host temporary directory. The full aggregate remains failed; an isolated owner pass is not a repair. No source-store implementation, assertion, timeout or skip changed.

## Machine-load review recurrence — 2026-10-31

`mise run test` on the coordinator machine-load branch, on a host at about 99%
CPU with a `dev:test` profile running, repeated both cases: the missing
`lockFile` at 23.92 ms and the next case's `ENOENT` at 348.59 ms. The complete
unchanged owner passed alone (15 pass, 0.97 s):

```sh
bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/mcp-management/source-store.test.ts --parallel=1 --only-failures
```

No source-store code, assertion, timeout or skip changed.

## Auto-merge main-merge validation recurrence — 2026-10-31

- **Original command:** `mise run test:logged -- --name merge-feature-tests -- mise run test` on `auto-merge-toggle-811626194e15-r1`, merging feature `b5590b25e` with main `1fac33ff6`. Workspace/root/bridges/protocol reserved 6/1/2/1 slots; the browser component suite ran concurrently.
- **Failures:** the missing `lockFile` at line 191 after 26.29 ms, followed by `ENOENT` instead of `busy` at line 231 after 266.92 ms. Backend reported 12,052 passed, 103 skipped and two failed. The default aggregate failed after 373.6 s; its desktop group also encountered a missing newly merged `@babel/core` dependency before the frozen install completed.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-source-store-owner -- bun test --cwd apps/backend ./src/core/mcp-management/source-store.test.ts --parallel=1 --only-failures` passed (exit 0, 1.1 s logged).
- **Evidence:** `orkestrator-test-run.oLFJHT/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.0oakL2/merge-feature-tests.log.gz` below the host temporary directory.
- **Assessment:** recurrence of the existing setup race; no source-store implementation, assertion, deadline or skip changed. The aggregate remains failed. After the frozen install, the complete desktop source-hint documentation test owner passed separately (exit 0, 1.3 s).


## Environment-kind terminology review repair — 2026-11-02

At `e4a98c7aa`, `mise run test:logged -- --name repair-default-suite -- mise run test` failed (exit 1, 1053.3 s including about 638 s queued for capacity). Workspace reserved six slots; root, bridges and protocol reserved one, two and one. Backend reported 13,338 passed, 99 skipped and three failed; web reported 11,409 passed, 10 skipped and zero failed. The third backend failure was the separate PreviewUpstreamPool idle-expiry assertion.

Both unchanged lock-store cases repeated: `takes over a lock left by a dead process but not one held by a live process` threw on undefined `lockFile.endsWith` at line 191 (22.55 ms), then `a live holder whose identity cannot be verified is never taken over on age` got ENOENT instead of busy at line 231 (315.83 ms).

The complete unchanged owner passed alone (exit 0, 0.6 s):

```sh
mise run test:logged -- --name mcp-source-store-isolated -- bun test --cwd apps/backend ./src/core/mcp-management/source-store.test.ts --parallel=1 --only-failures
```

Evidence: `output/agent-testing/env-kinds-review-fix/repair-default-suite.log.gz` in the terminology worktree; original inner artifact directory `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Ktt62a`. The setup-delay hypothesis remains unproven. No lock-store code, assertion, timeout or skip changed; the aggregate remains failed. A separately installed detached `origin/main` at `d7cdfaa8b` also passed the complete owner with `mise run test:logged -- --name baseline-mcp-source-store -- bun test --cwd apps/backend ./src/core/mcp-management/source-store.test.ts --parallel=1 --only-failures` (exit 0, 0.5 s). The two aggregate failures were not reproduced on the target branch and are not excused as environmental.

## Environment-kind terminology fix round — 2026-11-02

Further target-branch evidence for the recurrence above, on a detached `origin/main` at `d7cdfaa8b` (differs from the branch base `82598d869` only in `AGENTS.md`; `source-store.ts` and its test are identical on both):

- The complete owner, `--parallel=1`, eight runs back to back while 54 `yes` processes saturated the 18-core host: all passed. CPU saturation alone does not reproduce it.
- `ORKESTRATOR_BACKEND_TEST_WORKERS=4 mise run test:logged -- --name baseline-backend-workspace -- bun run --cwd apps/backend test:workspace`: 13,341 passed, 98 skipped, one failed (the unrelated PreviewUpstreamPool case, to-do 2920); both lock-store cases passed.
- `mise run test:logged -- --name baseline-default-suite -- mise run test` (188.8 s, no capacity queue): backend 13,340 passed, one failed (PreviewUpstreamPool again); web 11,407 passed; every other group passed. Both lock-store cases passed.

The branch's own preparation aggregate at `9940fb04a` (277.6 s) also failed only PreviewUpstreamPool. The lock-store cases have failed only in runs queued behind other worktrees' suites for host capacity (about 638 s on 2026-11-02), as in every earlier recurrence here. The failure has still not been reproduced on the target branch, so it stays open and unexcused. No lock-store code, assertion, timeout or skip changed. Evidence: `output/agent-testing/env-kinds-review-fix/baseline-backend-workspace-r2.log.gz` and `baseline-default-suite-r2.log.gz` in the terminology worktree.
