# Native tab render count after an unrelated environment update

- **ID:** 6561
- **Status:** open
- **Observed:** 2026-11-06 on macOS
- **Test:** `an unrelated environment field does not render a tab holding a transcript`
- **File:** `apps/web/src/components/native-agent/AgentNativeTab.render-count.test.tsx:365`
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`, at `a563467df`.
- **Workers:** the web package used two workers in the concurrent default aggregate. A five-worker component-browser run was also active during this round.
- **Failure:** expected zero commits after the unrelated field write, received two; 1872.79 ms.
- **Aggregate totals:** web package: 13,051 passed, 10 skipped, five failed and one error; 13,066 tests across 860 files in 874.91 s. The broader workspace group remained non-green.

The unchanged complete owner passed alone, exit 0, in 7.5 s:

```sh
mise run test:logged -- --name review-native-render-owner -- bun --cwd=apps/web test src/components/native-agent/AgentNativeTab.render-count.test.tsx --parallel=1 --only-failures
```

Passing output was deleted by the logged runner, so individual passing counts
were not retained. Aggregate evidence is
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.Mv0c3i/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The isolated pass establishes intermittence, not its cause. A late initial
render overlapping the measurement is a hypothesis; this run did not trace
the two commits. The branch changes the native tab controller, so this entry
does not establish that the failure is unrelated. No test, assertion, timeout
or implementation was changed to hide the failure.

### Resolution — 2026-11-06

- **Root cause:** the fixture's progressive-read mocks answered every read with a full `snapshot`, including the tab's background polls (every 500-1500 ms) that send the `knownToken` they already hold. Each identical snapshot committed the tab. A commit timeline of the first test showed two or three such poll commits within 3.6 s of mount, 0.7 s after `settle()` returned on a quiet host. When a loaded host stretched the initial render, `settle()` ended close to the next poll tick and its commits landed inside the "zero commits" measurement. The environment-store selectors were never involved.
- **Reproduced:** yes. Holding the tab for 3 s after `renderTab()` and before `writeUnrelatedFields()` failed the unchanged test with 3 commits instead of 0.
- **Fix:** `AgentNativeTab.render-count.test.tsx` now answers the transcript, session-state and discovery reads the way the backend does: `unchanged` when the read names the current token and does not force a snapshot, a snapshot otherwise. Tokens now include the tab's session key, and the state token includes the queued items, so a changed fixture still produces a new snapshot. No assertion, timeout or product code changed.
- **Verification:** with the 3 s and 7 s holds in place (temporary), the test passed with 0 commits. `mise run test:logged -- --name n6561-owner -- bun --cwd=apps/web test src/components/native-agent/AgentNativeTab.render-count.test.tsx --rerun-each=5` passed. `mise run test:logged -- --name n6561-stress -- bun --cwd=apps/web test src/components/native-agent/AgentNativeTab.render-count.test.tsx src/components/native-agent/AgentNativeTab.progressive.test.tsx --parallel=2 --rerun-each=4` passed 316 tests with 0 failures, at a host load average of about 20-30.

## Worktree-watcher review recurrence — 2026-11-10

Observed in `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=7200000 mise run test:logged -- --name coverage-full-final -- mise run test` at `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`, base `08d3da4a23cfe2ecc34fba663ca27e765f7924a9`, macOS arm64/Bun 1.4.4. The workspace reserved six slots (web two, backend four), root one, bridges two and protocol one. The aggregate exited 1 after 2468.77 s; backend has no final counts because the workspace no-progress watchdog fired. Root reported 4274 pass/25 skip/4 fail; web 14336 pass/10 skip/2 fail; Pi 706 pass/1 skip/2 fail.

- `apps/web/src/components/native-agent/AgentNativeTab.render-count.test.tsx` — `an unrelated environment field does not render a tab holding a transcript`: Expected 0 React commits; received 1 (lines 406/903). Observed 842.24ms. Complete unchanged owner: 37 pass, 0 fail, 0 skip in 5.30 s at `8948619686981e7b237f879192ac6ffc86b227c6`.

```sh
mise run test:logged -- --name watcher-triage-native-tab-render -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.render-count.test.tsx --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/native-tab-render.xml
```

The recurrence check against `origin/main` at `04639b12b71d4326a3b8941485367aca197f4966` reported this case already open; this branch still had its earlier resolved status. Reopen the local row and preserve the prior resolution as history. The current observation does not prove the old token-fixture cause has returned; the same owner also had a distinct anchor-resize count failure, recorded in case 9920.

Evidence: `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.dH765N/` (compressed group logs); JUnit under `/private/tmp/ork-watcher-failure-triage.0oarZv/`. [The complete report](../../../development/worktree-watcher-validation.md) contains the exact group outcomes, commands and non-green isolated owners. Passing alone establishes intermittence, not a cause or a fix. No related assertion, timeout, skip or implementation changed.
