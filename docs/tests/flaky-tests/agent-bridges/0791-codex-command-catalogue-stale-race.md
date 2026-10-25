# Codex command catalogue stale/ready race

- **ID:** 0791
- **Status:** open
- **Observed:** 2026-10-24, selected-machine settings validation
- **Test:** `a cold app-server child > two pre-plugin answers stay stale until late plugins are observed and confirmed`
- **File:** `bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts:273`

The unchanged bridge owner failed in `mise run test:logged -- --name
settings-repository-tests -- mise run test`. The aggregate reserved two workers
for bridges; Codex reported 2356 pass, 40 skip and 1 fail across 88 files
(54.31 seconds). The failing case took 99.29 ms and expected `grown.status` to
be `stale`, but received `ready`.

The complete unchanged owner then passed alone:

```sh
mise run test:logged -- --name settings-codex-catalogue-owner -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures
```

Exit status was 0, logged duration 1.3 seconds. No assertion, timeout, skip or
bridge implementation changed. The settings implementation does not edit bridge
code. A background catalogue refresh settling between the polling condition and
the final `commands.list()` is a hypothesis; the observed status difference does
not establish the cause.

Original evidence: host temporary directory
`orkestrator-test-run.GSCek7/bridges.log.gz`, with the outer run under `orkestrator-test-run.iCAyRT`.

## Annotation qualification validation, 2026-10-25

The unchanged owner failed again during `annotation-suite` (`mise run test`),
this time in `a cold app-server child > its first answer is stale until a
settling re-read confirms the plugin skills`. Its exact-call-count settling
wait at line 212 timed out after 2,067.66 ms. Codex reported 2356 pass, 40 skip
and 1 fail across 88 files (72.69 seconds). The shared host capacity queue was
also delaying this run's workspace group; that does not establish the cause of
the test failure.

The entire owner passed alone, with no source or timeout changes:

```sh
mise run test:logged -- --name annotation-codex-catalogue-check -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures
```

Exit status was 0; logged duration was 1.3 seconds. The annotation fixes do not
change any bridge implementation. Aggregate evidence is in the host temporary
directory `orkestrator-test-run.N5VXK9/bridges.log.gz`; the enclosing log is
`orkestrator-test-run.gSVRr6/annotation-suite.log.gz`.

## Per-machine accounts validation, 2026-10-25

Failed again in the `todo-0722-per-machine-accounts` branch's
`mise run test` aggregate (the branch changes no bridge code), and once in
three solo runs of the unchanged owner
(`bun test src/commands/codex-command-catalogue.test.ts --preload
../../tests/setup-node.ts` from `bridges/codex-bridge`, Bun 1.4.2): it does
not need aggregate load. The sibling case at line 284 fails the same way;
see [0800](0800-codex-command-catalogue-armed-delay-race.md).

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

## Leaf-node Control MCP parity validation, 2026-10-25

`mise run test:logged -- --name full-test -- mise run test` at `e8fa18152` plus
the leaf-node parity changes (no bridge code changed) failed `a cold app-server
child > two pre-plugin answers stay stale until late plugins are observed and
confirmed` at line 273: expected `stale`, received `ready` (43.47 ms). Codex
reported 2360 pass, 40 skip and 1 fail across 88 files (29.82 s). The complete
unchanged owner then passed alone (30 of 30) with
`bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --parallel=1`.
Evidence: `orkestrator-test-run.A7erFE/bridges.log.gz`. The original aggregate
remains failed; nothing was changed.
