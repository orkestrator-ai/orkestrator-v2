# Held place drifts 124 px after Load earlier messages

Checked against `main` at `71227437` and again at `a5d78cfc`, after the
#1212 scroll rework (2026-10-24). Resolved on 2026-10-25 against `main` at
`ba7cc8d4` (branch `todo-0090-held-place-drift`): every item below is done.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

The file is Finished: every code, qualification and open-question item is done, and the branch has merged.

1. **Find and fix the 124 px**: a clamp, fixed by a clamp-aware live check. Status: done.
2. **Rerun the live native cases**: Claude and tool-only Codex passed, including after a reload. Status: done.
3. **What to do with the file**: decision 5 deferred deletion to review, which has happened. Status: open (the only decision left).

### 3. What to do with the file

**Problem.** Decision 5 kept the file "until this branch is reviewed". The branch merged as #1243 (`66661858`), and `ba7cc8d4` is an ancestor of HEAD, but the file and its index row are still here.

**Context.** The README says that once the last item is done, the durable behaviour moves out and the file is deleted. The file names its durable homes: `transcript-scroll.md` (Semantic anchors and history) and `agent-testing.md` (Live transcript paging).

**Investigation.** The durable notes exist. `docs/architecture/transcript-scroll.md:81` ("Clamped boundaries are a legitimate outcome") and `:142` describe the controller ending `clamped` when nothing can hold the place. `docs/development/agent-testing.md:628` defines "keep" as standing within 8 px of the reachable position. The code is in place: `holdPosition` (`e2e/transcript-hold.ts:11`), `e2e/TranscriptHold.spec.ts`, and the fixture's `paged`, `stops` and `prompt` options (`e2e/fixture/TranscriptPagingFixture.tsx:22`-`:27`). Inbound links that a deletion must update: `0050-transcript-history-efficiency.md:305` and `:570`. Flake case 0483 cites the branch by name, but not this file, so it needs no edit. Not carried over: the mechanism narrative (folding made a tool-only transcript shorter than its viewport) and the rejected options (padding, bottom alignment, a looser limit), which explain why the spec is clamp-aware rather than the product.

**Decisions.**

- **Delete the file now, or keep it?**
  - **Delete it now, adding a short note to transcript-scroll.md's Tool groups section saying that folding can make a transcript shorter than its viewport and why the product is not padded (recommended).** Update 0050's two links and remove index row 11 in the same change.
    - Pros: meets decision 5's own condition (review is done); keeps the one rationale a future reader would otherwise lose.
    - Cons: a small doc edit outside `todo/`; the 2026-10-24 evidence tables go.
  - **Delete it now with no further doc edits.**
    - Pros: the smallest change; the durable notes already cover the behaviour.
    - Cons: the "why not pad or bottom-align" reasoning disappears, inviting the same investigation again.
  - **Keep it.**
    - Pros: no edits.
    - Cons: goes against the README rule and decision 5; a Finished row stays in the ranked index.

"Load earlier messages" must keep the reader's row where it was: the row
first on screen before the click stays at the same offset after older rows
land above it. The live paging spec allows 8 px. On 2026-10-24 both native
cases of `e2e/agent-testing/transcript-paging-live.spec.ts` missed that by
124 px on their first click, Claude Haiku and tool-only Codex alike. Both runs
passed every backend check before that point. The held-place fixes in #1094
were last proved live on 2026-10-18. Tool-run folding (#1108) landed after
them and changes what the first rendered tool row is, so it was the leading
suspect. The live spec had not been run since #1108 because the Claude
account was rate-limited.

## Finding

The 124 px is a clamp, not a drift: there was no scroll position that could
hold the row. The product was correct; the spec asked for an impossible
position.

- With #1108 a long tool-only conversation folds into one group. The live
  window (100 rows) renders as three things: the history header (56 px), one
  folded group of 99 calls (87 px row, its folded line at 69 px) and the
  answer. The browser's first click loads all 52 remaining rows at once (the
  API pages of 12 + 40 are the spec's own backend check, not the browser's
  page). Stops 1–51 coalesce into the same group, so the only new display row
  is the prompt (180 px), and the header goes away.
- The whole transcript is then about 342 px of rows in a list much taller
  than that (1440 × 1000 window).
  `scrollHeight - clientHeight` is 0 before and after the click, so the list
  cannot scroll at all. The prompt pushes the folded line down by
  180 − 56 = 124 px, the same in every case because the prompt and header are
  the same height. The scroll controller ends the history navigation
  `clamped`, as designed (transcript-scroll.md, "Clamped boundaries are a
  legitimate outcome").
- Neither candidate in the original item was it. The restore anchors the
  right part (the folded line keeps the newest call's part id) at the right
  offset, and `rowPosition` measured the right element. The cause was the
  geometry: folding made the transcript shorter than its viewport.
- So #1108 caused it in the sense that it folded the trail into one short
  group. Before #1108 the 99 calls rendered as a tall run of rows, the list had
  scroll range, and the hold converged. No bisect run was needed: the fixture
  below reproduces the mechanism, and the live annotations show it directly.

## Current state

- Since #1212 one transcript scroll controller owns every viewport write
  ([transcript-scroll.md](../../architecture/transcript-scroll.md)).
  `HeldTranscriptPlace` (`apps/web/src/hooks/useHeldTranscriptPlace.ts`)
  resolves a held place through source indexes (part, row, boundary), and
  re-captures it before the page commits. History restores then converge on
  measured geometry; the TranscriptPaging browser fixture records a peak
  displacement of 1 px.
- Tool groups of three or more calls render folded (#1108; the "Tool groups"
  section of transcript-scroll.md). A page that coalesces older calls in front
  of the first group grows that group without adding a display row.
- The live spec's held-place check is clamp-aware (`holdPosition` in
  `e2e/transcript-hold.ts`, shared with the fixture and deterministic checks).
  It works out the scroll position that puts the reader's row back at its old
  offset, limits it to the list's scroll range, and requires the list to stand
  within 8 px of it. With room to scroll this is exactly the old "row within
  8 px" check. When the list
  cannot scroll that far, it must stand at the end of its range. The
  annotation records signed `hold.clampedPx` (negative at the top, positive
  at the bottom) and `hold.errorPx`.
- Each click also records a content-free `<label>-layout` annotation: the
  first rendered parts' ids, the trail stops their text names, their boxes,
  the fold state, the first rows' keys and heights, and the scroll range. No
  transcript text is recorded.
- The paging fixture (`e2e/fixture/TranscriptPagingFixture.tsx`) gained
  `stops=N` (a live-length trail with a 100-row tail), `paged=N` (history
  behind a cursor, N rows a page) and `prompt` (a user prompt opening the
  conversation). `e2e/TranscriptPaging.spec.ts` uses them in four new test
  scenarios (eight added project cases across desktop and mobile Chromium,
  30 project cases in all):
  - a page coalescing into the folded group at the top (native and
    reviewer): the line holds within 2 px on every probed frame;
  - the prompt landing above the folded group at 300 px (native): the list
    has room, the controller ends `converged` and the line holds within 2 px;
  - the same at 1000 px (native): the transcript fits, the controller ends
    `clamped` at scrollTop 0, and the line moves down.

  The reviewer view hides the workflow's prompts, so the prompt cases are
  native only.
- `e2e/TranscriptHold.spec.ts` exercises the shared calculation and live
  assertion without provider turns: exact holds, signed clamps at both ends,
  drift, the 8 px error limit, missing or invisible anchors, and the
  `landedAbove`/`maxScrollTop` gate. The prompt fixture cases call that same
  assertion with measured browser geometry.

## Outstanding work

### Code

1. ~~Find out where the 124 px comes from and fix it.~~ **Done (2026-10-25).**
   It is the clamp described under Finding. Fixed in the spec, which now
   checks the position the list can actually reach (see Assumptions and
   decisions). The 8 px limit is unchanged. Reproduced without a provider
   first, as the item asked: the `prompt` fixture moved the folded line
   101 px (157 px prompt row − 56 px header) at 1000 px with the controller
   `clamped`. At 330 px it converged to 0 px. Regression cases are in
   `TranscriptPaging.spec.ts`.
2. ~~Once fixed, re-run the native Claude case, and Codex with
   `ORKESTRATOR_AGENT_TEST_PAGING_CODEX_NOTES=0`.~~ **Done (2026-10-25)**; see
   Evidence.

### Qualification

- ~~The live paging spec's native case, Claude and Codex, passing its browser
  checks: the reader's row within 8 px after each click, the prompt as the
  oldest row, a loaded tool row expanding, and the same after a reload.~~
  **Done (2026-10-25)**: both pass, including after a reload. In both cases
  the row's 8 px check passes as a clamp, because the folded transcript fits
  the viewport. A hold with scroll range is proved by the fixture cases above
  and by the existing TranscriptPaging cases. Live, the Codex default (step
  notes on) and the reviewer case produce tall transcripts that exercise it;
  neither was rerun here because neither changed.

## Evidence

### 2026-10-24 (the report)

Profile `qa-0050-paging` (`dev:test --fixture --credential-source claude
--credential-source codex --agent-platforms claude,codex`) on node mbp3,
macOS arm64, under a host load average of 20 to 30. Annotations are in
`output/agent-testing/qa-0050-paging/evidence/*.json` (untracked, on mbp3).

| Case | Backend checks | Browser |
| --- | --- | --- |
| Claude Haiku, 150 stops | 152 rows; a 100-row truncated tail with a cursor; pages 12 + 40 to the prompt, `complete`; all 150 stops in order; stop 2's deferred detail resolved (13,267 bytes) | First click: anchor moved 124 px (limit 8) |
| Codex GPT-6-Luna, tool-only (`..._CODEX_NOTES=0`) | The same: 152 rows, pages 12 + 40, all 150 stops, deferred detail resolved (13,261 bytes) | First click: anchor moved 124 px (limit 8) |
| Claude Haiku again, on `main` at `a5d78cfc` (after #1212), profile `qa-0050-paging2` | The same: 152 rows, pages 12 + 40, all 150 stops, detail resolved (13,267 bytes) | First click: anchor moved 124 px (limit 8) |

### 2026-10-25 (diagnosis and qualification)

Profile `qa-0090-paging` (same `dev:test` flags) on arktech-mini, macOS
arm64, branch `todo-0090-held-place-drift` on `ba7cc8d4`. Results are in
`output/agent-testing/qa-0090-paging/evidence/{claude,codex}-results.json`
(untracked, on arktech-mini).

| Run | Spec | Result |
| --- | --- | --- |
| Claude Haiku, 150 stops | Old 8 px offset check plus the layout probe | Failed as reported: 124 px. Layout: before, row 0 is the folded group (folded line at 69 px), scrollTop 0. After, row 0 is a new 180 px row with no group (the prompt), the group is row 1 with its line at 193 px, the header is gone, scrollTop 0. Same backend results as 2026-10-24. |
| Claude Haiku, 150 stops | Clamp-aware check | **Passed** (271 s). Both clicks (first load and after reload): `maxScrollTop` 0 before and after, rows 180/87/75 px, `hold: { reachable: 0, clampedPx: 124, errorPx: 0 }`, control retired, prompt oldest, stop 2 expanded. |
| Codex GPT-6-Luna, tool-only | Clamp-aware check | **Passed** (166 s). Both clicks: `maxScrollTop` 0 before and after, rows 180/87/87/75 px (this run's page added the prompt and one more 87 px row), `hold: { reachable: 0, clampedPx: 211, errorPx: 0 }`. 152 rows, pages 12 + 40, all 150 stops, detail resolved (13,261 bytes). |

Fixture runs (`ORKESTRATOR_E2E_PORT=14390`, desktop and mobile Chromium):

- `e2e/TranscriptPaging.spec.ts`, whole owner, `--workers=1`: 30 passed
  (111.0 s logged).
- The new folded-group cases, `--workers=4 --repeat-each 5`: 40 passed.
- Whole owner, `--workers=4`: 28 passed, 2 failed. Both failures were the
  pre-existing `paging before prose` scenario, recorded under open flake
  [0483](../../tests/flaky-tests/native-agents-and-transcripts/0483-transcript-paging-prepend-index-timing.md).
  The new cases passed.

### 2026-10-25 (review fixes)

The hold calculation and assertion now live in `e2e/transcript-hold.ts`, shared
by the live spec and provider-free tests. Upward clamps retain their signed
displacement (`-56` for the disappearing-header example); downward clamps
remain positive. The unused fixture `clock` and `fresh` options were removed.

- `mise run test:logged -- --name transcript-hold-check-final -- mise run check`:
  passed formatting, lint and all typechecks.
- `ORKESTRATOR_E2E_PORT=14490 mise run test:logged -- --name transcript-hold-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptHold.spec.ts e2e/TranscriptPaging.spec.ts --workers=1`:
  all 30 paging fixture cases passed. One new deterministic rejection test
  initially expected a custom message for a missing numeric measurement;
  its message expectation was corrected.
- `ORKESTRATOR_E2E_PORT=14491 mise run test:logged -- --name transcript-hold-deterministic -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptHold.spec.ts --workers=1 --output output/playwright/transcript-hold`:
  all 24 deterministic project cases passed.
- `mise run test:logged -- --name transcript-hold-regression -- mise run test`:
  root/agent-support, bridge and protocol groups passed. The workspace group
  remained queued for shared worker capacity for over eleven minutes without
  starting; the aggregate was stopped (exit 130), so there is no full-suite
  pass claim.

Live provider turns were not repeated for this review: the same helper and
assertion now execute automatically without the live opt-in.

## Constraints and rationale

- The 8 px limit is the spec's definition of "held". It is not loosened: with
  scroll range the check is exactly the old one. A clamp is accepted only
  when the list stands at the end of its range, measured, not assumed.
- Keep the folded line's part-id anchor (#1108) or replace it with something
  at least as exact: held places across coalescing pages depend on it. It is
  kept; the fixture shows a page coalescing into a folded group holds its
  line to 2 px.

## Assumptions and decisions

1. **Fix the spec, not the product.**
   - Options:
     - (a) Make the live check clamp-aware: compare the list's position with
       the position that holds the row, limited to the scroll range.
     - (b) Make the product hold the place anyway, by padding the transcript
       with blank space below the last row so the list can scroll by the
       prompt's height.
     - (c) Bottom-align a transcript shorter than its viewport, so rows
       loaded above grow upward and nothing below moves.
     - (d) Loosen the limit, or skip the check when the transcript is short.
   - Choice: (a).
   - Why: the controller already does the right thing. It scrolls as far as
     it can and reports `clamped`, and it converges to 0 px when there is
     room (fixture at 330 px). The reader loses nothing: the whole
     transcript, their row included, stays on screen.
   - Pros: no behaviour change for users; the 8 px limit stays exact wherever
     holding is possible; the check still fails a list that could have
     scrolled and didn't.
   - Cons: in a short folded transcript the live native case proves only the
     clamp, not a hold with range. The fixture cases cover that, and the
     Codex step-notes and reviewer cases cover it live.
   - Why not the others: (b) leaves an empty gap below the answer, which
     would have to collapse again as the reader scrolls, and it changes
     follow behaviour at the end. (c) redesigns where every short transcript
     sits, for every view. (d) is what the constraint forbids.
2. **No bisect run on #1094's merge.**
   - Choice: answer the open question from the mechanism instead.
   - Why: the fixture reproduces the clamp, and the live layout annotations
     show `maxScrollTop` 0 around the click. That is direct evidence that
     folding made the transcript shorter than its viewport.
   - Pros: no extra 5-minute provider run against an old tree.
   - Cons: no run between #1094 and #1108 exists. The pre-#1108 pass rests
     on the row heights of an unfolded run, not on a measured run.
3. **Keep the layout probe in the live spec permanently.**
   - Why: it attributed this drift in one run. It records ids, stop numbers
     and boxes only, never transcript text, so it stays within the spec's
     rule that prompts and transcript text never reach test output.
4. **New fixture options default off.**
   - Why: `stops`, `paged` and `prompt` leave the existing cases' data
     unchanged. That matters because one of those cases is the open flake
     0483.
5. **Keep this file instead of deleting it.**
   - Why: the delegation asked for this file and its index row to be updated
     with the evidence. Under docs/README.md a finished file is deleted once
     its durable behaviour lives elsewhere, and that is now true:
     transcript-scroll.md (Semantic anchors and history) and agent-testing.md
     (Live transcript paging) carry it. Delete the file and its index row in
     a follow-up, or when this branch is reviewed.

## Open questions

- ~~Did #1108 cause this?~~ Answered: yes, by folding the trail into one
  group short enough that the transcript fits its viewport. The hold then
  clamps (see Finding). It was not a restore error, and #1212 had nothing to
  fix.

## Needs verification

- ~~Whether a slower host alone (load average about 30) can delay Virtuoso's
  size corrections past the spec's 5 s poll.~~ Not timing. The list has no
  scroll range (`maxScrollTop` 0), so no correction could move it. The same
  124 px appeared on mbp3 under load and on arktech-mini.

## Related

- [0050-transcript-history-efficiency.md](0050-transcript-history-efficiency.md):
  the qualification run that found this.
- `docs/architecture/native-transcripts.md`,
  `docs/architecture/transcript-scroll.md#semantic-anchors-and-history` and
  `docs/development/agent-testing.md#live-transcript-paging`.

## Replaces

Nothing; new on 2026-10-24.
