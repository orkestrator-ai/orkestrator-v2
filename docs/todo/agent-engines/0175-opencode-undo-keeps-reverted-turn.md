# OpenCode undo leaves the reverted turn in the transcript

Checked against `main` at `00a0cb82` (2026-10-25). Done on
`todo-0175-opencode-undo-3179a52c7d02` from `93018933` (2026-10-26). Every
item below is done. The durable description now lives in
[`agent-engines.md`](../../architecture/agent-engines.md#maintaining-the-opencode-integration)
("Undo hides a turn OpenCode still holds"). Delete this file and its index
row once the branch has merged; it is kept until then for its decisions.

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

The file is Finished: every item is done, and the branch it waited for has merged.

1. **Hide reverted messages while `Session.revert` is set** (code item 1). Status: done.
2. **Backend test over a fake OpenCode server** (code item 2). Status: done.
3. **Re-run the live OpenCode spec** (qualification). Status: done.
4. **Whether `session.updated` carries `revert` in 1.19** (needs verification). Status: done.
5. **What to do with this file**: delete it now that its branch has merged, or keep it. Status: open.

### 1 to 4. Completed items

**Problem.** Undo on an OpenCode tab reported success but left the reverted turn in the transcript, because OpenCode 1.19 keeps reverted messages until the next prompt.

**Context.** Found by the live run in `cross-cutting/0031-live-provider-and-platform-qualification.md`; the file's six decisions record the design.

**Investigation.** The work landed as `eb0357cb` "fix(opencode): keep reverted turns hidden until redo or prompt (#1292)" on 2026-10-26, which is an ancestor of `863b5782`. The code is present: `apps/backend/src/core/opencode-revert.ts` (`openCodeRevertMarker` at `:33`, `withoutRevertedOpenCodeMessages` at `:76`, `openCodeRevertNotice` at `:98`); `apps/backend/src/core/opencode-provider.ts` (`revertMarker` at `:874`, `observeRevertResult` at `:897`, called at `:1325` and `:1334`, the filter in `interactiveSnapshot` at `:991`, the notice at `:1015`); `apps/backend/src/core/opencode-snapshots.ts:310` and `:468`; `apps/backend/src/core/opencode-stream-state.ts:354`. Tests exist: `opencode-revert.test.ts` and `opencode-provider-revert.test.ts`. The durable description is in `docs/architecture/agent-engines.md:593` ("Undo hides a turn OpenCode still holds"), including the "re-check `revert.ts` and `Session.patch` on every OpenCode bump" rule. The folder index row already says Finished: Yes.

**Decisions.** None: the work is merged and verified.

### 5. What to do with this file

**Problem.** The file says to delete it once its branch merges. That has happened, so keeping it leaves a finished file in the todo folder.

**Context.** README "Maintaining the folders": when the last item is done, move durable behaviour into `architecture/`, delete the file and remove its index row. Inbound links: `docs/todo/agent-engines/0000-index.md:31`, and `docs/todo/cross-cutting/0031-live-provider-and-platform-qualification.md:149` and `:503`. The two flaky-test case files only name the branch, not the file.

**Investigation.** The architecture section covers decisions 1 to 5 (cut rule, partial revert, marker sources, revision and epoch, the advisory). Decision 6 (build-pipeline and Multi Review reads in `opencode-display-transcript.ts` are not filtered; usage and the context gauge still count the reverted turn) is not stated in `agent-engines.md`.

**Decisions.**

- **Delete the file now?**
  - **Yes: add decision 6's scope note to `agent-engines.md`, then delete the file, its index row and the two links in 0031 in one change (recommended).**
    - Pros: follows the README rule and the file's own instruction; the branch has merged; the one missing durable point is preserved.
    - Cons: a small edit to the architecture doc and to 0031 is needed in the same change.
  - **Delete it as is, without moving decision 6.**
    - Pros: smallest change.
    - Cons: loses the reason the build-pipeline transcript and usage ledger ignore the revert, which a later reader may "fix".
  - **Keep it for its decision record.**
    - Pros: the option-by-option reasoning stays in one place.
    - Cons: contradicts the README and the file's own text; a finished file keeps a row in a ranked work list.

Found by the live OpenCode spec run recorded in
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
("Live OpenCode spec evidence"). Agent Info's **Undo turn** on an OpenCode
tab showed "Session reverted", but the reverted prompt and reply stayed in the
transcript, in the backend projection as well as on screen.

## Current state

- Undo calls `client.session.revert({ sessionID, messageID })` with the last
  user message's id, redo calls `session.unrevert`
  (`opencode-provider.ts`, `performSessionAction`). Both answer with the
  updated Session, and the provider now installs its `revert` marker from
  that answer (`observeRevertResult`).
- OpenCode 1.19 does not delete reverted messages. It records
  `Session.revert = { messageID, partID?, snapshot, diff }` and keeps every
  message until the next prompt, whose `SessionRevert.cleanup` removes them
  (a `message.removed` each) and clears the marker. Its own TUI hides
  messages from `revert.messageID` onward.
- The backend now reads the marker. `OpenCodeStreamState` keeps it per
  session (`revert`, `revertKnown`, `revertVersion`), set by every
  `session.updated` (`openCodeRevertMarker(info)`), by the action answers,
  and by a `session.get` in `OpenCodeProvider.revertMarker` when a stream gap
  (`markGap`) or a fresh backend leaves it unknown. A read that a newer
  update overtook is discarded by `revertVersion`; a failed read serves the
  last marker seen and asks again next time.
- `withoutRevertedOpenCodeMessages` (`opencode-revert.ts`) drops what the
  marker covers, mirroring `cleanup`. `openCodeTranscriptSnapshot`,
  `openCodeTranscriptPage`, their revised rows and reconciliation ids, and
  the joined `interactiveSnapshot` apply it; the stream cache keeps every
  message, so Redo restores the rows without a re-read.
- A marker change moves the revision and the history epoch
  (`OpenCodeStreamState.setRevert`), so a cached snapshot is not served and
  paged history and page cursors named under the old marker expire.
- While a revert is pending, `sessionStateSnapshot` and `interactiveSnapshot`
  carry an info advisory (`openCodeRevertNotice`): "Turn undone. Sending a
  new prompt discards it for good; Redo turn in Agent Info brings it back."
  The renderer shows notices as persistent toasts and dismisses this one
  when the marker clears.
- `e2e/agent-testing/opencode-live.spec.ts` passes its undo step (see
  Qualification).

## Outstanding work

### Code

1. **Done (2026-10-26) — Hide reverted messages while `Session.revert` is
   set.** The marker is read from `session.updated` events in the stream
   cache, from the revert/unrevert answers, and from `session.get` when
   unknown; messages from `revert.messageID` onward are dropped in the
   snapshot, history pages, revised rows and the joined snapshot. Unrevert
   (marker cleared) brings OpenCode's messages back from the same cache, and
   the next prompt's `message.removed` and marker-clearing `session.updated`
   leave exactly OpenCode's messages. A marker change moves the revision
   (source token) and the history epoch. Evidence:
   `opencode-revert.ts`, `opencode-stream-state.ts` (`observeRevert`,
   `setRevert`, the `session.updated` branch, `markGap`),
   `opencode-snapshots.ts`, `opencode-provider.ts` (`revertMarker`,
   `observeRevertResult`, `interactiveSnapshot`); unit tests in
   `opencode-revert.test.ts` (12 tests: marker parsing, whole and partial
   cuts, id-order cuts for reads that lack the target, compaction rows, the
   notice, and the stream state's set/clear/epoch/gap/overtaken-read rules).
2. **Done (2026-10-26) — Backend test over a fake OpenCode server.**
   `opencode-provider-revert.test.ts` drives the real `OpenCodeProvider`
   against a fake that follows OpenCode's revert contract (revert/unrevert
   answer with the Session and publish `session.updated`; the next prompt
   removes the reverted messages, clears the marker, then appends the new
   turn) and `MessageV2.page` paging. It proves: undo hides the turn in the
   snapshot and in every paged read, moves the source token and epoch, and
   deletes nothing upstream; the echoed `session.updated` keeps the epoch;
   redo restores every row; the following prompt leaves no gap (the reader's
   rows equal OpenCode's); a revert made before the backend saw the session
   is read with `session.get`, including a short read the revert covers
   entirely; a partial revert hides only the rest of its message; and,
   through `NativeAgentService.performProjectionAction` and
   `getTranscriptUpdate`, the progressive view drops the turn and gets it
   back. Disabling the filter fails all five.

### Qualification

- **Done (2026-10-26) — Re-run `e2e/agent-testing/opencode-live.spec.ts`.**
  macOS 27.0 arm64, OpenCode 1.19.4, the host's OpenCode login
  (`opencode`, `opencode-go`), profile `qa-oc-0175` started with
  `mise run dev:test --profile qa-oc-0175 --fixture --credential-source opencode --agent-platforms opencode`
  and stopped and reset afterwards:

  | Run | Pin | Result |
  | --- | --- | --- |
  | `qa-0175-oc-unpinned` | none | exit 0 through `test:logged` (43.7 s); counts not kept, passing output is deleted. |
  | `qa-0175-oc-pinned` | `opencode-go/deepseek-v4.1-flash` | exit 0, 2 passed (51.5 s): the native-tab case including "undo and redo round-trip the latest turn", and the build case. |
  | `qa-0175-oc-unpinned2` | none | exit 0, 1 passed, 1 skipped (build case, no pin), 25.7 s. |

  No Share dialog was opened. `~/.local/share/opencode/auth.json` kept its
  2026-10-19 mtime.

## Constraints and rationale

- Nothing is deleted in OpenCode to make the transcript look right; the
  backend only hides what the marker covers, so the revert stays undoable.
- `Session.revert.partID` can name a part inside a message; decision 2 below
  settles how that is shown, and both a unit and a provider test cover it.

## Assumptions and decisions

1. **What a revert hides: mirror `SessionRevert.cleanup`.** Options: (a) hide
   every message whose id sorts at or after `revert.messageID`, as OpenCode's
   TUI renders it; (b) cut at the target's position in the read, with the
   exact part rule `cleanup` uses; (c) both: position when the read holds the
   target, id order when it does not. Chose (c). The screen then shows
   exactly what the next prompt will leave, and a page or a window that does
   not hold the target (older pages, or a read starting after it) still cuts
   correctly because OpenCode mints message ids ascending. Pros: no gap or
   flash when the prompt commits the revert; works for every read shape.
   Cons: the id-order fallback relies on OpenCode's id format (`msg_` plus a
   time prefix), the same assumption its TUI makes; rows without an OpenCode
   id are judged by position.
2. **Partial revert (`partID`): hide only the rest of that message.**
   Options: hide the whole target message (what the TUI's render switch
   does), or keep the target's parts before `partID`. Chose the latter
   because that is what `cleanup` keeps after the next prompt, so the
   transcript does not change again when the revert commits; a `partID` the
   target lacks keeps the whole target, as `cleanup` does. OpenCode only
   records a `partID` when the target keeps a text or tool part before it,
   and Orkestrator's Undo always names a user message (whole turn), so this
   only arises from a revert made in OpenCode itself. Pro: exact parity with
   the committed result. Con: differs from the TUI's interim rendering.
3. **Where the marker comes from: answer, event and read.** Options: rely on
   `session.updated` only; re-read `session.get` after every action; use the
   action's answer plus `session.updated`, with `session.get` only when the
   marker is unknown. Chose the last. The answer makes Undo take effect on
   the next read with no extra round trip and without waiting for the event;
   the event covers reverts made elsewhere (OpenCode's TUI on the same
   server); the read covers a backend restart or a stream gap. Pros: correct
   whichever arrives first, one extra request only on a cold or post-gap
   read. Cons: one `session.get` per transcript read while it keeps failing
   (it then serves the last marker seen rather than failing the transcript).
4. **What a marker change moves: revision and history epoch.** Options: the
   revision only (new source token), or both. Chose both. A revert can reach
   rows a reader already paged in, and an unrevert can bring back rows a
   page omitted, so paged history named under the old marker must expire,
   the same rule a `message.removed` follows. Pro: no stale paged rows.
   Con: Undo and Redo discard the reader's paged history, which is re-read
   on demand; both are rare, user-driven actions.
5. **Open question answered: show that a revert is pending.** Options: no
   indicator; a composer banner (new renderer UI); an info advisory notice
   through the existing notice channel. Chose the advisory: the renderer
   already shows notices as persistent toasts keyed by `occurrenceId`
   (`opencode-revert:<messageID>:<partID>`), dismisses it when the marker
   clears, and needs no renderer change. Pros: the user learns that the next
   prompt discards the undone turn and how to get it back, as the TUI tells
   them; backend-only. Cons: a toast rather than a composer-attached hint;
   it is not asserted by the live spec (only its absence of side effects).
6. **Scope: the interactive projection only.** Build-pipeline and Multi
   Review transcript reads (`opencode-display-transcript.ts`) are not
   filtered: those sessions never offer Undo. Usage and the context gauge
   still count the reverted turn's tokens: it was billed, and the lifetime
   ledger is meant to keep it.

## Open questions

- None. Whether the composer should show a pending revert is decision 5.

## Needs verification

- **Done (2026-10-26) — Whether `session.updated` carries the `revert`
  field in 1.19.** It does: in 1.19.4's `packages/opencode/src/session/session.ts`,
  `setRevert` and `clearRevert` go through `patch`, which publishes
  `session.updated` with the whole merged Session (`revert` set, or absent
  once cleared), and `revert.ts` answers both actions with
  `sessions.get(...)`. The implementation does not depend on the event alone
  (decision 3); the live run passes either way.

## Related

- [0006-session-titles-and-history.md](0006-session-titles-and-history.md)
  (fork, rewind and revert semantics per provider)
- [0008-opencode-v2.md](0008-opencode-v2.md) (staged revert in OpenCode 2;
  its `session.next.revert.*` events are not consumed yet)
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)

## Replaces

- Nothing; new from the 2026-10-25 live run.
