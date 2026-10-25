# Codex command catalogue armed-delay stale/ready race

- **ID:** 0800
- **Status:** open
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

## PR monitor shutdown validation recurrence — 2026-10-25

- **Original command:** `mise run test:logged -- --name residual-state-suite -- mise run test`, on `todo-0066-residual-module-state-40e8f98a7ef0`, Bun 1.4.4.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots; one isolated Bun worker per bridge package. Bridges waited 90.8 seconds for shared host capacity.
- **Failure:** line 293 expected `stale` but received `ready` (74.91 ms).
- **Package counts:** Codex reported 2355 passed, 40 skipped and two failed across 2397 tests in 88 files; the other failure was [0492](0492-codex-deleted-session-initial-retry-race.md).
- **Owning-file rerun:** `mise run test:logged -- --name codex-catalogue-owner -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 1.3 seconds.
- **Evidence:** `orkestrator-test-run.jMkwTI/bridges.log.gz` under the host temporary directory after aggregate completion.
- **Assessment:** recurrence of the existing stale/ready race; this change touches no bridge source or assertions.
