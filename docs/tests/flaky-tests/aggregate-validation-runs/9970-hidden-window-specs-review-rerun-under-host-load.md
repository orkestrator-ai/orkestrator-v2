# Hidden-window Electron specs review repair: default-suite rerun under host load

- **ID:** 9970
- **Status:** open
- **Date observed:** 2026-11-13
- **Snapshot:** `a9a66681e` on `electron-hidden-window-9b885cf8c702-r1` (base
  `17d28238c098b4443d1289df5c4ed75e7cc2802e`), the review repair for to-do
  2181. The branch changes two Electron Playwright specs
  (`e2e/agent-testing/hidden-dialogs-electron.spec.ts`,
  `e2e/agent-testing/window-visibility-polls-electron.spec.ts`), the Electron
  Playwright config and docs; no backend, protocol or unit-test code.
- **Why this run:** review preparation's `mise run test` was incomplete (its
  one failure was 1253, recorded there). The exact command was rerun.
- **Original command:**
  `mise run test:logged -- --name review-default-tests-rerun -- mise run test`
  (default concurrent groups).
- **Host:** shared with other worktrees' suites; load average about 33–38 just
  after the run. The groups took about twice as long as at preparation an hour
  earlier: backend 665.7 s (274.9 s then), web 526.3 s (251.5 s then).
- **Result:** exit 1. Guards, bridges and the Codex protocol lockfile passed;
  web 14,722 pass, 0 fail; backend 18,091 pass, 8 fail across 1,279 files;
  protocol 1 fail; root and agent-support 4,478 pass, 2 fail across 254 files.
  1253's git-fsmonitor case passed this time.

## Failures and complete owning-file reruns

Every failure was a test deadline (5 s for the backend cases, about 10 s for
the scans), and the runner reran each complete owner alone on the same
snapshot:

| Tests | Failure | Owner rerun alone |
| --- | --- | --- |
| Five `staged input relay (GNU) > an unchanged mount is not relayed again` cases and two `staged input relay (BSD)` cases in `apps/backend/tests/staged-input-relay.test.ts` | Timed out at 5,012–5,145 ms | Passed (26.9 s) |
| `cleanup drains lifecycle work before releasing tracking and diagnostics` in `apps/backend/src/core/public-api/test-support.test.ts` | Timed out at 5,018.57 ms | Passed (6.6 s). Recurrence of [1240](../backend-services-and-tooling/1240-public-api-harness-tracking-timeouts.md) |
| `the committed adapter list > holds every domain client definition in the repository` in `packages/protocol/src/contract/client-adapters.test.ts` | Timed out at 9,904.35 ms | Passed (1.7 s) |
| `change-tracking architecture boundaries > renderer code has no counting, diffing or provider-classification engine` in `tests/unit/change-tracking-boundaries.test.ts` | Timed out at 9,813.75 ms | Passed (1.2 s) |
| `MCP fixture cleanup contract > every test importing createFixture from MCP test-support awaits or returns cleanup` in `tests/unit/mcp-fixture-cleanup.test.ts` | Timed out at 12,214.20 ms | Passed (948 ms) |

The three scans read repository source, but none reads the changed specs'
subject: the adapter list reads protocol contract clients, the boundary scan
reads renderer code and the MCP scan reads tests importing MCP test-support.
The staged-input relay and the public-API harness do real file and Git work.
Shared-host load is a hypothesis consistent with every failure being a
deadline and every owner passing alone; it is not a confirmed cause. No
assertion, timeout or skip was changed.

Evidence: `orkestrator-test-run.EDRJ1a` and `orkestrator-test-run.HXGzuZ`
under the host temporary directory.
