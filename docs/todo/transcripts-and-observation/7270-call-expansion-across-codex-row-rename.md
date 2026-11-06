# An expanded tool call folds again when a Codex replay renames its row

## Task analysis

Analysed 2026-11-06 against main at `c1724ab7`. Found while running
[0050](0050-transcript-history-efficiency.md) task 5.

### Tasks

1. **Keep a call's own expansion across a row rename**: an expanded tool call inside an open group stays expanded when the first replay after live streaming renames its row. Status: open.

### 1. Keep a call's own expansion across a row rename

**Problem.** In 0050 task 5's live run, `transcript-paging-live.spec.ts`
expanded stop 2's call (its deferred output) inside an open tool group, then
restarted the Codex bridge under the mounted tab. After the restart the
group was still open and the reader's place was held, but stop 2's own
output was folded again. A reader who opened one call loses that one
opened detail after a bridge restart. Nothing is duplicated or lost.

**Context.** The first replay after live streaming renames every Codex row
(`replayedRowId`; 0050 Code item 5). Since 0050 task 5 the calls inside keep
their live ids (`bridges/codex-bridge/src/history/code-mode-commands.ts`).
An open group is remembered by its calls' ids, which is why the group stays
open. Expansion state lives in `useMessagePartExpansion`
(`apps/web/src/lib/chat/message-part-expansion.ts`), keyed by a part key.

**Investigation.** Not confirmed; a hypothesis from reading the code.
`partIdentities` in `apps/web/src/components/chat/NativeMessage.tsx` keys a
part by `sourcePartIdentity(part)`, which prefixes the call id with
`part.sourceMessageId` when the part carries one. In a coalesced display row
that is the source row's id, so it changes with the rename even though the
call id does not. A part without a source identity falls back to
`${message.id}-part-${index}`, also row-dependent. The tool group passes its
part key on to each entry (`entryPartKey` in
`apps/web/src/components/chat/NativeMessage.tool-group.tsx`), so a call's own
expansion key would change with either. Steps to confirm:

1. Write a focused renderer test: render a coalesced row whose calls carry
   `sourceMessageId`, expand one call, rerender with the same calls under new
   row and source message ids, and check the call is still expanded.
2. If it folds, find which key changed (the group's part key or the call's
   identity) and key the call's expansion by its call id within the
   expansion scope, keeping the old key as an alias the way
   `useMessagePartExpansion` already accepts several keys.
3. Rerun 0050 task 5's command (results section of 0050) and check stop 2's
   output is still open after the restart.

**Decisions.**

- **How to key a call's expansion?**
  - **By its call id within the expansion scope, with the current key kept as an alias (recommended).**
    - Pros: survives any row rename (a replay, a coalesced row re-forming);
      the alias keeps state saved under the old key.
    - Cons: two keys per call in the capped store.
  - **Map old row ids to new ones when a replay renames rows.**
    - Pros: one key per call.
    - Cons: the tab cannot know the mapping; the bridge would have to send
      it, which 0050 decision 19 avoided.
- **Add a check to the live spec?**
  - **Yes: after the restart, assert the call the spec expanded is still expanded (recommended).**
    - Pros: free with the loopback model; catches a regression at the next
      Codex bump.
    - Cons: one more assertion in a long spec.
  - **No: rely on the renderer test.**
    - Pros: the spec stays as it is.
    - Cons: the renderer test cannot reproduce a real replay's ids.

## Related

- [0050](0050-transcript-history-efficiency.md) task 5 and its 2026-11-06
  results.
- [transcript-scroll.md](../../architecture/transcript-scroll.md) for held
  places and anchors.
