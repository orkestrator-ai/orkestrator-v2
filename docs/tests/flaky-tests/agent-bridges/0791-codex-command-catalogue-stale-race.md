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

## 2026-10-25

Failed again in the `todo-0722-per-machine-accounts` branch's
`mise run test` aggregate (the branch changes no bridge code), and once in
three solo runs of the unchanged owner
(`bun test src/commands/codex-command-catalogue.test.ts --preload
../../tests/setup-node.ts` from `bridges/codex-bridge`, Bun 1.4.2): it does
not need aggregate load. The sibling case at line 284 fails the same way;
see [0800](0800-codex-command-catalogue-armed-delay-race.md).

