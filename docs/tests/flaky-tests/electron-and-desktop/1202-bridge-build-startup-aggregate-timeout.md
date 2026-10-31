# Bridge build startup times out in aggregate validation

- **ID:** 1202
- **Status:** open
- **Observed:** 2026-10-27 during first-prompt transcript-confirmation validation.
- **Test:** `dev:test bridge builds > a successful start records bridges before launching the runtime and accepts backend readiness`
- **File:** `apps/desktop/scripts/dev/bridge-builds.test.ts`
- **Original command:** `mise run test:logged -- --name confirmation-repository -- mise run test`.
- **Workers:** aggregate budget of eight slots; workspace ran two package tasks with two Bun workers each, root one worker, bridges two workers, protocol one slot. Other worktrees were also validating; the host capacity queue reported 18/18 slots reserved.
- **Failure:** the test exhausted its 15,000 ms budget at 15,013.58 ms and Bun killed one dangling process. The desktop package reported 1,364 passed, 16 skipped and 13 failed; the other desktop failures concerned missing backend storage exports and known macOS profile-cleanup warnings.
- **Isolated rerun:** `mise run test:logged -- --name unrelated-bridge-builds-rerun -- bun test --cwd apps/desktop ./scripts/dev/bridge-builds.test.ts --parallel=1 --only-failures` passed unchanged in 1.2 s. The passing logged runner discarded its detailed output.
- **Evidence:** compressed aggregate workspace log at `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.co7PYh/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. The complete aggregate finished in 436.8 s with workspace, root and bridge failures; protocol regeneration passed.
- **Hypothesis:** fixture subprocess startup or shutdown was delayed under concurrent host load. The root cause is not established. No assertion, timeout, or skip was changed.


## Queued-prompt keyboard review recurrence — 2026-10-28

Preparation at `91513d96d` repeated the 15-second startup deadline
(15,021.68 ms), followed by an `EEXIST` between-test error in
`atomicWriteJson`. `mise run test` ran with default workspace/root/bridge/
protocol reservations of 6/1/2/1 alongside nine Playwright workers, failed
its workspace group and finished after 332.2 s. Other aggregate groups passed.
Evidence: `.orkestrator/review-artifacts/review-validation-23a7a6f9-6912-45a3-b66d-327817cf8f1d/validation-04.stdout.txt`.

The complete unchanged owner passed (exit 0, 0.9 s):

```sh
mise run test:logged -- --name recorded-desktop-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/bridge-builds.test.ts --parallel=1 --only-failures
```

The passing runner discarded detailed output. No bridge-build implementation,
assertion, deadline or skip changed. Concurrent startup contention remains a
hypothesis, not an established cause.

The exact original aggregate command then passed (exit 0, 274.7 s):

```sh
mise run test:logged -- --name review-repair-tests -- mise run test
```

The successful rerun does not establish a flake fix; this case remains open.


## Coordinator timers/account review — 2026-10-30

Preparation at `574bb14b3` repeated the successful-start deadline at
15,010.85 ms during `mise run test`. The complete unchanged owner passed
alone (exit 0, 1.0 s):

```sh
mise run test:logged -- --name recorded-desktop-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/bridge-builds.test.ts --parallel=1 --only-failures
```

Preparation evidence is in
`.orkestrator/review-artifacts/review-validation-af449b96-aec4-419e-90d3-165bd324e649/validation-05.stdout.txt`.
No desktop implementation, assertion, deadline or skip changed. The cause
remains unconfirmed.

The exact default-suite rerun subsequently passed (exit 0, 170.0 s):

```sh
mise run test:logged -- --name review-repaired-default -- mise run test
```


## Pipeline validation-history review, 2026-10-30

`mise run test:logged -- --name repaired-unit-suite -- mise run test` repeated
this unchanged owner failure. The startup case exhausted its 15-second budget (15005.18 ms); desktop totals were 1,363 passed, 16 skipped and one failed.
The complete unchanged owner then passed alone with exit 0 in 1.2 s:

```sh
mise run test:logged -- --name recorded-bridge-builds -- bun test --cwd apps/desktop ./scripts/dev/bridge-builds.test.ts --parallel=1 --only-failures
```

Aggregate evidence is `orkestrator-test-run.jn7K1f/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
below the host temporary directory. Passing output was removed by the runner.
No owner implementation, assertion, timeout or skip changed; the cause remains
unconfirmed.
