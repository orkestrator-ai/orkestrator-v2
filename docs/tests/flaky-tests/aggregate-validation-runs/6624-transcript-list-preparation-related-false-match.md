# To-do 6280 preparation: five backend and desktop failures triaged related through a comment

- **ID:** 6624
- **Status:** open
- **Date observed:** 2026-11-06
- **Original command:** `mise run test` in review preparation, macOS arm64, Bun 1.4.4. It ended incomplete at the 1,800 s group deadline.
- **Commit:** `25ae4c6ea` (branch `transcript-list-rerender-a8a1359db14b-r1`). The branch changes files under `apps/web/`, `e2e/` and `docs/` only; nothing under `apps/backend/`, `apps/desktop/`, `packages/`, `bridges/` or `scripts/`.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-2b207542-6914-4692-aa0f-a2beba88334a/validation-04.stdout.txt` and the review package beside it (preserved, not committed).

## Failing tests

The triage marked all five `related` with the single reason `references-changed-path` (plus `known-flaky` for the first) and `changedPath: apps/web/src/components/chat/NativeChatShell.test.tsx`. None has `imports-changed-file` or `dependency-graph-incomplete`, so the classifier's own import walk reached no changed file. The match is the directory token `apps/web` against the doc comment in `packages/protocol/src/web-annotations.ts:348` ("for example `apps/web`;"), the false match described in [to-do 6601](../../../todo/coordinator-and-multi-review/6601-triage-related-from-a-directory-named-in-a-comment.md). `changedPath` names only the first changed file under that directory.

| Owner | Test | Original failure |
| --- | --- | --- |
| apps/backend/tests/claude-state-signal-integration.test.ts | `hook writers serialize counters and retain a completed turn without any config` (case [1102](../native-agents-and-transcripts/1102-claude-hook-concurrent-counter-snapshot.md)) | `working 7 0` instead of `working 20 0`, 1,168 ms |
| apps/backend/tests/commands-container-exec.test.ts | `GitHub credential helper > removes a token-bearing rewrite an older image or backend left behind` | child status `null` instead of 0, 5,109 ms (the pattern of case [6600](6600-live-head-preparation-owners-vary-with-load.md)) |
| apps/backend/tests/container-readiness.test.ts | `bounded in-container boot wait > renews an expired shell wait window and accepts readiness in the next exec` | `ContainerInitializationError` `timed-out`, 2,023 ms (also in case [6082](6082-x1-preparation-isolated-owners.md)) |
| apps/backend/tests/portable-inputs-stamps.test.ts | `what the home holds decides as much as what the stamp says > a damaged stamp falls back to the copy` | 60 s timeout, `entrypoint failed:` with empty stderr (case [5561](../environments-and-containers/5561-portable-input-stamps-spawn-latency-deadline.md)) |
| apps/desktop/tests/browser-preview-shadow-follow-ups.test.ts | `pins on hosts that attach their shadow root late > the :defined check is bounded for a host that never upgrades` | 2 timed checks instead of 4 within a 120 ms wait, 150 ms |

## Runs alone at `25ae4c6ea`

Each ran through `mise run test:logged` with `--parallel=1`, unless noted. Load is the one-minute average near the run; it stayed between 64 and 79 throughout.

| Owner | Result |
| --- | --- |
| commands-container-exec | pass, 19.8 s |
| container-readiness | pass, 14.4 s |
| browser-preview-shadow-follow-ups (desktop) | pass, 1.7 s |
| portable-inputs-stamps | three logged runs were stopped by the runner's 300 s no-output watchdog: a one-worker parallel run prints nothing until the file ends. A direct serial `bun test --preload ../../tests/setup-node.ts ./tests/portable-inputs-stamps.test.ts` from `apps/backend` passed 50 of 50 in 302.8 s, load about 75. Case 6600 recorded 171 s at load 17. |
| claude-state-signal-integration | fail twice: `working 4 0`, then `working 8 0`; 6 of 7 passed each time, load 75 to 79. Recorded as a recurrence in case 1102. |

## What this shows

- **Established:** no failing test can load changed code, and four of the five owners passed alone with no change. The fifth, the hook-writer case, also fails alone on this host at load above 70, as case 6600 saw at load 67. The hook script and its test are unchanged by this branch.
- **Not established:** the mechanism of any of the five. As in case 6600, load is a correlation.

## Fix

None here. No assertion, deadline or fixture changed: the tests belong to other areas, and a longer deadline on this branch would only hide the condition. The triage false match is to-do 6601.
