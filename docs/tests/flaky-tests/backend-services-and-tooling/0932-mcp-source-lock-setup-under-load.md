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
