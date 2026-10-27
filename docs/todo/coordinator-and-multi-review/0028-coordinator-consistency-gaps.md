# Coordinator consistency gaps

Checked against `main` at `20f6de91` (2026-10-25). First written against
`2459b05c` (2026-10-15).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

The file is Finished: every code item (2 to 8) is done and on `main`, item 1 is
owned by 0005, and the one qualification run is owned by 0024. What is left is
housekeeping.

1. **Retire the file**: the branch it was waiting on has merged, so the file
   should now be deleted under the README rules. Status: open.
2. **Steer for OpenCode and Grok** (item 1): tracked here only as a pointer.
   Status: blocked (OpenCode 2.x `delivery: steer`, an ACP mid-turn input for
   Grok; owned by 0005 and 0008).
3. **Live proof of ride-along and blocker wording** (Qualification): tracked
   here only as a pointer. Status: open (owned by 0024).

### 1. Retire the file

**Problem.** The file says to keep it "until this branch's review passes" and
then delete it. That branch has merged, so the file and its index row are now
stale backlog. Anyone ranking work from the folder index sees a Finished row
with nothing to pick up.

**Context.** README "Maintaining the folders": when the last item is done, set
**Finished** to Yes (done, `0000-index.md:20`), move durable behaviour into
`architecture/`, delete the file and remove its index row. Decision D8 in this
file says the same.

**Investigation.** Branch `todo-0028-coordinator-consistency-b1b98c1981f1`
landed as `40ff2511` "feat(coordinator): close coordinator consistency gaps
(#1256)" on 2026-10-25, an ancestor of `863b5782`. Every code reference in
"Current state" still exists:
`environmentListFingerprint` (`apps/backend/src/core/control-mcp-tools.ts:391`,
used at `:833`); `unusedCoordinatorConversationIds`
(`apps/web/src/components/projects/CoordinatorPanel.tsx:623`);
`waitingBlocker` (`apps/backend/src/core/coordinator-status-wakes.ts:672`);
`includeCoalescing` / `joinCoalescing`
(`apps/backend/src/core/agent-mail-service.ts:485`, `:693`; the storage half is
now in `storage-agent-mail-injects.ts:469`, not `storage-agent-mail.ts`);
`MAX_OPEN_COORDINATOR_CONVERSATIONS = 16`
(`apps/backend/src/core/coordinator-service.ts:90`). The durable behaviour is
already in `docs/architecture/coordinator.md` (unused side agents at line 124,
"Status wakes" at line 779) and `agent-registry.md`. Two "Current state" facts
are slightly stale: OpenCode's actions are now `compact`, `undo` and `redo`
with no `share` (`packages/protocol/src/native-agent.ts:1174`), and Grok's are
`{ compact: true }`, not empty (`native-agent.ts:1113`). Neither changes the
steer conclusion. The file is linked from 0005, 0008, 0024, 0026 and 0142, and
from the folder index; deleting it means editing those links (no unit test
checks relative Markdown links, so nothing would fail, but the links would
rot).

**Decisions.**

- **What to do with the file now?**
  - **Delete it now, with its index row, and repoint the five inbound links
    (recommended).** Point them at `architecture/coordinator.md` or drop them.
    - Pros: follows the README rule and D8; the condition it was waiting on is
      met; removes a dead row from the index.
    - Cons: touches five other todo files; loses the D1 to D7 rationale unless
      it is first copied into `coordinator.md`.
  - **Copy D1 to D7 into `coordinator.md` first, then delete.**
    - Pros: keeps the reasoning (why sides only, why the renderer names
      candidates) next to the behaviour.
    - Cons: more work; `coordinator.md` is already long and much of this is
      history rather than behaviour.
  - **Keep it as Finished.**
    - Pros: no edits elsewhere.
    - Cons: contradicts the README and the file's own D8; the stale
      "Current state" facts above would keep drifting.

### 2. Steer for OpenCode and Grok

**Problem.** OpenCode and Grok cannot steer a running turn; prompts sent
mid-turn are queued instead.

**Context.** Not this file's work (struck through as item 1); owned by
[0005](../agent-engines/0005-mid-turn-steer-and-interrupt.md) and
[0008](../agent-engines/0008-opencode-v2.md).

**Investigation.** Still true. `nativeAgentCapabilities()` gives `steer` to
Claude (`native-agent.ts:1139`), Pi (`:1196`), Codex (`:1208`) and Cursor
(`:1113`), not to OpenCode (`:1174`) or Grok (`:1113`). `@opencode-ai/sdk` is
still pinned at `1.19.4` (`apps/backend/package.json:23`).

**Decisions.** None: ownership is already settled in 0005 and 0008, and the
pointer disappears with the file under task 1.

### 3. Live proof of ride-along and blocker wording

**Problem.** The ride-along of held notices and the "approval" or "question"
wording are proven by unit tests only.

**Context.** The run belongs to
[0024](0024-coordinator-live-conformance.md), "Status wakes" (line 432), whose
`status` scenario already covers the approval part.

**Investigation.** 0024's status-wake item covers a worker held on an approval
for more than 20 seconds and seven reviews coalescing into one wake. It does not
say it checks the question wording ("for an answer to a question") or a held
notice riding along with mail dispatched meanwhile; 0024's "How to hold a worker on an
approval" decision (line 784) considered a question as option (c) and chose an
approval instead, because not every provider has a question tool.

**Decisions.**

- **Where should the question wording and ride-along checks live once this
  file is deleted?**
  - **Leave them to 0024's existing status scenario and accept unit coverage
    for the question case (recommended).**
    - Pros: no new todo; 0024 already decided which states the live run must
      prove; the wording is a pure function of the projection's interactions.
    - Cons: the question wording is never seen on a real provider.
  - **Record them as explicit checks in 0024 before deleting this file.**
    - Pros: nothing falls through when the pointer goes.
    - Cons: README rules forbid adding new todos to an existing file; it would
      need a new numbered file or a narrowing edit to 0024's existing item.

Every enabled platform can already inspect, delegate, wake and queue through
the same coordinator interface. This file collected the smaller differences
that kept the platforms from feeling the same. All of them are now closed on
branch `todo-0028-coordinator-consistency-b1b98c1981f1`. Steer for OpenCode
and Grok stays blocked upstream and is owned by
[0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md).
The deferred coordinator product surfaces moved to
[0142-coordinator-product-surfaces.md](0142-coordinator-product-surfaces.md).
The behaviour is described in [`coordinator.md`](../../architecture/coordinator.md)
and [`agent-registry.md`](../../architecture/agent-registry.md). Once this
branch's review passes, delete this file and its index row
([rules](../../README.md#maintaining-the-folders)).

## Current state

- **Steer.** `nativeAgentCapabilities()` in
  `packages/protocol/src/native-agent.ts` gives Claude, Codex, Pi and Cursor
  `actions.steer`. OpenCode's actions are `compact`, `undo`, `redo` and
  `share`, with no steer; Grok's are empty. Queueing a prompt during a turn
  works on all six. OpenCode is still pinned at 1.19.4 (no `delivery: steer`).
- **Polling.** The coordinator poll guard (`coordinatorPollGuard` in
  `apps/backend/src/core/control-mcp-server.ts`) covers `read_messages`,
  `get_message_status` and now `list_environments`
  (`environmentListFingerprint` in `control-mcp-tools.ts`).
- **Waiting workers.** The toolbar chip (`awaitingWorkers` in
  `apps/web/src/components/projects/CoordinatorPanel.tsx`) marks a worker whose
  delegation has a waiting episode as needing a person. The episode starting
  or ending announces a `coordinator` change
  (`updateCoordinatorWorkflowAssociation` in `apps/backend/src/core/storage.ts`).
- **Status wakes.** A held status notice joins any batch the drain dispatches
  to the same coordinator (`includeCoalescing` / `joinCoalescing` in
  `storage-agent-mail.ts` and `agent-mail-service.ts`). A waiting notice names
  an approval, a question or both, from the worker's pending interactions
  (`waitingBlocker` in `coordinator-status-wakes.ts`).
- **Open conversations.** `MAX_OPEN_COORDINATOR_CONVERSATIONS` is still 16.
  `createConversation({ closeUnused })` closes the unassigned, never-used side
  agents the panel names (`unusedCoordinatorConversationIds` in
  `apps/web/src/lib/coordinator-unused-conversations.ts`).
- **Model favourites.** The unassigned composer (`AgentNativeTab.helpers.tsx`)
  lists only favourites on platforms it can start, and a locked tab
  (`AgentNativeTab.controller.tsx`) only those on its own platform. Reordering
  keeps hidden favourites in their slots (`mergeReorderedFavoriteModels`).
- **Sidebar activity.** The working/waiting icon stays on the persisted
  `agentActivityState` aggregate; the agent registry stays event-less.

## Outstanding work

### Code

1. ~~**Steer adapters for OpenCode and Grok.**~~ Not this file's work: blocked
   upstream (OpenCode 2.x `delivery: steer`, an ACP equivalent of mid-turn
   input for Grok) and owned by
   [0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md)
   and [0008-opencode-v2.md](../agent-engines/0008-opencode-v2.md). No
   coordinator-only workaround, as before.
2. ~~**Poll guard for `list_environments`.**~~ Done. The same revision-based
   counter and budget (three identical answers in 120 s) now covers
   `list_environments`. Its fingerprint is the filters plus each environment's
   lifecycle, setup, activity and PR state and the other nodes' rows;
   `lastActivityAt` is left out so re-listing a still-`working` worker counts
   as a poll. Evidence: `control-mcp-server.test.ts` "a coordinator re-listing
   unchanged environments is told it is polling". Built although live runs
   (2026-10-18, Claude, Codex, OpenCode and Cursor) showed no coordinator
   polling it; see decision D1.
3. ~~**Unused conversations.**~~ Done. **New side agent** names the open,
   unassigned side agents whose composer is empty in this window; the backend
   closes, in the same write as the new conversation, each one that has no
   provider session, no saved draft with content, no mail and no owned work.
   Evidence: `coordinator-service.test.ts` "a new conversation closes the
   unused empty side agents its caller names" and "closing unused composers
   makes room at the open-conversation limit";
   `commands-registry-coordinator.test.ts` "create_coordinator_conversation
   passes only string conversation ids to close";
   `coordinator-unused-conversations.test.ts`; `CoordinatorPanel.test.tsx`
   "New side agent names the empty unassigned side agents for the backend to
   close". Decisions D2 and D3.
4. ~~**Favourites under `platformFilter`.**~~ Done, in the unassigned composer
   and in platform-locked tabs. Evidence: `AgentNativeTab.test.tsx` "an
   unassigned coordinator composer hides favourites for platforms it cannot
   use". Decision D4.
5. ~~**Waiting marker on the chip.**~~ Done. The chip says "N needs you" and
   names those workers in its tooltip; the waiting episode starting or ending
   announces a `coordinator` change. Evidence:
   `coordinator-status-wakes.test.ts` "a waiting episode starting or ending
   announces a coordinator change"; `CoordinatorPanel.test.tsx` "marks a
   delegated worker waiting on a person once its episode is announced".
   Decision D5.
6. ~~**Coalesced notices ride along.**~~ Done. Evidence:
   `coordinator-status-wakes.test.ts` "a notice still in its coalescing hold
   rides along with mail dispatched meanwhile" (fails with
   `includeCoalescing: false`) and "a held notice never starts a turn of its
   own before its window ends".
7. ~~**Find inside collapsed mail tiles.**~~ Already done when this file was
   reorganised: the row holding transcript find's current match passes
   `ChatFindActiveContext`, which opens every `MailTile` in it until the match
   moves (added in #1031). The entry was stale. Evidence:
   `e2e/MailTiles.spec.ts` "find reveals a match below the mail preview and
   restores the saved expansion choice" (passed on 2026-10-25) and a new unit
   test in `MailTile.test.tsx`.
8. ~~**Approval or question.**~~ Done. The waiting notice reads the worker's
   pending interactions (a one-message projection read with the excerpt's 5 s
   deadline, or the node's projection for a remote worker) and says "is
   waiting for an approval", "for an answer to a question" or both; it keeps
   "input or an approval" when nothing can be read. Evidence:
   `coordinator-status-wakes.test.ts` "waiting blockers",
   `index.test.ts` "production waiting-blocker wiring reads the worker's
   pending interactions", `node-coordinator-remote.test.ts` "reads a worker's
   excerpt and waiting blocker from its projection on the node". Decision D6.

### Qualification

- Status wakes and mail tiles, including the ride-along and the blocker
  wording, are still to be proven live; that run is already owned by
  [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md).

### Product surfaces kept off the parity path

Moved to [0142-coordinator-product-surfaces.md](0142-coordinator-product-surfaces.md).

## Constraints and rationale

- No delegation-age timer ("still running after N hours"). The toolbar chip
  already shows the wait, and an unsolicited timer is exactly the kind of
  update the async contract removes. Status wakes keep to this: each one is an
  observed state change, and the 20-second waiting debounce only suppresses
  waits too short to matter; it never reports elapsed time.
- The "needs you" marker comes from the worker tab's own session phase, never
  from the environment-wide aggregate. The architecture refuses to infer
  tab-level attention from environment status.
- Repository checkout mutation stays UI-only; it is not a coordinator tool.
- Do not block mail or delegation work on steer.
- The agent registry stays event-less. A push event was considered and
  decided against; consumers re-read on the source events.

## Assumptions and decisions

**D1. Build the `list_environments` guard without live evidence of polling.**
Options: (a) leave it until a live run shows polling, as the item first said;
(b) build it now. Chose (b). The guard only appends `repeatedRead` and the
async contract to an answer it still returns in full, and only on the fourth
identical answer inside two minutes, so a false positive costs a sentence.
Grok and Pi were not in the 2026-10-18 runs, and a model that polls
`list_environments` wastes a turn on every platform. Pros: same protection on
every read a coordinator could poll; no data withheld. Cons: one more
fingerprint to keep in step with `environmentSummary`; leaving out
`lastActivityAt` means a busy worker's re-listing is flagged, which is the
intent but could in principle flag a coordinator legitimately checking that a
launch registered (it would need four identical listings to trip).

**D2. Who decides that a conversation is unused.** Options: (a) the backend
alone, from saved drafts; (b) the renderer alone, from its live composer;
(c) the renderer names candidates and the backend verifies them. Chose (c).
Drafts reach the backend 400 ms after the last keystroke, so (a) could close a
side agent whose text was typed just before **New side agent**; (b) cannot see
a draft another window saved, mail the main already sent, or work the
conversation owns. Pros: neither half can close something the other knows is
in use; a caller that names nothing (CLI, older client, tests) closes nothing.
Cons: a second argument on `create_coordinator_conversation`, and a draft typed
in another window inside its 400 ms debounce is not seen.

**D3. Side agents only, and on every create.** Options: close the main too;
close only when the limit would be reached. Chose sides only, on every create.
Closing an empty main would turn "New side agent" into a new main, and the main
uses at most one of the 16 slots. Closing only at the limit would let empty
"Side N" tabs pile up until a create fails over to closing them. Pros:
predictable; empty tabs never accumulate. Cons: a user who opened an empty side
agent to use later loses the empty tab (nothing written is lost; a draft with
only a platform or model chosen also counts as empty).

**D4. Hide favourites in locked tabs too.** Options: only the unassigned
composer under `platformFilter`; every composer whose platform set is narrower
than the favourites. Chose both the unassigned composer (filtered by every
platform it can start, so a platform switched off globally is hidden too) and
platform-locked tabs. The needs-verification question is answered: a filtered
favourite rendered as a selectable placeholder row (`favoritePlaceholder` in
`AgentModelPicker.tsx`), so picking it chose a model the conversation could not
run. Pros: no dead rows anywhere; favourites are never deleted, and reordering
keeps hidden ones in their slots. Cons: a favourite on a disabled platform is
invisible until the platform is enabled again.

**D5. Mark from `delegation.waiting`, as soon as the episode starts.** Options:
mark only once the waiting notice was sent (after the 20 s debounce); mark at
episode start. Chose episode start. The marker is for a person looking at the
panel, not a wake, so it need not wait out the debounce. Announce only when
`waiting.since` changes, so the notice's own bookkeeping causes no refresh.
Pros: the chip reflects the worker's state within a second of the activity edge;
no new field. Cons: an approval answered within a few seconds can flash the
marker briefly.

**D6. Where the blocker comes from.** Options: the activity state (cannot tell);
a new field written by each bridge; the pending interactions already in the
projection. Chose the projection's `interactions`: pending or answering requests
that block the turn, approval kinds (`command-approval`, `file-approval`,
`plan-approval`, `permission`) versus question kinds (`question`, `mcp-form`,
`mcp-url`, `elicitation`, `terminal-selection`). The status key stays
`waiting:<since>`, so the wording never causes a second notice. Pros: no bridge
or protocol change; works for remote workers through the existing projection
read. Cons: one more bounded projection read per waiting notice; a provider that
reports no interactions keeps the generic wording.

**D7. Sidebar activity icon (the open question).** Options: move the icon onto
the agent registry; keep the persisted aggregate. Chose to keep it; see
[`agent-registry.md`](../../architecture/agent-registry.md). Pros: rows are
current on reload and for unopened environments with no extra reads. Cons: two
sources (aggregate for the icon, registry for the hover card) stay in use.

**D8. Finishing the file.** The steer item is owned by 0005 and the product
surfaces moved to 0142, so nothing here is outstanding. The file is kept, marked
Finished, until the coordinator's Multi Review of this branch has read it, and
should then be deleted with its index row.

## Open questions

- None. The sidebar icon question is decided (D7).

## Needs verification

- None. The favourites rendering question is answered in D4.

## Related

- [0026-coordinator-read-only-adapters.md](0026-coordinator-read-only-adapters.md),
  [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)
  and [0142-coordinator-product-surfaces.md](0142-coordinator-product-surfaces.md).
- [0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md) and
  [0008-opencode-v2.md](../agent-engines/0008-opencode-v2.md) for steer.
- [`coordinator.md`](../../architecture/coordinator.md) ("One main coordinator,
  and side agents", "Control MCP", "Status wakes"),
  [`agent-registry.md`](../../architecture/agent-registry.md),
  [`control-mcp.md`](../../architecture/control-mcp.md).

## Replaces

- `docs/todo/coordinator-to-implement.md` (the steer row of "Current matrix",
  §3 "Turn-control adapters", §4 "Smaller consistency gaps" and §5 "Product
  surfaces that are not provider work")
- `docs/plans/coordinator-worker-mail.md` (the agent registry "Not yet" line:
  the push event, now decided against, and moving the sidebar icon onto the
  registry)
