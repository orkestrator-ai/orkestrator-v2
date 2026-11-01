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

## Fourth aggregate run

At commit `c49c053e3`, load average about 8, the only failure was `each child keeps one card, its transcript and status across a fresh backend and a cold restart` (case 0310). The owning file then passed eight times in a row alone and six out of six run concurrently. That does not explain why it failed in two of four aggregate runs, so whether this branch changed its rate is unproven.

## Review repairs on 2026-11-01

Commit `e491ab280` repairs the retained-intent byte bound and oversized-queue
recovery, compensates feature-plan claim failures, preserves capacity-skipped
legacy drafts, backfills historical review counts from older backends, moves
container directory creation after the digest check, makes goal-check listing
best effort during stop, checks container ownership before draining workers,
and refreshes the raw settings baseline after saves.

Targeted regressions passed for the changed backend and web owners, including
ten 250 KiB HTML replacements and restart/list/resume/run/discard recovery;
claim rejection before and after persistence followed by a retry; partial
legacy imports, unresolved tokens and writes during import; concurrent resend
scans and a newer dispatch during probing; container handler conflict mapping;
and empty, invalid or unavailable goal-check output. The lifecycle owners
(`commands-registry-environments-status`, `commands-registry-environments-lifecycle`,
`container-replacement`, and `public-api/exec-control`) passed together in 19.3 s.

Changed-file formatting and lint checks passed. Backend, web and agent-E2E
project typechecks passed. The complete `e2e/GlobalSettings.spec.ts` owner
passed all eight mobile/desktop cases in 80.8 s, including save 24 hours,
remount, reset to default, unset payload and storage removal. Its preceding
unchanged run passed seven and failed the mobile Session titles mount assertion;
case [1642](../web-ui/1642-session-title-setting-browser-mount.md) retains that evidence.

The credential-free `backend-owned-state.spec.ts` passed through a real
isolated backend in 26.7 s, with the profile stopped and reset. It covers
settings merge/unset, persisted layout rehydration, immutable handoff retry
from a historical transfer, and refusal of a missing source session. It does
not send a live model turn or qualify first-prompt handoff delivery. The test
is included in `test:agent:browser:isolated`; the focused run used
`runIsolatedBrowser` with a one-spec suite override.

The first broad reruns overlapped edits. In particular, the first full run
observed new legacy-draft assertions with behavior matching the earlier cleanup
implementation; that mixed-source run is not evidence for the committed version
and is not classified as a flake. A second exact `mise run test:full` was queued
after the commit. The component browser rerun was restarted with two granted
workers after the six-worker attempt timed out on unrelated fixtures. The
isolated browser runner's ambiguous Close selector was corrected, its profile
was stopped/reset, and the exact isolated command was restarted.

The broad run also found an outdated command-string assertion in
`commands-io-coverage.test.ts`: unconditional container writes now create their
parent inside the write script. The assertion was updated to the combined
script and its complete owner passed in 7.9 s; formatting and lint passed.

The exact isolated browser rerun reached case 30 of 134 and hit its 900 s suite
deadline (934.0 s including startup/cleanup). It recorded seven failures in
account-picker interaction, host pickers, capped file-tree visibility, agent
mail, host maintenance and CLI UI visibility. The runner stopped and reset
`qa-browser-fb89c904-8ba`; its runtime directory was confirmed absent. Evidence:
`/tmp/orkestrator-test-run.FlgawK/review-agent-browser-rerun.log.gz`. This full
run remains incomplete; the new focused backend-state regression passed
separately after extraction into its own spec.
