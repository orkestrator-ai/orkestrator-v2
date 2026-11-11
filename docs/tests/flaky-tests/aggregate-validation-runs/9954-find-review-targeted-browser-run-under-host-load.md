# Find review repair: targeted browser run under shared-host load

- **ID:** 9954
- **Status:** open
- **Date observed:** 2026-11-11
- **Snapshot:** `bdc583ce4` on `document-find-bug-3a3f9ad04ef2-r1` (base `498b68766`), the review repair for to-do 5780.
- **Why this run:** the recorded `mise run test:browser` was incomplete (it timed out after 1,800 s with no output). A rerun on the default port 1422 refused to start because another checkout's fixture server held it. A rerun with `ORKESTRATOR_E2E_PORT=15941` reached 122 of 1,848 tests in 11 minutes while another checkout's full browser suite ran on the same host, so it was stopped and the specs that cover the changed paths were run instead.
- **Original command:**
  `ORKESTRATOR_E2E_PORT=15941 NODE_ENV= mise run test:logged -- --name browser-targeted -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/FirstFindLands.spec.ts e2e/StaticHtmlTranscript.spec.ts e2e/StaticHtmlArtifact.spec.ts e2e/TranscriptListRenders.spec.ts e2e/TranscriptPaging.spec.ts e2e/TranscriptHold.spec.ts e2e/VirtuosoFollow.spec.ts e2e/StreamingTranscript.spec.ts e2e/NativeFollowStability.spec.ts e2e/MailTiles.spec.ts`
- **Workers:** the default; load averages were about 30 to 36 from other work.
- **Result:** exit 1 after 8.5 minutes: 181 passed, 13 failed, 20 skipped. `FirstFindLands`, `StaticHtmlTranscript`, `TranscriptListRenders`, `TranscriptHold`, `VirtuosoFollow`, `StreamingTranscript` and `NativeFollowStability` passed on both projects.

## Failures and complete owning-file reruns

Each owner was rerun alone with
`ORKESTRATOR_E2E_PORT=15941 NODE_ENV= mise run test:logged -- --name browser-<Owner>-alone -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/<Owner>.spec.ts --workers=2`.

| Tests | Failure | Owner rerun alone |
| --- | --- | --- |
| Five mobile cases in `e2e/MailTiles.spec.ts` (all of its cases) | `page.goto: Test timeout of 30000ms exceeded`; the find case timed out waiting for `data-expanded` | Passed, exit 0, 24.5 s. |
| Four mobile cases in `e2e/StaticHtmlArtifact.spec.ts` (`fallback layout moves…`, `the real frame reports the document's text…`, `a reload replays…`, `over-budget documents…`) | `page.goto` or `page.reload` timeouts at 30 s | Passed, exit 0, 112.4 s. Recurrence of [6040](../design-canvas-and-artifacts/6040-static-html-specs-under-host-load.md). |
| Mobile `native: paging before prose in a byte-bounded view…` and `native: a same-minute page growing row zero…` in `e2e/TranscriptPaging.spec.ts` | Prepend index not advanced (`:138`) | Passed, exit 0, 143.4 s. Recurrence of [0483](../native-agents-and-transcripts/0483-transcript-paging-prepend-index-timing.md). |
| `native: history pages in without a click, opening with a page and paging near the top` in `e2e/TranscriptPaging.spec.ts`, both projects | Assertion at `:478` after a 30 s timeout | Same owner rerun passed. Recurrence of [1602](../native-agents-and-transcripts/1602-automatic-paging-reaches-first-row-timing.md). |

`mise run flaky:recurrence -- <case> --base 498b68766` reported 0483, 1602 and
6040 open. None of these tests opens a static document's Saved preview or
Source view or depends on the indexer's generation registration, which are the
only web paths this repair changed. Shared-host load is a hypothesis consistent
with the timeouts, not a confirmed cause. No assertion, timeout or skip was
changed.

## Not established

The full `mise run test:browser` (both configs, 1,848 tests) was not completed
on this snapshot, and the public-site config did not run.
