# Codex command catalogue armed-delay stale/ready race

- **ID:** 0800
- **Status:** resolved
- **Observed:** 2026-10-25, `todo-0722-per-machine-accounts` branch validation
- **Test:** `a cold app-server child > an explicit refresh cannot replace the baseline for an already armed delay`
- **File:** `bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts:284`

Seen while checking [0791](0791-codex-command-catalogue-stale-race.md), the
sibling case in the same `describe`. The branch does not change any Codex
bridge code (`git diff origin/main --stat -- bridges/codex-bridge` is empty).

The unchanged owner, run alone on this Mac (Bun 1.4.2, no aggregate load):

```sh
cd bridges/codex-bridge
bun test src/commands/codex-command-catalogue.test.ts --preload ../../tests/setup-node.ts
```

Eight consecutive runs: 6 passed, 2 failed, both on this case (72.51 ms and
115.88 ms), at line 290 or 293: `expect((await commands.list()).status)`
expected `stale` but received `ready`. In three earlier solo runs the same
file failed once on this case and once on 0791's, and passed once.

Unlike 0791's first observation, this one fails without parallel workers, so
host load is not needed to reproduce it. The same hypothesis applies: a
background catalogue refresh settles between the test's polling condition and
the final `commands.list()`. Not established.

## Resume cleanup coverage validation — 2026-10-25

Original command: `mise run test:logged -- --name cleanup-repository -- mise run test`, with workspace/root/bridge/protocol worker reservations 4/1/2/1 and component browser validation running concurrently. Aggregate evidence is under the host temporary directory, `orkestrator-test-run.TabHxj/`.

Codex bridge reported 2,356 passed, 40 skipped and one failed across 88 files (56.79 s). `a cold app-server child > an explicit refresh cannot replace the baseline for an already armed delay` expected `stale` but received `ready` at line 293 (72.02 ms).

The complete unchanged owner passed: `mise run test:logged -- --name cleanup-codex-catalogue-rerun -- bun test ./bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures` (exit 0, 2.1 s). This confirms a recurrence; the cause remains unestablished. No bridge implementation, assertion, timeout or skip changed.

## Triage 2026-10-25

- **Disposition:** resolved as a duplicate of [0791](0791-codex-command-catalogue-stale-race.md). Same `describe`, same fixture, same real 20 ms settle timer and the same `stale`/`ready` symptom. Its facts are folded into 0791's triage section, which is the case to follow.

## 2026-10-25 composer model admission validation

Recurred in `review-tests` (`mise run test:logged -- --name review-tests --
mise run test`) on `todo-0004-composer-model-params-803868a90fcb` with Bun
1.4.4. Both cold-child catalogue cases expected `stale` but received `ready`;
no command catalogue implementation or tests changed in this work.

The complete unchanged owner passed alone (exit 0, 2.1 seconds):

```sh
mise run test:logged -- --name bridge-catalogue-recheck -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

Original aggregate evidence: `orkestrator-test-run.T3LqzB/bridges.log`
(compressed on aggregate completion). The original aggregate remains failed.
No skips, assertions or timeouts were changed.

## PR monitor shutdown validation recurrence — 2026-10-25

- **Original command:** `mise run test:logged -- --name residual-state-suite -- mise run test`, on `todo-0066-residual-module-state-40e8f98a7ef0`, Bun 1.4.4.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots; one isolated Bun worker per bridge package. Bridges waited 90.8 seconds for shared host capacity.
- **Failure:** line 293 expected `stale` but received `ready` (74.91 ms).
- **Package counts:** Codex reported 2355 passed, 40 skipped and two failed across 2397 tests in 88 files; the other failure was [0492](0492-codex-deleted-session-initial-retry-race.md).
- **Owning-file rerun:** `mise run test:logged -- --name codex-catalogue-owner -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 1.3 seconds.
- **Evidence:** `orkestrator-test-run.jMkwTI/bridges.log.gz` under the host temporary directory after aggregate completion.
- **Assessment:** recurrence of the existing stale/ready race; this change touches no bridge source or assertions.

## Second backend on one host (0244) — 2026-10-30

The aggregate repeated `expected "stale", received "ready"` (80.7 ms) under
load average 45 to 77; the complete unchanged owner passed alone. Details in
[1316](../aggregate-validation-runs/1316-second-backend-one-host-0244-validation.md).
