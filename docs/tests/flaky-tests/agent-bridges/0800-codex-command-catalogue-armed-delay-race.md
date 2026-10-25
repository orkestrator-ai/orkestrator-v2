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


## Resume cleanup coverage validation — 2026-10-25

Original command: `mise run test:logged -- --name cleanup-repository -- mise run test`, with workspace/root/bridge/protocol worker reservations 4/1/2/1 and component browser validation running concurrently. Aggregate evidence is under the host temporary directory, `orkestrator-test-run.TabHxj/`.

Codex bridge reported 2,356 passed, 40 skipped and one failed across 88 files (56.79 s). `a cold app-server child > an explicit refresh cannot replace the baseline for an already armed delay` expected `stale` but received `ready` at line 293 (72.02 ms).

The complete unchanged owner passed: `mise run test:logged -- --name cleanup-codex-catalogue-rerun -- bun test ./bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures` (exit 0, 2.1 s). This confirms a recurrence; the cause remains unestablished. No bridge implementation, assertion, timeout or skip changed.
