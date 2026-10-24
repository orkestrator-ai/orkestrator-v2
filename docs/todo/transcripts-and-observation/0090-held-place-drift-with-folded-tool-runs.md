# Held place drifts 124 px after Load earlier messages

Checked against `main` at `71227437` and again at `a5d78cfc`, after the
#1212 scroll rework (2026-10-24).

"Load earlier messages" must keep the reader's row where it was: the row
first on screen before the click stays at the same offset after older rows
land above it. The live paging spec allows 8 px. On 2026-10-24 both native
cases of `e2e/agent-testing/transcript-paging-live.spec.ts` missed that by
124 px on their first click, Claude Haiku and tool-only Codex alike. Both runs
passed every backend check before that point. The held-place fixes in #1094
were last proved live on 2026-10-18. Tool-run folding (#1108) landed after
them and changes what the first rendered tool row is, so it is the leading
suspect. The live spec had not been run since #1108 because the Claude
account was rate-limited.

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
- The spec measures before and after with `firstVisibleRow` and
  `rowPosition`: the first `[data-transcript-part-id]` element in view, then
  the first element whose text names the anchor stop.

## Outstanding work

### Code

1. Find out where the 124 px comes from and fix it. Two candidates:
   - **Product.** After a prepend that grows the first folded group, the
     restore anchors to the right part id but at the wrong offset. For
     example, the folded line's position inside its row moves when the
     group's count or its expanded list changes, or the jump uses Virtuoso's
     stale size for the grown row.
   - **Spec.** After the prepend, another element names the same stop (the
     folded line and a row in an opened list), so `rowPosition` measures a
     different element from the one held.

   Reproduce it without a provider first. A browser fixture with a folded
   group at the top, a page that coalesces into it, and the held-place hook
   would make each attempt seconds, not a 7-minute live run.
2. Once fixed, re-run the native Claude case. Codex runs with
   `ORKESTRATOR_AGENT_TEST_PAGING_CODEX_NOTES=0` produce 150 single-call rows
   and exercise folding hardest.

### Qualification

- The live paging spec's native case, Claude and Codex, passing its
  browser checks: the reader's row within 8 px after each click, the prompt
  as the oldest row, a loaded tool row expanding, and the same after a
  reload.

## Evidence (2026-10-24)

Profile `qa-0050-paging` (`dev:test --fixture --credential-source claude
--credential-source codex --agent-platforms claude,codex`) on node mbp3,
macOS arm64, under a host load average of 20 to 30. Annotations are in
`output/agent-testing/qa-0050-paging/evidence/*.json` (untracked).

| Case | Backend checks | Browser |
| --- | --- | --- |
| Claude Haiku, 150 stops | 152 rows; a 100-row truncated tail with a cursor; pages 12 + 40 to the prompt, `complete`; all 150 stops in order; stop 2's deferred detail resolved (13,267 bytes) | First click: anchor moved 124 px (limit 8) |
| Codex GPT-6-Luna, tool-only (`..._CODEX_NOTES=0`) | The same: 152 rows, pages 12 + 40, all 150 stops, deferred detail resolved (13,261 bytes) | First click: anchor moved 124 px (limit 8) |
| Claude Haiku again, on `main` at `a5d78cfc` (after #1212), profile `qa-0050-paging2` | The same: 152 rows, pages 12 + 40, all 150 stops, detail resolved (13,267 bytes) | First click: anchor moved 124 px (limit 8) |

The same offset in every case, with different providers and row shapes and
before and after #1212, points at the shared renderer or the spec rather than
either bridge. The synthetic TranscriptPaging fixture holds within 1 px, so
the real transcript's shape (tall coalesced or folded tool runs from live
history) is the difference to reproduce.

## Constraints and rationale

- The 8 px limit is the spec's definition of "held". Do not loosen it to
  pass; a reader whose row jumps by a tool row's height has lost their place.
- Keep the folded line's part-id anchor (#1108) or replace it with something
  at least as exact: held places across coalescing pages depend on it.

## Open questions

- Did #1108 cause this? #1212 did not fix it. The 8 px check arrived with
  #1094, and on 2026-10-18
  the Codex native and reviewer-tab cases passed it, before #1108 folded tool
  runs. That makes folding the leading suspect, but no run between the two
  merges exists to confirm it. A bisect run of the spec on #1094's merge
  would settle it.

## Needs verification

- Whether a slower host alone (load average about 30) can delay Virtuoso's
  size corrections past the spec's 5 s poll. The identical 124 px in two
  different runs argues against timing.

## Related

- [0050-transcript-history-efficiency.md](0050-transcript-history-efficiency.md):
  the qualification run that found this.
- `docs/architecture/native-transcripts.md` and
  `docs/development/agent-testing.md#live-transcript-paging`.

## Replaces

Nothing; new on 2026-10-24.
