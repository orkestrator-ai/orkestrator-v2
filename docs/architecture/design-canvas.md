# Design canvas

Status: Living — HTML/CSS design workspace with recoverable operations
(protocol v2). Outstanding work:
[8010](../todo/design-canvas/8010-design-canvas-deferred-optimisations.md)
(optimisations deferred until measured).
What has been qualified is under [Qualification](#qualification).

Use **New design workspace** (the paintbrush in the environment toolbar). The
dialog has three tabs: **New design** (optionally with Claude or Codex, or a
blank canvas with no agent), **Open design** (a host `.orkdes` picker,
`design_import_host_file`, with an upload fallback) and **Saved designs**
(`DesignLibrary.tsx`: search, rename, duplicate, trash, restore and purge of
this environment's private canvases). A design saved to the repository is an
`.orkdes` file, and clicking one anywhere a file opens (file tree, quick open, chat links) opens it
in the design canvas instead of a text tab. A canvas this environment already
made from that exact file content is reused; any other file is imported as a new
canvas that remembers the file as its save location (`design_open_file`,
`openDesignFile` in `design/exports.ts`). Create is blocked, with a one-line
reason and **Check again**, when the backend, storage or renderer is unavailable.

The brief is the new agent tab's opening prompt, and the backend owns sending
it. `handTabInitialPromptToBackend` (`apps/web/src/lib/tab-initial-prompt.ts`)
puts it on the tab's durable prompt queue under
`initial-prompt:<environment>:<tab>` as soon as the tab exists. The backend
queue dispatcher creates the session, waits until the environment is ready for
agents and sends it, so switching environment, or never opening the tab, does
not hold up the first turn. Until that queue write lands, the prompt also
stays on the tab as a renderer fallback, sent under the same request id, which
the backend dedupes. The fallback never joins a running turn's id-less queue
(`noQueue` in the controller's `submit`). The review action's opening prompt
uses the same helper. One window is accepted: the queue write is issued by the
renderer that created the tab, so a renderer that dies between creating the
tab and that write loses the brief. It lasts a few milliseconds of renderer
work, every renderer-created tab has the same exposure, and closing it would
need a backend command that creates the tab and queues the prompt together,
while the pane layout deliberately never stores prompts.

Images pasted into the **New design** brief are written into the environment
(`.orkestrator/clipboard/`, like a composer paste). They travel as attachments
of the queued prompt, and are also seeded into the new agent tab's draft for
the fallback until the queue write lands. The chat beside the canvas is an ordinary native conversation, so
pasting an image into its composer attaches it as usual. New design and Ask
agent reserve attachment slots as paste events arrive and disable confirmation
until decoding and file writes settle. Submission freezes further image pastes;
failed writes release their slots for a retry. Completions from a previous
backend or environment scope are discarded, and image removal stays visible on
touch devices.

The chat keeps the existing approval, question, cancellation, transcript and
background-session behavior. Closing or hiding the canvas does not stop its
agent or any admitted edit. A canvas tab stores only
`designCanvasData: { canvasId }`; HTML never enters the pane layout.

## Documents, records and identities

The portable document is unchanged: `format: "orkdes"`, `version: 1`, id,
environmentId, name, revision and frames (id, name, x, y, width, height, HTML,
revision). `.orkdes` import/export stays strictly version 1.

The backend keeps each canvas in a **private record**
(`design-canvases/<id>.orkrec`, `apps/backend/src/core/design/records.ts`)
that is never exported. It holds the version-1 document plus:

- record `sequence`, an `incarnation`, `statusVersion` (monotonic for changes
  that are not document edits: validation, export state, session links);
- per-frame metadata: opaque **content**, **structure** and **viewport**
  identities and a validation result. HTML changes renew content identity;
  anything that cannot prove element continuity renews structure identity;
  width/height renew viewport identity; x/y/name renew none;
- bounded content-free change descriptors (for deltas), terminal operation
  receipts (≤128, ≤128 KiB), a history manifest, the export association and
  pending export, session links, and deletion/provisional state.

Every document change and its terminal receipt become authoritative together
in **one atomic replacement** (temporary file, fsync, rename, directory sync).
Canvas revisions only increase; frame revisions advance only for changed
frames.

**Migration.** A legacy backend `.orkdes` document is read directly until its
first real edit; migration derives metadata deterministically, commits and
verifies the new record, then moves the legacy file to
`design-canvases/legacy-backups/`. Reading never migrates. A corrupt record is
an explicit `record-problem` (with `backupAvailable`), never a silent fallback
to the stale legacy copy. A record from a newer Orkestrator is read-only and
never overwritten. Downgrading after migration is not automatic: export the
designs (or copy the legacy backups) before running an older backend; do not
dual-write.

## Operations

Edits are **recoverable operations** (`design/service.ts`,
`design/execute.ts`, `design/apply.ts`):

1. **Prepare** validates a bounded descriptor (kind, input, observed
   preconditions, optional gesture/correlation ids) and writes it to a small
   per-canvas pending file. It never edits the canvas and returns an opaque
   token bound to environment, canvas, descriptor digest and record
   incarnation. A repeated prepare with the same correlation id returns the
   same token. Creating a canvas reserves its identity and quota in a
   provisional record.

   A correlation id is bound to an intent digest of the whole validated
   descriptor (canonical JSON, so key order does not matter, except inside
   a `styles` map, which applies in order: `margin` before or after
   `margin-top` is a different edit) while pending and after it settles; the record keeps a private digest per correlated
   receipt, inside the receipt budget. The same id with the same descriptor
   replays (a pending token, or the stored receipt through
   `submit_operation`); the same id with a different descriptor fails
   `invalid-input` ("already used for a different edit", `details.token`,
   retry `never`) and runs nothing; `conflict` would mean "refresh and
   retry" and loop on the same id. A receipt settled before digests were
   kept (before v2.21.0) never matches, so even an identical retry is refused;
   `operation_status` still answers from it. The intent digest is kept apart
   from the token's digest, which execute re-verifies: changing that one
   would invalidate pending entries across an upgrade.
2. **Execute** runs a token once. The computation reads an immutable snapshot;
   Chromium work happens with no lock held. The result is re-verified against
   the latest record (revisions, structure identity, deletion) under the
   canvas lane and committed atomically with its receipt. A repeated execute
   returns the receipt; unknown/expired tokens can never create work.
3. **Status** is side-effect free. **Cancel** works only before execution.

Outcomes: `committed`, `no-op` (equal values: no revision, history or content
hint), `rejected` (typed failure), `canceled`, `interrupted` (the backend
restarted before commit — never replayed), `expired`, `unknown`.

A dead owner's unsettled entry is `interrupted`, with one exception: a
duplicate commits its copy under an id derived from its token
(`tokenUuid`) before it writes the source receipt, so when that copy exists
the operation is `committed` with `createdCanvasId`, also when the source
write failed in-process (`committedDuplicate` in
`design/service-lifecycle.ts`). Restart recovery, `status`, `execute`,
`cancel` and a running peer all answer this way (`deadOutcome` in
`design/service.ts`). The copy also wins on the live owner: when the source
receipt cannot be saved, execute still answers `committed` and keeps the
pending entry; `status` and every later execute (also after the entry's TTL)
answer from the copy, and the next duplicate prepared on that canvas first
records the missing receipt, refusing with `unknown-outcome` only while that
write still fails. A never-migrated legacy canvas has nowhere to keep a
receipt and is never migrated by recovery, so its dead owners' pending entries
stay in the pending file as their outcomes (`retainedOutcomes`): status,
execute, cancel and a correlated retry answer `interrupted` from them, prepare
keeps them while they fit the per-canvas pending bounds (the oldest give way
to new edits and then answer `unknown`), and the commit that migrates the
canvas turns them into receipts. Failures carry
a code (`conflict`, `invalid-input`, `invalid-content`,
`renderer-unavailable`, `capacity`, `deadline`, `deleted`, `not-found`,
`expired-operation`, `unknown-outcome`, `export-collision`,
`history-ineligible`, …), a safe message and a retry class; the legacy
`Design revision conflict:` message prefix is preserved.

Preconditions are exact. Selector edits carry the frame revision **and**
structure identity observed when the element was inspected; a structural
change conflicts even if the selector still matches. The backend rebases a
queued edit's precondition only across the same client's own committed receipts
(`rebaseOverOwnCommits`, a proven chain that must end at the current state); any
other writer's change surfaces as a conflict. Batches (≤16 same-canvas
operations, ≤512 KiB) validate everything, commit once, advance each changed
frame once and create one history entry.

Legacy one-shot actions (`design_action`, MCP tools) are prepare+execute
adapters with their original response shapes.

### Intent queue

Every document has a backend-owned queue of the edits users have not finished
with (`design/intents.ts`): unsent drafts, edits in flight and failures awaiting
review. It is one small file per canvas beside the pending file, written only
under the canvas lane, removed with the canvas, and bounded (32 per canvas, 8
per client, 2 MiB; successes are kept two minutes so a client that lost a
response can still learn them). `design_capabilities` reports `intents: true`.

- `design_intent_run` records the intent (rebased), prepares it, executes it and
  records the outcome, so an edit is durable before anything is prepared. A
  repeat never prepares again: an intent that has a token is only reconciled.
- `design_intents` lists the queue and reconciles from backend state: a
  `preparing` intent adopts the token its correlation id was prepared under, or
  becomes a draft once no live call can own it; a token of unknown outcome takes
  its status. This is the recovery path after a lost response or a restart, for
  any client. Listing never executes anything.
- `design_intent_save` saves unsent drafts; it never overwrites an edit that was
  sent or that another client owns.
- `design_intent_resume` takes an edit over from any client: an unresolved token
  keeps being reconciled (a prepared one is executed, Resume being the consent it
  waited for); an edit that never ran becomes a draft under a new correlation id.
- `design_intent_discard` cancels a token that has not started and removes the
  edit for every client.
- `design_intent_import` takes a browser's legacy localStorage entries once.

Each queue change publishes a content-free `status` hint flagged `intents`.

### Concurrency and bounds

Per-canvas commit lanes plus a small global guard (quota reservation,
environment deletion). Lock order is global guard, then one lane; nothing
waits for the renderer or the global guard while holding a lane.

Several backends may share one data directory. Records, pending files,
checkpoints, exports and backups stay files, and the backend database
coordinates them (`design/coordination.ts`): each lane holds the cross-process
lease `design-canvases/<id>` and the global guard holds `design-canvases`, so
the order holds across processes too. A cached record is used only while the
record file's identity (device, inode, size, nanosecond mtime/ctime) is
unchanged, so every lane verifies and commits against the latest record on
disk. Each service instance holds a liveness lease
(`design-owner/<instance>`) and stamps it on the pending entries, provisional
reservations and export intents it creates; recovery interrupts (or expires)
only work whose owner is gone, and a running peer reports a dead owner's
token as `interrupted` and never runs it. Executing a live peer's token claims
it; if two processes run one token, only the first commit counts and the
other returns its receipt. Every record write or removal moves a change
signal (the `design-canvases/changes` store); the library index, quotas,
recycle bin, history budget and environment deletion rescan the directory
when it moved and re-read only records whose identity changed, and
`index.json` is just a startup cache. Orphaned checkpoints are collected under
the canvas lease against the record on disk. A lease waiter gives up after
60 s (120 s for the global guard) with a retryable `capacity` failure. Admission:
32 operations, 8 per canvas, 8 MiB decoded payload; 8 prepared per canvas;
6 MiB per record. Environment deletion fences the environment before removing
records, so a late render can never resurrect a design. The backend's hourly
orphan sweep (`sweepOrphanedDesignCanvases`) removes the canvases of a fenced
environment whose deletion stopped before its files went, and, once their file
is an hour old, canvases whose environment no longer exists. It never runs on a
partial environment list, and keeps a record whose owner cannot be read.

## Renderer

`design/renderer.ts`/`design/render-queue.ts` run one worker (≤16 admitted
jobs) with fair round-robin across environments and canvases, priority
(interactive > validation > background) with aging, and phase deadlines
(queue 15 s, launch 15 s, context 5 s, run/capture 15 s, cleanup 3 s, overall
45 s). Each job gets a fresh isolated context: all requests aborted, service
workers blocked, downloads disabled, the nonce CSP bootstrap, deterministic
viewport/scale/color scheme/reduced motion. Playwright makes each browser's
profile in the backend's temporary directory and removes it only from this
process, so the renderer records every profile it launches in
`<data dir>/design-browser-profiles/` (`design/browser-profiles.ts`) and drops
the record once Playwright has removed the profile. At start-up the service
removes recorded profiles whose backend and browser have both exited, that are
over an hour old and that no live process names; an unrecorded profile is
never touched, because other tools use the same name. Each launch's Playwright
`artifactsDir` is an `artifacts-<pid>-*` directory in that ledger rather than
an unrecordable `playwright-artifacts-*` in the temporary directory, and goes
with the record (0830). Browser generations are tracked so
a late disconnect from an old process cannot retire a new one; a dead
generation fails its jobs exactly once. Health distinguishes missing
executable, launch failure, saturation, recovery and ready, and is probed on
demand (cached 60 s).

Each generation's browser is a Playwright browser server on loopback
(`launchDesignBrowser`: `chromium.launchServer({ host: "127.0.0.1" })` and
`chromium.connect`), because a browser from `chromium.launch()` exposes no
process. Retiring a generation, including one whose connection dropped while
its server may still run, closes the server within the cleanup deadline;
a close that hangs or fails is followed by `BrowserServer.kill()`, also
bounded. The endpoint's path is a random GUID that the renderer never logs;
a local process that learned it could drive the browser, whose contexts hold
no credentials and abort every request. A supervised render worker process
was rejected: it would add a supervision protocol and IPC for the same
result. The fault
test in `renderer.test.ts` stops a real browser with `SIGSTOP` and checks that
shutdown kills it.

## Validation

One sanitizer and DOM budget (`packages/protocol/src/design-runtime.ts`)
serve the iframe and the backend. Raw HTML (create/replace/import) is
validated before commit when the renderer is healthy: more than 5,000 elements
is rejected; removed scripts/handlers, blocked external references and similar
are recorded as bounded warning counts. With no renderer, content is stored
**unvalidated** and read/export still work. Legacy frames validate lazily by
content identity at low priority; a result for older content never overwrites
newer status. Invalid frames show a per-frame repair overlay (Retry
validation, Ask agent to repair, Restore previous version); healthy frames
remain editable.

CSS edits are validated as a whole by the browser: any rejected value rejects
the operation with the property names and nothing is applied; values equal to
the existing inline declaration are a no-op.

## Deletion, recycle bin and history

Deleting a canvas writes a **tombstone** (restorable). Snapshots/sync report
`deleted` even to a client that missed every hint; `missing` means no record
proves identity; an unauthorized environment also sees `missing`. The recycle
bin keeps ≤32 designs/128 MiB for 7 days; purge is explicit. Restoring creates
a new live revision and a new incarnation (old tokens stay dead).

History (`design/history.ts`) is persistent and bounded (50 entries and
64 MiB per canvas, 512 MiB globally; the newest 3 entries per canvas are
protected). Each entry references an immutable checkpoint file written and
synced before the record references it. Undo/redo are per actor (your own
edits by default), create new revisions, and are eligible only while the
affected frames still have exactly the entry's result versions (canvas-wide
entries need the exact canvas revision); otherwise the history panel offers a
checkpoint preview/compare or explicit restore. One gesture is one entry.

## Synchronization

Live hints (`design-canvas-changed`) stay content-free: canvas id, revision,
optional frame id, kind (`document`/`status`/`deleted`/`restored`), status
version and generation. They are published inside the canvas lane, after the
commit they describe, so one backend emits a canvas's hints in commit order
with non-decreasing revision and status version. Delivery is at most once and
best effort. A crash after the rename loses the hint; other processes sharing
the data directory publish only to their own clients; there is no per-hint
sequence number and no dedupe. A commit may be followed by later hints of its
own: HTML edits validate in the background and publish a `status` hint with
the same revision. A validation result for replaced content is dropped
without a hint. Clients never count hints; the cursor (`generation`,
revision, status version) and `design_sync` are authoritative. `design_sync` answers from one immutable record:
`unchanged`, `status` (metadata only), `delta` (exact base → current revision;
geometry patches omit HTML; HTML only for new content), `reset` (generation,
future cursor, expired range, too large: >256 KiB or >64 frames), or a
snapshot/deleted/missing/problem result. The client installs a delta only when
generation and base match exactly, validates every patch first, and applies it
in one store update; otherwise it fetches a snapshot.

## Client

`design-controller.ts` keeps one projection, hint listener and intent queue
per backend/environment/canvas (`apps/web/src/stores/designStore.ts`). Each
node scope holds its own controllers, store and read coordinator subscription,
and sends its commands through `designApiFor(scope)`; disposing the scope
disposes its controllers ([node scopes](../development/node-scopes.md)).
The rest of the canvas surface (the tab's own calls, the agent, workspace,
export and history dialogs, the library, the layer tree, the deletion notice
and opening a `.orkdes` file) uses the same node through `useDesignScope()` /
`useDesignApi()` (`components/design/design-scope.ts`). The design client has
no command-bound default: `designAction`, `importDesignDocument`,
`importDesignHostFile`, `runDesignLifecycle` and `designLibraryClient` take
the node, so one canvas never splits its operations across two nodes
(plan item 4007).
Activation subscribes before reading; a 3 s cursor check repairs lost hints
while visible; with no visible view, polling stops but queued and admitted
work continues. `refresh()` resolves only after a sync cycle that started
after the call. The window schedules the edits it makes itself (per-lane order,
optimistic previews, gesture collapse, prepare backoff) and sends each through
`design_intent_run`; drafts still waiting are saved to the backend shortly after
they are made. The backend's queue is authoritative for everything else
(`design-intent-merge.ts`, read on every sync cycle): an intent this window did
not create is `restored` and never runs without **Resume draft**, whichever
client made it; another window's edit it is still working on stays out of the
review list. A lost response is reconciled from the queue, never by preparing
again. A failure pauses later edits in the same lane only. A backend without the
queue still runs edits through prepare and execute, rebasing over this window's
own commits, but nothing survives a reload there. `design-drafts.ts` only migrates
the old per-browser store once. The footer separates **Saved in workspace**, pending
edits, **Needs review** and **Exported revision N to path**.

The canvas renders only frames near the viewport with at most eight live
iframes (pinned frames never cull mid-gesture; the rest show placeholders).
Iframe HTML is replaced only when content identity changes; geometry updates
move chrome only. The layer tree is lazy, paged (≤200 nodes/128 KiB per page,
cursors bound to structure) and virtualized, always keeping the focused and
selected rows mounted so keyboard focus survives scrolling.

Navigation: Fit all (Shift+1), Zoom to selection (Shift+2), 100% (Ctrl/⌘+0),
pointer-anchored wheel/pinch zoom, Shift+wheel and middle-drag pan, keyboard
move/resize of frames (Arrow, Alt+Arrow, Shift for 10 px), numeric frame
fields and device presets, frame selection (clicking a frame title outlines
the frame in blue; Delete/Backspace deletes it — undoable; a canvas-background
click or Escape deselects), Escape
priority (gesture → preview → element selection → frame selection → drawers),
design undo only when the canvas owns the shortcut. Narrow panes use
Layers/Inspector drawers. Short panes (under 400 px, about 400% zoom) keep the
Layers and inspector toggles and the design name in the toolbar and move every
other tool into a **More design tools** menu; there the inspector scrolls as
one column and the Layers heading and filter note are visually hidden, so the
panels keep their height (WCAG 1.4.10). Zoom steps keep the menu open; other
items run after it closes, so focus returns to its trigger. **Preview** mode
routes scroll and hover into the frame while links, forms, navigation, scripts
and network stay blocked; Escape inside the frame returns to Inspect.

Inspector fields are named by their visible label ("Fill", "Align items"),
not the CSS property, so speech input can use what it sees (WCAG 2.5.3); the
property is in the field's `data-property` and the label's tooltip, and tests
and tooling address fields through it. Enter on a Layers row whose frame has
not rendered brings the frame into view, announces that it is loading and
selects the layer when the frame renders; selecting anything else or moving to
another frame first drops the wait, and after 10 s it is dropped with an
announcement.

## Save, export and download

Export (Save As) writes one exact committed revision to a repository-relative
`.orkdes` path (`design/exports.ts`, `design/export-writer.ts`). By default
designs go to the `designs/` folder; the dialog has separate **Folder** and
**File name** fields (the folder may be emptied to save in the repository root,
and offers the repository's existing folders). A path is up to seven plain
folder names and a file name; each segment starts with a letter or number, so
`..`, `.git` and other hidden folders cannot be named. Missing folders are
created when saving a new file, one level at a time, and a folder that is a
symbolic link or a file is never traversed (inspect reports it, write refuses
it). The default name is the sanitized design name plus a short canvas-id
suffix, and a design remembers where it was last saved or opened from. The write
uses a same-directory temporary file, sync and `link()` for new files (atomic
no-clobber) or a fingerprint-checked `rename()` for an explicit replacement;
container exports run the same protocol through an owned helper inside the
workspace, streamed over stdin. Intent (path, revision, digest) is recorded
first; a lost outcome is reconciled by comparing the destination's exact
digest, never by writing again. A replacement keeps a private backup of the
overwritten bytes (≤16 per canvas). The replace path is check-then-rename, not
an atomic compare-and-swap against arbitrary external writers. Filesystems
without hard links cannot export new files.

Download fetches a committed snapshot and names its revision. In the desktop
app the download goes through Electron's download manager and Electron's own
Save dialog: the product installs no `will-download` handler on the window's
session (the artifact host's isolated session has one, and it cancels
downloads). The Electron design journey asserts that, so a handler added
later has to bring a test of the dialog it changes.

## MCP

`orkestrator-design` is a separate MCP server at `/design-mcp` on the
agent-tools listener with its own inventory, environment/tab credentials and
ownership checks; workflow-result and broker credentials cannot use it.

Tools: `capabilities`, `list_canvases`, `create_canvas`, `get_canvas`,
`get_canvas_summary` (no HTML), `get_canvas_state`, `get_frame`,
`create_frame`, `update_frame`, `replace_frame_html`, `append_frame_html`,
`replace_element_html`, `set_element_styles`, `move_element`,
`submit_operation` (recoverable, idempotent by `correlationId`; lifecycle,
duplicate/delete frame, restore checkpoint, batches), `operation_status`,
`find_operation`, `history_status`, `list_history`, `undo`, `redo`,
`inspect_element`, `get_frame_layers`, `validate_frame`, `capture_frame`,
`export_canvas` and `save_canvas`. Mutations accept `response: "compact"` to
return a receipt without HTML. `save_canvas` writes through the safe export
path and never overwrites without the target's `replaceFingerprint`. Errors
include the legacy message plus a typed JSON failure.

## Agent context

A canvas remembers bounded links (≤8) to the conversations that worked on it:
the tab id the conversation was last opened in, the identity to resume it by
once that tab closes, platform, role design/implementation, creation time and an optional
checkpoint. Never a transcript, credential or copy of native status. **Ask
agent** adds a removable, revisioned design-context annotation to a
conversation's draft without sending it (images pasted into its note or brief
are added to that draft's attachments), including a brand-new tab's draft:
the unassigned composer shows and sends annotations like every other native
composer. The agent is told to re-read the canvas before editing, and every
edit is still revision checked. **Use as implementation reference** prepares a
reviewable handoff draft for an ordinary conversation; nothing is submitted,
approved, committed or deployed automatically.

Links survive tab closure, because closing a native tab retains its
conversation (see [Tab close and conversation retention](../../AGENTS.md#tab-close-and-conversation-retention)).
Code: `apps/backend/src/core/design/session-links.ts`,
`apps/web/src/components/design/design-session-links.ts`.

- **Session identity.** A new conversation has no session until its first
  send, so a link starts with only its tab id, which names the backend's
  native-session mapping (`env-<environmentId>:<tabId>`) only while the tab
  is open: tab teardown retires that mapping. Teardown
  (`commands-registry-teardown.ts`) therefore records on every link naming the
  tab the identity a resume needs: Codex's thread id, read from the session
  before it is closed (`NativeAgentService.resumableSessionIdIfRunning`,
  observe only), and the provider session id for Claude, which resumes by it.
  If the open session can no longer be read (its bridge restarted or lost it
  before the close landed), teardown uses the identity the provider last
  reported for that session: every native state read keeps it on the tab's
  mapping (`PersistedNativeAgentSession.resumeIdentity`, written only when it
  changes and only for the provider session it was read from). The identity
  read before the close is also journaled on the teardown intent, so a close
  replayed after a backend restart records the same one. An identity that
  cannot be named is not recorded rather than guessed. The
  link is written after the provider-session teardown lock is released (a
  resume holds its canvas lane while waiting for that lock), and recording
  never fails the close. The fallback to the kept identity is covered by
  deterministic tests only (`commands-registry-teardown.test.ts`, "a Codex
  session the bridge lost…"): `e2e/agent-testing/design-resume-clients-live.spec.ts`
  restarts the Codex bridge before the close, but a restarted bridge restores
  its registrations, so the live read still answers. Reaching the branch live
  would need a fault hook in the bridge, so no live check is kept for it.
- **Link states.** `design_session_link_states` reads each link's tab mapping
  from storage (no liveness route, nothing that defeats idle detachment) and
  reports `retained` or `missing`; it writes nothing. For closed links with a
  recorded session on an agent that can archive (of the design agents, Codex),
  it also asks that agent's bridge for its archived conversations, once per
  agent and only when the bridge is already running
  (`NativeAgentService.archivedResumableSessionIdsIfRunning`, observe only:
  never started for this read), within 3 seconds
  (`DESIGN_ARCHIVED_READ_DEADLINE_MS`). A link whose session the list shows
  as archived carries `archived: true`; no bridge, a failed list or a late one
  leaves the flag off, so "not known" never reads as archived. The dialog asks
  once when it opens and again on **Retry**, never on a timer, and shows: open
  (the tab is in this client's pane layout), can be resumed (closed, the link
  records a session), archived by the agent (closed, and the agent lists the
  recorded session as archived), no conversation to resume (closed and
  nothing recorded: it never started, or it closed before links kept
  sessions; remove it or start a new conversation), could not check (the
  backend failed or did not answer within 8 seconds: **Retry**, never a
  replacement; a late answer still replaces it) and closed (a backend older
  than this command, or an agent without resume). Archive itself is the
  resume list's **Remove from list**
  ([agent-engines.md](agent-engines.md#removing-a-conversation-from-the-resume-list)).
  A Codex thread archived while its bridge was not running reads as can be
  resumed until a later check finds the bridge up; Resume then fails with the
  agent's refusal in the dialog, and nothing opens.
- **Resume conversation.** A closed link that can be resumed is offered ahead
  of a new conversation, alone or as the destination for new context
  ("Resume and add to composer"). An archived one offers **Unarchive and
  resume** beside **Remove link**, and can be chosen as the destination
  ("Unarchive, resume and add to composer"), but is never chosen for the user,
  because reaching it writes provider state. It sends `restoreArchived: true`
  (an optional, non-critical argument: an older backend resumes as before and
  the agent refuses the archived thread): the backend unarchives the recorded
  session (`setProjectionResumableSessionArchived`, Codex `thread/unarchive`)
  before resuming it, and a refused restore does not resume or move the link. The resume tab id is derived from the link
  (`design-resume-<linkId>-<hash of its current tab id>`). `design_session_resume`
  then, in the canvas lane, compare-and-sets the link's tab, resumes the
  recorded session for the new tab through the ordinary native-agent resume
  (`resumeProjectionSession`: environment ownership, a provider that still has
  the session, never an empty replacement) and moves the link only when that
  succeeded, returning the live session the tab adopts. A lost conversation is
  therefore an error in the dialog, not a broken tab. Two clients resuming
  together send the same tab id: the second waits on the lane and gets the
  first one's link and live session without resuming again. The tab opens with
  `resumeSessionId` and `requireExistingResumeSession` and no initial prompt,
  so the design's opening prompt is never sent again.

Links, Resume and two clients resuming at once were qualified live with Claude
and Codex on 2026-10-24 and 2026-10-25; that record is in the retired to-do
0038 (`git show 14df96544:docs/todo/design-canvas/0038-design-agent-conversation-links.md`).
The archived state has deterministic and browser coverage; its live check
with a real archived Codex thread is in the
[manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md).

## Bounds

256 live canvases, 64 frames per canvas, 256 KiB HTML per frame, 4 MiB
portable document, 6 MiB private record, 4,096 × 4,096 frame viewport, 5,000
DOM elements, 64 style properties per operation, 16 concurrent MCP requests,
16 admitted render jobs, 32 pending iframe requests, 8 MiB per PNG. Logs carry
operation kinds, counts, timings and reason codes, never design content,
credentials or prompts.

## Tests

Backend: the `core/design/` `service`, `operations`, `intents`, `history`, `lifecycle`,
`sync`, `records`, `exports`, `export-writer`, `renderer`, `mcp`,
`cross-process`, `host-file` and `session-links` tests,
`commands-registry-teardown` (a closing tab records its session on design
links, including from the identity kept on the mapping when the session is
gone), `storage-native-agent-resume-identity` and `commands-registry-design` (a happy-dom runtime renderer from `design/test-support.ts`
plus one real-Chromium renderer test). Backend tests reach a storage bound
(change log, history entries) by lowering it with `withDesignLimit`, not with
hundreds of fsynced commits, and check the shipped bound in memory. A test
that counts hints after an HTML edit first holds the background validation
with `renderer.block`. Web: controller, intent merge, drafts, viewport,
canvas tab, inspector, layer tree, history/export, entry, agent context and
`design-session-links` (link states, resume tab ids, concurrent resume)
tests. Browser: `e2e/DesignCanvas.spec.ts` runs the real runtime and
command registry at desktop and phone widths;
`e2e/agent-testing/design-canvas.spec.ts` runs against the isolated stack, and
`e2e/agent-testing/design-live.spec.ts` (opt-in, `ORKESTRATOR_AGENT_TEST_LIVE_DESIGN=1`)
runs the full tool cycle, Ask agent, an approval, the handoff and closing and
resuming the design conversation with real Claude and Codex.
`e2e/agent-testing/design-resume-clients-live.spec.ts` (opt-in,
`ORKESTRATOR_AGENT_TEST_LIVE_DESIGN_RESUME=1`) has two signed-in browser clients
press Resume on one closed design conversation at once and checks they get
one tab and one live session.
`e2e/DesignCanvasAccessibility.spec.ts` runs a keyboard-only journey with focus
survival, accessibility-tree, label-in-name, reduced-motion, 200% and 400% zoom
and narrow-pane checks, and
`e2e/agent-testing/design-canvas-electron.spec.ts` (`mise run test:agent:electron`)
drives the canvas in the real Electron window, with the renderer served by
Vite; `design-canvas-packaged-electron.spec.ts`
(`mise run test:agent:electron:packaged`, after
`mise run package:linux:unpacked:test`, or `mise run package:mac:unpacked:test`
on macOS, an ad-hoc identity that is never signed with a Developer ID or
notarised) runs the same journey against the packaged
Linux or macOS app and its `file://` renderer, with hidden windows on macOS.
`design-canvas-renderer-pairing-electron.spec.ts` (same task) runs that journey
across versions through the connection manager: this checkout's packaged
renderer on a published `orkestrator` backend from npm (2.22.3 by default,
`ORKESTRATOR_PAIRING_RELEASE`), and, when `ORKESTRATOR_PAIRING_OLD_APP_EXECUTABLE`
names a published desktop build, that build's renderer on this checkout's
backend, driven over CDP because its inspect fuse is off. After the canvas
journey each direction runs Ask agent (a new Claude conversation, one turn,
the link, closing its tab) on a real Claude Code whose model calls go to a
loopback Anthropic endpoint (`fake-anthropic-model.ts`) with a fixture key,
and the second direction then resumes that conversation in this checkout's
renderer on the same backend (`design-agent-pairing-journey.ts`). The
interrupted
migration (record written, legacy file not yet moved) is not reachable from
outside the process and is covered only by "an interrupted migration (record
written, legacy not retired) reads the record" in `records.test.ts`. The opt-in
`core/design/export-container.test.ts` (`ORKESTRATOR_TEST_DOCKER_DESIGN_IMAGE`)
exports from a running container and interrupts it.
`e2e/DesignAgentLinks.spec.ts` renders the Ask agent dialog's closed-link
states, archived included, against fixed backend answers.
`scripts/benchmark-design.ts` measures transfer, commit and latency fixtures,
and `e2e/perf/design-canvas-perf.ts` measures the client in a real browser.
Its leak check compares the cycle halves' maximum for every signal except
`jsEventListeners`, where it compares their minimum. That CDP counter also
counts listener objects no event target holds any more until Blink finalizes
them, and a forced collection does not wait for that, so on Linux a sample
reads one of two fixed values at random (+25, +55 and +85 listeners at 1, 16
and 64 frames, measured 2026-11-11 on beelink2). Two readings taken a second
apart with no page action between them flip between the two values; every
`addEventListener` registration in the page and every listener on its nodes
(DOMDebugger, iframes included) stayed constant in every sample; and a heap
snapshot taken at a high reading held the low number of registered
listeners. A leak raises the floor and still fails the check. A second half
that read only the high value looks the same, so before failing on the floor
the check takes up to eight more readings a second apart with no page action
between them; noise drops one back to the floor and clears the verdict, a leak
keeps every one raised. A false failure then needs all six late samples and all
eight readings to be high (about one run in 16,000 at even odds, against about
one in 65 for the floor rule alone; `tests/unit/design-canvas-leak-verdict.test.ts`
simulates both). With the
2026-10-22 parameters (3 runs × 1, 16 and 64 frames, 12 cycles) on beelink2 on
2026-11-11, the floor rule passed all nine runs, including runs that read both
values; one 16-frame run failed instead on `cdpFrames` reading 10 rather than 9
on two late samples, on a heavily loaded host. That extra frame was a product
retention, found and fixed on 2026-11-14 (to-do 7820, retired; see
[Evidence of 2026-11-14](#evidence-of-2026-11-14)): a culled design iframe's
closed `DesignFrameBridge` stayed reachable from the previous render of
`DesignFrameView` (React keeps it until the component renders again, and its
closures share that render's scope, which holds the bridge), and the bridge
still held the frame's `Window`, which kept the frame's `blink::RemoteFrame`
alive. `close()` now drops the `Window`, so `cdpFrames` keeps its strict
peak rule. `--listener-census` (with `--heap-snapshots <dir>`) repeats these
investigations; beside each sample it also records where the frames
`cdpFrames` counts are (the renderer's frame tree, the iframe elements owning
a frame, the browser's out-of-process iframe targets, and `Frames` read again
once settled). It perturbs the page, so it is never used for measured
numbers. The 2026-11-06 failures that prompted it are in the retired to-do
7440 (`git show 14df96544:docs/todo/design-canvas/7440-design-perf-listener-count-two-states.md`).

## Qualification

To-do 0036 collected the evidence that the canvas works beyond its unit and
browser tests; it was retired on 2026-11-13. Its record up to 2026-11-06,
with every command, host and figure, is in Git history
(`git show 17d28238c:docs/todo/design-canvas/0036-design-canvas-qualification.md`);
the 2026-11-13 runs that closed it are in
[Evidence of 2026-11-13](#evidence-of-2026-11-13) below. In short:

- **Live agents.** `design-live.spec.ts` passed for Codex (2026-10-18) and
  Claude (2026-10-21, twice): create, inspect, refine, capture,
  `save_canvas`, Ask agent on a stale selection, an approval across an
  environment switch and the implementation handoff.
- **Container export.** `export-container.test.ts` passed on Docker Desktop
  for macOS (2026-10-22) and Docker Engine on Linux x64 (2026-11-01), and runs
  in the Linux Engine CI workflow on amd64 and arm64; the Docker fixture spec
  passed on both. Rootless Engine and SELinux hosts are not covered.
- **Electron.** The Vite-served Electron spec (2026-10-22, which found and
  fixed the Ctrl/⌘+0 defect), the packaged Linux app (2026-11-02) and an
  unsigned macOS bundle (2026-11-13, 8 of 8 after flake 9969). Ctrl/⌘+0
  passed in all 17 runs of the packaged spec on macOS that reached it.
- **Mixed versions.** The backend over one data directory with the published
  2.22.3 (2026-10-25, `scripts/qualify-design-mixed-versions.ts`): upgrade,
  legacy migration, the downgrade fence and export-then-import. The renderer
  pairing (2026-11-13, both directions with v2.22.3) passed and found no
  compatibility defect. In the v2.22.3 renderer ⌘0 still leaves a focused
  canvas off 100%, which is the defect fixed on 2026-10-22. Ask agent and
  Resume across the same pairing passed on 2026-11-14
  ([Evidence of 2026-11-14](#evidence-of-2026-11-14)).
- **Accessibility.** The automated keyboard, focus, tree, zoom and
  narrow-pane pass (`DesignCanvasAccessibility.spec.ts`).
- **Client performance.** Apple M5 Max with Chrome (2026-10-22) and a busy
  Linux host with Chromium (2026-11-01, rerun 2026-11-06, with a 100-cycle
  64-frame retention run that converged). Chrome stands in for the Electron
  renderer; the harness has no Electron mode, and one is built only if an
  Electron-only regression is reported. The numbers are host evidence, not
  thresholds.

Still to do by a person, in the
[manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md):
the native menu key equivalents on macOS, a screen-reader pass, a slower
laptop, the M5 Max retention run, and the decisions on library thumbnails
and a cross-environment transfer UI.

### Evidence of 2026-11-13

0036 tasks 3 and 6, from `17d28238c`, on an Apple M5 Pro (18 cores, 64 GiB),
macOS 27.2, Bun 1.4.4 and Playwright 1.65.0, shared with nine other builds
(load averages 35 to 96, so no timing here is a reference figure). Every app
ran on a disposable agent-test profile under a temporary root with HOME, the
XDG roots and an allowlisted environment; every backend had its own temporary
data directory on loopback, never ports 34121, 34122 or 45507, with no agent
credentials and no provider turn. Nothing was signed with a Developer ID or
notarised.

**macOS packaged bundle (task 3).**

- `mise run package:mac:unpacked:test` wrote
  `release/packaged-test/mac-arm64/OrkestratorV2.app` with an ad-hoc
  signature and no team identifier (`mac.identity` is `-` and
  `CSC_IDENTITY_AUTO_DISCOVERY=false`, so no keychain was read).
- `design-canvas-packaged-electron.spec.ts` first failed its resources check,
  which assumed the Linux layout; `packagedResourcesPath` fixed it. It then
  passed (31.0 s, Electron 45.2.3, Chromium 156.0.8078.80): `app.isPackaged`,
  the `file://…/Contents/Resources/web/index.html` window, `userData` inside
  the profile, open, drag, keyboard (Ctrl/⌘+0 included), export, download and
  host import.
- `--repeat-each=8` failed 4 of 8 at load 44–96 on two journey races (the
  export step read **File name** before the preview filled it; a startup
  dialog took the Expand click), fixed and recorded as flake
  [9969](../tests/flaky-tests/design-canvas-and-artifacts/9969-design-electron-journey-file-name-and-expand-races.md).
  Afterwards it passed 8 of 8 (20.3–30.3 s), and 2 of 2 in the final run.
- Ctrl/⌘+0 passed in all 17 macOS packaged runs that reached it.
- The product installs no `will-download` handler on the window's session
  (only the artifact host's isolated session has one, and it cancels
  downloads), so the Save dialog is Electron's own. The journey asserts that
  before installing its own handler, in the Vite-served and both packaged
  specs.
- The app ran with `ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS=1`; no window
  reached the desktop.

**Renderer pairing with v2.22.3 (task 6).**
`design-canvas-renderer-pairing-electron.spec.ts` makes a headless backend of
the other version the window's active connection with
`connections.connect({ address, token })`, waits until `get_app_version` from
the page answers that backend's version, then runs the shared Electron design
journey, so every design command goes to that backend.

| Direction | Renderer | Backend | Result |
| --- | --- | --- | --- |
| New renderer, old backend | this checkout's packaged-test macOS app (2.38.1-beta) | `orkestrator@2.22.3` from npm (`--ignore-scripts`), `serve` | passed 3 of 3 (34.3–40.4 s): open, drag, keyboard with Ctrl/⌘+0, export with the byte and digest check, download, host import |
| Old renderer, new backend | the published v2.22.3 macOS app (Electron 44.7.0) from the GitHub release zip, unpacked with `ditto -x -k` | this checkout's `apps/backend/src/main.ts` (2.38.1-beta) | passed 3 of 3 (31.4–42.4 s): open, drag, keyboard, export with the byte and digest check, host import |

- Against 2.22.3 the new renderer logged "Unknown backend command" for
  commands newer than that release and showed the "backend is out of date"
  notice, as designed; the canvas worked throughout.
- Harness findings, not product defects: page commands fail authentication
  until the window reloads onto the new connection, so the spec reloads until
  the version answers; and an isolated backend with no agent makes the
  renderer open its blocking "AI CLI Required" dialog, so each backend gets a
  toolchain directory holding a stub `pi` that only exits 1. The 2.22.3
  backend also left `git fsmonitor--daemon` processes behind on macOS; the
  pairing backends now run with `core.fsmonitor=false`.
- The v2.22.3 app has its Node inspect fuse off, so it was driven over CDP
  (`--remote-debugging-port=0`) without main: no window size, no download save
  path (the download step is skipped), and the page's CSS width stands in for
  the window zoom factor. Two checks that predate it are skipped, neither of
  which depends on the backend: the app-wide shortcuts dialog (#1240) and
  Ctrl/⌘+0 resetting a focused canvas. In v2.22.3, ⌘0 left the canvas at 77%
  in all three runs, the zoom-listener defect fixed on 2026-10-22, after
  v2.22.3 shipped on 2026-10-17. Its window showed on the desktop during each
  run.
- Final run: `ORKESTRATOR_PAIRING_OLD_APP_EXECUTABLE=<app>/Contents/MacOS/OrkestratorV2
  mise run test:logged -- --name design-final -- bunx playwright test --config
  e2e/agent-testing/playwright.packaged-electron.config.ts
  design-canvas-packaged-electron.spec.ts
  design-canvas-renderer-pairing-electron.spec.ts --repeat-each=2` passed 6 of
  6 (237.4 s, load 50–75).
- Not covered: Ask agent and Resume (run on 2026-11-14, below), the Linux
  packaged app in the pairing (the spec supports it; not run) and a v2.22.3
  AppImage.

### Evidence of 2026-11-14

To-do 8011 (retired 2026-11-14; its record is
`git show dc90609bf:docs/todo/design-canvas/8011-design-ask-agent-and-resume-across-versions.md`),
on arktech-mini (Apple Silicon, macOS 27.2, load averages 8 to 21 from other
workers), at `dc90609bf` plus this change, with Playwright 1.65.0. Every app
and backend ran as on 2026-11-13: disposable agent-test profiles under a
temporary root, loopback backends with their own data directories, never
ports 34121, 34122 or 45507, no agent credentials and no real data
directory.

**Ask agent and Resume across the pairing.** Each pairing backend's toolchain
directory now also holds this checkout's pinned Claude Code (2.1.319,
downloaded and hash-verified by the toolchain installer into
`output/agent-testing/design-pairing-toolchain`, never the real data
directory's `toolchains/`). Its `CLAUDE_CONFIG_DIR` is a run-unique directory
whose `settings.json` sends every model call to a loopback Anthropic endpoint
in the Playwright process (`fake-anthropic-model.ts`) with a fixture key, and
session-title generation is off, so the only model calls are the
conversation's. Naming the directory explicitly also means Claude's macOS
Keychain lookup is under a service named after that run-unique path, which no
existing Keychain item has. No login, no billed turn.

| Direction | Ask agent | Closed link | Resume |
| --- | --- | --- | --- |
| This renderer (packaged-test, 2.38.2-beta), `orkestrator@2.22.3` backend | a new Claude conversation opened with the design context (frame and canvas ids) in its draft, the canvas recorded the link, and **Start agent** sent exactly one turn carrying it; the answer showed in the transcript | the backend answered `design_session_link_states` with "Unknown backend command"; the renderer mapped that to `unsupported` and listed the link as "Closed — conversation ended" with no Resume | not offered: 2.22.3 has no `design_session_resume` |
| v2.22.3 renderer (published macOS app, over CDP), this backend | the same, through v2.22.3's dialog (which shows no chip for the context; the turn's prompt carried it) | the backend recorded the session on the link at tab teardown (`missing` with a `sessionId`); v2.22.3 lists the link as "Closed — conversation ended" from its own layout, with no Resume (it predates it) | this checkout's packaged renderer, connected next to the same backend, listed it as "Closed — can be resumed"; **Resume** reopened it in one `design-resume-…` tab with its transcript, the link moved there, and no model call was made |

- So Resume across versions runs in one place only: a link made by an
  older renderer, resumed after the desktop is upgraded. Neither pure pair
  can press it, because v2.22.3 has it on neither side. No compatibility
  defect was found.
- Both renderers open "Claude Code Is Not Logged In" for a CLI with only an
  API key in its settings; the notice is non-blocking and the spec dismisses
  it, as the other fake-model specs do. Both releases retitle the tab after
  the first message ("Design chat 3", then the first-message title), and
  v2.22.3's tabs have no `tab` role, so the spec follows the tab by its close
  control.
- `ORKESTRATOR_PAIRING_OLD_APP_EXECUTABLE=<app>/Contents/MacOS/OrkestratorV2
  mise run test:logged -- --name pairing-agent-final -- bunx playwright test
  --config e2e/agent-testing/playwright.packaged-electron.config.ts
  design-canvas-packaged-electron.spec.ts
  design-canvas-renderer-pairing-electron.spec.ts --repeat-each=2` passed 6 of
  6 (178.4 s; the pairing tests 31.5–47.2 s). The Vite-served
  `design-canvas-electron.spec.ts`, which shares the refactored journey
  setup, passed once.
- Not covered: Codex conversations (Ask agent also offers Codex; only Claude
  ran), and, as before, the Linux packaged app in the pairing.

**The extra `cdpFrames` frame.** To-do 7820 (retired 2026-11-14; its record
is `git show dc90609bf:docs/todo/design-canvas/7820-design-perf-cdp-frames-transient.md`)
asked what the frame was that the 2026-11-11 beelink2 run counted on some
samples and not others, and whether the leak check should tolerate it.
`e2e/perf/design-canvas-perf.ts --listener-census` now records, beside each
sample, the renderer's frame tree, the iframe elements that own a frame, the
browser's out-of-process iframe targets, and `Frames` read again after two
more forced collections. Runs used Google Chrome 157.0.8103.51, headless,
the 2026-10-22 parameters (3 runs, 12 cycles) with `--skip-library`, at
load averages 7 to 22; every run's leak check converged, before the fix and
after.

| Build | Runs | Samples one frame over (main + live iframes) |
| --- | --- | --- |
| Before the fix (web code at `dc90609bf`) | 3 × (1, 16, 64 frames × 3) and 16 frames × 3 at 3 cycles | none at 1 frame; at 16 and 64 frames, 15 of 21 runs. Some read one over from cycle 0 and dropped back, some went over at cycle 1 and stayed for the whole run; never two over. Every run still converged, because no early/late split landed on it |
| After the fix | 2 × (1, 16, 64 frames × 3) | none: 234 of 234 samples exact, 0 of 12 runs at 16 and 64 frames |

- Where the extra frame was: no iframe element owned it, the renderer's
  tree and the browser's targets did not hold it, and it survived the two
  extra collections, so it was a detached frame object not yet destroyed.
- What kept it: heap snapshots (`--heap-snapshots`) taken at readings one
  over held nine `blink::RemoteFrame` objects and only eight
  `RemoteFrameClientImpl`, `RemoteFrameView` and `LayoutIFrame` objects. The
  clientless RemoteFrame's retainer path, in both snapshots examined: a React
  props object → an event-handler closure (`onSelect` in one, `onPointerDown`
  in the other) → that render's closure scope → a `DesignFrameBridge`
  (minified) → its private `#target`, the culled frame's `Window` → the
  RemoteFrame. A snapshot at a reading that was not over had no clientless
  RemoteFrame.
- Fix: `DesignFrameBridge.close()` drops the `Window`
  (`frame-bridge.ts`, tested in `frame-bridge.test.ts` with a `WeakRef`; the
  test fails without the fix). The leak check's `cdpFrames` rule stays
  strict (halves' peaks, no slack).
- Decision: fix the retention rather than tolerate it in the check. Comparing
  the halves' minimums, as for `jsEventListeners`, would have passed the
  beelink2 pattern but failed a frame that goes over mid-run and stays (seen
  here from cycle 1), and a slack of one frame would have hidden a one-frame
  leak in a 12-cycle run. Neither was needed once the frame was released.
  This is a check on the measurement, not a product decision.
