# Remote gateway: proxy buffer reservation release timed out under load

- **ID:** 9995
- **Status:** open
- **Date observed:** 2026-11-13

Test: `remote gateway > releases a proxy buffer reservation when the downstream disconnects while buffering`
in `apps/backend/tests/gateway-proxy.test.ts`.

The group's other rows for this file, 0037 and 0134 (both resolved), cover
different tests. This is a new case, not a counted recurrence.

## Observation

- **Branch:** `reviewer-failure-c64fd66ac37e-r1` at `b3807407a`, base
  `17d28238c` (`main`). The branch changes the structured review contract,
  Multi Review and Build Pipeline review handling and their UI, and nothing
  in the gateway or its proxy. The test reaches changed modules only because
  the gateway imports the backend app (about 1,800 modules).
- **Original command:**
  `mise run test:logged -- --name workspace-group -- bunx turbo run build test:workspace --cwd . --filter=@orkestrator/web --filter=@orkestrator/backend --filter=@orkestrator/desktop --filter=@orkestrator/web-public --filter=orkestrator --filter=@orkestrator/protocol --filter=@orkestrator/toolchain --concurrency=2`
  with `ORKESTRATOR_BACKEND_TEST_WORKERS=4`. This is the aggregate runner's
  workspace group, run directly because the aggregate itself hit its group
  deadline waiting for host capacity. Linux x86_64, load average about 100 on
  16 cores from other worktrees' runs.
- **Failure:** `this test timed out after 5000ms` (5,001.31 ms). The
  scenario subprocess printed nothing: `expect(stdout).toContain("RESERVATION_RELEASED")`
  received `""`.
- **Counts:** backend 18,164 passed and 3 failed (this case, open case
  [9962](../coordinator-and-multi-review/9962-node-reconnect-wake-mail-not-delivered.md)
  and the agent-mail benchmark below), beside the web package's run.
  Protocol 5,835, desktop 2,149, web-public 52, toolchain 135 and CLI 526
  passed with no failures. Evidence: `orkestrator-test-run.14v3Ja/workspace-group.log.gz`
  under the host temporary directory.

## Isolated rerun

- The owning file alone with one worker failed the same way once (50 pass,
  1 fail, 5,023.68 ms timeout; `orkestrator-test-run.6ppmE3`), still at load
  about 100.
- The test alone (`-t`) then passed three times (7.5 to 8.7 s per run), and
  the whole file passed twice (50 pass, 22.9 s and 25.6 s).

## Assessment

Hypothesis, unconfirmed: the scenario boots a gateway in a subprocess and
drives a buffered proxy request through a disconnect inside the test's
default 5 s budget. On a host at load 100, the subprocess start and gateway
boot alone may take most of that budget, so the test times out before the
scenario prints its result. No budget, assertion or retry was changed for
this record.

## Next evidence

If it recurs, record how long the scenario subprocess takes to reach its
first request. Reproduce it under `scripts/test-under-contention.ts` before
raising the budget. A budget is justified only if the time is boot cost the
test cannot await.

## Same run: unnumbered observations

The same run also failed these once. Each passed alone, and this pipeline
records them here rather than as cases of their own. Give one its own number
in its group if it recurs.

- `agent mail store size benchmark > rejects malformed, empty, missing and nonpositive sizes`
  (`apps/backend/tests/agent-mail-store-size-bench.test.ts`) timed out at
  5,008.28 ms. The file passed alone in the same rerun as the gateway file.
- `StaticHtmlArtifactView > document text in Find > a frame over the element limit and a read over the budget both withhold the document`
  and `... > a read failure is withheld too, and a successful Retry releases it`
  (`apps/web/src/components/chat/rich/StaticHtmlArtifactView.test.tsx:594`
  and `:606`) failed with `expect(received).toBe(expected)` (Expected `true`,
  Received `false`). The web package was then stopped (exit 130) when the
  backend task failed. The file passed alone (`bun test --cwd apps/web src/components/chat/rich/StaticHtmlArtifactView.test.tsx`).

### Web package run, same day

`mise run test:logged -- --name web-workspace-tests -- bun run --cwd apps/web test:workspace`
(the web package on its own, because the run above stopped it) reported
14,721 passed, 10 skipped and 3 failed across 1,015 files in 976.88 s,
still at load about 100 (`orkestrator-test-run.s0FIWp`). None of the owning
files is changed by the branch, and each passed alone with one worker:

- `the drawer's bottom bar and AppDialogHost open interactive settings and return focus to the drawer trigger, including cached reopening`
  (`apps/web/src/components/sidebar/SidebarBottomBar.environment-settings.test.tsx`,
  1,627.43 ms).
- `a stream that ends reconnects from its cursor`
  (`apps/web/src/lib/native/web-gateway-relayed-stream.test.ts`): Expected
  length 2, Received length 1 (31.04 ms).
- `CoordinatorPanel render cost > an unrelated environment, pipeline or Multi Review write renders no conversation`
  (`apps/web/src/components/projects/CoordinatorPanel.render-cost.test.tsx`):
  the initial `waitFor` in `renderPanel` (line 178) gave up at 2,051.80 ms,
  before the test wrote anything.
