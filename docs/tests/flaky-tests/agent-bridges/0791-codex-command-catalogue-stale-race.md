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
