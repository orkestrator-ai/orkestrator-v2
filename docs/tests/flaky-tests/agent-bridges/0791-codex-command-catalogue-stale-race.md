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

## Triage 2026-10-25

- **Disposition:** open. This case now also covers [0800](0800-codex-command-catalogue-armed-delay-race.md) (duplicate) and the third sibling seen in [0810](../aggregate-validation-runs/0810-cli-command-surface-validation.md).
- **Rerun today:** the complete owner alone, three times (`mise exec -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/commands/codex-command-catalogue.test.ts --parallel=1`, Bun 1.4.4, load average 35 to 46): 30/30, 30/30, then this case failed (29/30, 51.53 ms). The fix d723429d5 (#1223, 2026-10-24) predates both 2026-10-25 failures, so it did not cure this.
- **Folded from 0800:** `an explicit refresh cannot replace the baseline for an already armed delay` (line 284) failed 2 of 8 solo runs on 2026-10-25 (72.51 ms and 115.88 ms, at lines 290 or 293), expected `stale`, received `ready`; Bun 1.4.2, no aggregate load.
- **Folded from 0810:** `its first answer is stale until a settling re-read confirms the plugin skills` (line 191) missed its own 2 s `waitFor` (2176.95 ms) in a loaded aggregate on 2026-10-25.
- **Likely cause:** `coldCatalogue` uses a real 20 ms `skillColdSettleMs` timer (line 187). Each case calls `commands.list()` after a `waitFor(state.calls.length === N)`. When the scheduler is slow, the next delayed read runs and settles before that `list()`, so it reports `ready`.
- **Next step:** drive the settle delay from an injected timer, or hold each fake `listSkills` answer until the test releases it, so the test decides when each delayed read lands.

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

## Interaction review fixes validation — 2026-10-25

The aggregate `mise run test` on `todo-0001-agent-interactions-db4f03351da7`
(`db35fb35f` plus the review fixes, Bun 1.4.4) repeated the first-answer
settling wait timeout at 2111 ms. The complete unchanged owner passed alone in
1.2 seconds:

```sh
mise run test:logged -- --name codex-catalogue-owner -- bun test --cwd bridges/codex-bridge --preload ../../tests/setup-node.ts ./src/commands/codex-command-catalogue.test.ts --parallel=1 --only-failures
```

Evidence: private `orkestrator-test-run.urvUKa/bridges.log` in the host temporary
directory (compressed on aggregate completion). No assertion, skip, deadline or
catalogue implementation was changed.

## Codex resume-context review validation — 2026-10-26

`mise run test:logged -- --name repository-tests -- mise run test` repeated
the two-pre-plugin-answer failure at line 273 (56.47 ms): expected `stale`,
received `ready`. The bridges group reserved two workers; the Codex package
used one Bun worker and reported 2381 pass, 43 skip, 1 fail across 90 files.
This change edits only the history reader and its regressions, not the catalogue.

The complete unchanged catalogue owner passed alone, exit 0 in 1.5 seconds:

```sh
mise run test:logged -- --name codex-catalogue-isolated -- bun test ./bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts --preload ./tests/setup-node.ts --parallel=1 --only-failures
```

Evidence: host temporary directory `orkestrator-test-run.unZQTH/bridges.log`
(compressed on aggregate completion); enclosing log
`orkestrator-test-run.2JILAH/repository-tests.log`. No catalogue assertion,
deadline or implementation changed; the original aggregate remains failed.
