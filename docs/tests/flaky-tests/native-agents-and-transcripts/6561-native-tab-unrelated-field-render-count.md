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

## Recurrence — 2026-11-10

At review head `bfdc17ffa9635c914a038b2ea387c0fd86dfa9fe`, based on
`60c065c366e65ffc7d7cc1fb32e4c4517fc661ac`, the default aggregate again
reported one commit instead of zero (560.62 ms). The web package reported
14,337 pass, 10 skip and one fail. Command:
`mise run test:logged -- --name review-tests -- mise run test`.
Evidence: `/tmp/orkestrator-test-run.z2tD5X/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The complete unchanged owner passed with one worker using
`mise run test:logged -- --name review-native-tab-test-env -- env -u NODE_ENV bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.render-count.test.tsx --parallel=1 --only-failures`
(10.1 s; passing counts unavailable because the runner removed the log).
The recurrence checker against `origin/main` confirmed that the observing base
contains fix `ee2cc84234`. The token-aware mocks are already present, so this
observation does not establish the previous cause again.

An unchanged-code contention attempt also passed:
`mise run test:logged -- --name repro-native-tab-contention -- env -u NODE_ENV bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.render-count.test.tsx --parallel=1 --only-failures --rerun-each=10 --test-name-pattern 'an unrelated environment field'`
(20.5 s). Cause remains unproved; no assertion, deadline or production behavior
has been changed to hide the failure.

The broader unchanged-owner stress command
`mise run test:logged -- --name repro-native-owner-contention -- env -u NODE_ENV bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.render-count.test.tsx --parallel=1 --only-failures --rerun-each=5`
finished with 180 pass and five fail (151.3 s). This case's original test passed
all five runs. Each failure was instead `anchor resize does not render the native controller`
at line 903, expected zero commits, received one. React also reported unwrapped
updates and an act-environment warning. Evidence:
`/tmp/orkestrator-test-run.smRWs3/repro-native-owner-contention.log.gz`.
Those results do not reproduce or explain the original unrelated-field failure.

### `anchor resize` variant fixed — 2026-11-10

The `anchor resize does not render the native controller` failures recorded in
the recurrence above (one commit instead of zero) have a cause and a fix. This
case's own test, `an unrelated environment field does not render a tab
holding a transcript`, is not explained by it, so the status stays open.

- **Reproduced:** the unchanged `anchor resize` test failed alone every time
  (`env -u NODE_ENV bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.render-count.test.tsx --test-name-pattern 'anchor resize' --rerun-each=3`:
  0 pass, 3 fail). It passed in the whole file only because of the update
  history earlier tests left on the shell; one predecessor
  (`the startup session's progress does not render the tab until it fails`)
  was enough to make it pass. Under
  `bun scripts/test-under-contention.ts --burners 6` with that test and this
  case's test, it failed 3 of 5 reruns.
- **Root cause (product):** two renders of `NativeChatShell` on every pane
  resize.
  1. Its compose-dock `ResizeObserver` callback (`syncHeight`,
     `apps/web/src/components/chat/NativeChatShell.tsx`) called
     `setComposeDockHeight` with an updater that returned the current height.
     React drops such an update before rendering only when the fiber has no
     other pending work. Otherwise it renders the shell, bails out, and the
     `Profiler` above records a commit. Which path runs depends on the fiber's
     earlier updates, which explains the order and load dependence. With
     temporary tracing, the commit appeared only when this callback ran.
  2. `useChatColumnShiftStyle` read the column shift through
     `useContext(FloatingNoticeContext)`
     (`apps/web/src/components/ui/floating-notice.tsx`). That context's value
     changes on every anchor measurement, so the shell re-rendered on every
     resize even when its shift stayed 0. With temporary render counting,
     the shell rendered once per resize after fix 1 (the Profiler usually did
     not count it; one alone run in ten still failed) and 0 times after fix 2.
- **Fix:** `syncHeight` keeps the last committed height in a ref and queues no
  update when the height is unchanged. The floating-notice layer provides
  the column shift (`shiftRem`) and the stable claim callback through
  contexts of their own, so `useFloatingNoticeColumnShift` and
  `useClaimFloatingNoticeColumnShift` no longer subscribe to the layer's
  measurements. No assertion, timeout or test code changed.
- **Verification:**
  - `mise run test:logged -- --name n6561-anchor-alone-after2 -- env -u NODE_ENV bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.render-count.test.tsx --parallel=1 --test-name-pattern 'anchor resize' --rerun-each=20`
    passed (it failed alone on every run before).
  - The same test under `bun scripts/test-under-contention.ts --burners 6`,
    `--rerun-each=20`: 20 pass, 0 fail.
  - The recurrence's exact contention command, renamed
    `repro-native-owner-contention-after` (whole owner, `--rerun-each=5`,
    six burners), passed. It had failed 5 times before.
  - `floating-notice.test.tsx`, `chat-column-shift.test.tsx`,
    `CoordinatorActionsPanel.test.tsx`, `NativeChatShell.test.tsx` and this
    owner passed with `--parallel=2`; the web typecheck passed.
- **Still open:** the unrelated-field failure (one commit, 560.62 ms, at
  `bfdc17ffa`). No resize happens in that test. A same-value state update
  in a component that the environment write reaches is a candidate of the
  same kind as fix 1, but it is not identified.

## Effect adoption validation recurrence — 2026-11-10

Observing branch base: `04639b12b71d4326a3b8941485367aca197f4966`;
reviewed head: `c6b3ce9792c064bcac5e9eb7a287675fcbe73118`.
`mise run flaky:recurrence -- 6561` reported open (the previous fix is in history).
`mise run test:logged -- --name address-default -- mise run test` reported
one commit instead of zero at line 406 (640.60 ms). The web package had
14,351 pass, 10 skip and one fail, with two web test workers.
Evidence: `/tmp/orkestrator-test-run.pzC4lX/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The complete unchanged owner passed alone in 10.9 s:
`NODE_ENV=test mise run test:logged -- --name address-native-render-focused -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.render-count.test.tsx --parallel=1 --only-failures`.
Passing counts are unavailable because the logged runner deleted passing output.
This establishes intermittence, not cause or independence from this branch.
No assertion, timeout or native-tab implementation changed.

## Worktree-watcher review recurrence — 2026-11-10

Observed in `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=7200000 mise run test:logged -- --name coverage-full-final -- mise run test` at `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`, base `08d3da4a23cfe2ecc34fba663ca27e765f7924a9`, macOS arm64/Bun 1.4.4. The workspace reserved six slots (web two, backend four), root one, bridges two and protocol one. The aggregate exited 1 after 2468.77 s; backend has no final counts because the workspace no-progress watchdog fired. Root reported 4274 pass/25 skip/4 fail; web 14336 pass/10 skip/2 fail; Pi 706 pass/1 skip/2 fail.

- `apps/web/src/components/native-agent/AgentNativeTab.render-count.test.tsx` — `an unrelated environment field does not render a tab holding a transcript`: Expected 0 React commits; received 1 (lines 406/903). Observed 842.24ms. Complete unchanged owner: 37 pass, 0 fail, 0 skip in 5.30 s at `8948619686981e7b237f879192ac6ffc86b227c6`.

```sh
mise run test:logged -- --name watcher-triage-native-tab-render -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.render-count.test.tsx --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/native-tab-render.xml
```

The recurrence check against `origin/main` at `04639b12b71d4326a3b8941485367aca197f4966` reported this case already open; this branch still had its earlier resolved status. Reopen the local row and preserve the prior resolution as history. The current observation does not prove the old token-fixture cause has returned; the same owner also had a distinct anchor-resize count failure, recorded in case 9926.

Evidence: `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.dH765N/` (compressed group logs); JUnit under `/private/tmp/ork-watcher-failure-triage.0oarZv/`. [The complete report](../../../development/worktree-watcher-validation.md) contains the exact group outcomes, commands and non-green isolated owners. Passing alone establishes intermittence, not a cause or a fix. No related assertion, timeout, skip or implementation changed.
