# Frontend-to-backend logic moves branch validation

- **ID:** 1641
- **Status:** open
- **Date observed:** 2026-11-01
- **Scope:** branch `frontend-backend-logic-1c26f349dffb-r1`, moving launch, handoff, config, file-save, layout and design-canvas logic from the renderer into the backend and protocol.
- **Original command:** `mise run test` (default suite, default worker counts), three runs on this branch while other work shared the host.

## Failures that passed when the owning file was rerun alone

| Run | Test | Owning file | Failure | Existing case | Isolated rerun |
| --- | --- | --- | --- | --- | --- |
| 1 | `a command node's deliverNow on this leaf > node coordinator requests stay pending while held, until injection` | `apps/backend/src/core/nodes/node-coordination.test.ts` | Mail row in an unexpected placement | 1526 | passed |
| 1 | `root-change approval handles over-limit and still permits rejection` | `apps/web/src/components/federation/node-action-requests.test.tsx` | Timed out, 7891.77 ms | 1312, 1313 | passed |
| 1 | `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts` | `tests/unit/disk-report.test.ts` | Timed out, 5033.76 ms | 0259 | passed |
| 1 | `NativeResumeSessionDialog > keeps archived history restorable after reopening with %s live rows` | `apps/web/src/components/chat/NativeResumeSessionDialog.test.tsx` | Timed out, 5508.93 ms and 6349.95 ms | 1602 | passed |
| 2 | `AgentNativeTab commands > typing after the sigil filters a maximal list without fetching, refreshing or scanning` | `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx` | Expected 1 projection read, received 2 | 0722 | passed, three times |
| 2 | `Codex sub-agent cards through the bridge and backend projection > each child keeps one card, its transcript and status across a fresh backend and a cold restart` | `apps/backend/tests/codex-subagent-cards.test.ts` | Turn phase `recovering`, expected `idle` | 0310 | passed |

The first run took 1673.5 s and the second 455.3 s. Host load was not measured for either. Nothing here proves the branch did not widen a timing window: the `AgentNativeTab` case in particular reads a count this branch's notice and resend work sits near, and it was not stress-tested.

## Failures that were real, and fixed on the branch

Not flakes; recorded so they are not mistaken for this case's list. In run 1, `version-drift`, the flake index test and `CreateEnvironmentDialog` pinned behaviour the branch moved. In run 2, two `web-annotation-rollout` `command gating` tests used a storage stub without the new patch method.

## Third aggregate run

`disk report`, `NativeResumeSessionDialog` and `root-change approval` failed again by timeout, at a host load average near 30. The last two passed alone straight after. `disk report` failed once alone at that load (5021.16 ms, case 0259) and had passed alone in 2.2 s earlier.

## Component browser suite

`mise run test:browser` hit its 1800000 ms group deadline at test 817 of 1140 with 45 failures, at the same load. Rerun in parts with `--workers=2` or `--workers=3` and `--timeout=120000`, these failed on the branch:

| Test | Owning file | Also failed on base `102930928` |
| --- | --- | --- |
| `selects a native branch suggestion with the keyboard and confirms` | `e2e/AgentLaunchDialog.spec.ts` | yes, one worker |
| `package validation and transcript fit a 1408px container` | `e2e/MultiReviewPackageLayout.spec.ts` | yes, one worker |
| `a live group crossing the fold threshold folds into its line` | `e2e/ToolGroupFold.spec.ts` | yes, one worker |
| `a live group growing below a released reader preserves their place` | `e2e/ToolGroupFold.spec.ts` | passed at one worker on both |
| `native: paging before prose in a byte-bounded view holds the original tool position` | `e2e/TranscriptPaging.spec.ts` | passed at one worker on both |

Base also failed `a waiting group that fits its cap follows appended calls` at one worker, which passed on the branch. The mobile project was not rerun in full, so its load-era failures outside the fixtures this branch changed are unconfirmed either way.
