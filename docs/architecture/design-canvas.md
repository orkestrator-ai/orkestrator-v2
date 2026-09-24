# Design canvas

Status: Living — HTML/CSS design workspace with recoverable operations
(protocol v2). Implementation plan and evidence:
[`docs/improvements/design-space/plan/`](../improvements/design-space/plan/00-index.md).

Use **New design workspace** (the paintbrush in the environment toolbar). The
dialog has three modes: **New design** (optionally with Claude or Codex, or a
blank canvas with no agent), **Open** (a searchable library of this
environment's designs, including the recycle bin) and **Import** (`.orkdes`).
A readiness panel reports backend storage, the headless Chromium renderer and
agent availability separately; a missing renderer never hides existing work.

The chat keeps the existing approval, question, cancellation, transcript and
background-session behavior. Closing or hiding the canvas does not stop its
agent or any admitted edit. A canvas tab stores only
`designCanvasData: { canvasId }`; HTML never enters the pane layout.

## Documents, records and identities

The portable document is unchanged: `format: "orkdes"`, `version: 1`, id,
environmentId, name, revision and frames (id, name, x, y, width, height, HTML,
revision). `.orkdes` import/export stays strictly version 1.

The backend keeps each canvas in a **private record**
(`design-canvases/<id>.orkrec`, `apps/backend/src/core/design-records.ts`)
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

Edits are **recoverable operations** (`design-service.ts`,
`design-execute.ts`, `design-apply.ts`):

1. **Prepare** validates a bounded descriptor (kind, input, observed
   preconditions, optional gesture/correlation ids) and writes it to a small
   per-canvas pending file. It never edits the canvas and returns an opaque
   token bound to environment, canvas, descriptor digest and record
   incarnation. A repeated prepare with the same correlation id returns the
   same token. Creating a canvas reserves its identity and quota in a
   provisional record.
2. **Execute** runs a token once. The computation reads an immutable snapshot;
   Chromium work happens with no lock held. The result is re-verified against
   the latest record (revisions, structure identity, deletion) under the
   canvas lane and committed atomically with its receipt. A repeated execute
   returns the receipt; unknown/expired tokens can never create work.
3. **Status** is side-effect free. **Cancel** works only before execution.

Outcomes: `committed`, `no-op` (equal values: no revision, history or content
hint), `rejected` (typed failure), `canceled`, `interrupted` (the backend
restarted before commit — never replayed), `expired`, `unknown`. Failures carry
a code (`conflict`, `invalid-input`, `invalid-content`,
`renderer-unavailable`, `capacity`, `deadline`, `deleted`, `not-found`,
`expired-operation`, `unknown-outcome`, `export-collision`,
`history-ineligible`, …), a safe message and a retry class; the legacy
`Design revision conflict:` message prefix is preserved.

Preconditions are exact. Selector edits carry the frame revision **and**
structure identity observed when the element was inspected; a structural
change conflicts even if the selector still matches. The client rebases a
precondition only across its own acknowledged commits (a proven chain); any
other writer's change surfaces as a conflict. Batches (≤16 same-canvas
operations, ≤512 KiB) validate everything, commit once, advance each changed
frame once and create one history entry.

Legacy one-shot actions (`design_action`, MCP tools) are prepare+execute
adapters with their original response shapes.

### Concurrency and bounds

Per-canvas commit lanes plus a small global guard (quota reservation,
environment deletion). Lock order is global guard, then one lane; nothing
waits for the renderer or the global guard while holding a lane. Admission:
32 operations, 8 per canvas, 8 MiB decoded payload; 8 prepared per canvas;
6 MiB per record. Environment deletion fences the environment before removing
records, so a late render can never resurrect a design.

## Renderer

`design-renderer.ts`/`design-render-queue.ts` run one worker (≤16 admitted
jobs) with fair round-robin across environments and canvases, priority
(interactive > validation > background) with aging, and phase deadlines
(queue 15 s, launch 15 s, context 5 s, run/capture 15 s, cleanup 3 s, overall
45 s). Each job gets a fresh isolated context: all requests aborted, service
workers blocked, downloads disabled, the nonce CSP bootstrap, deterministic
viewport/scale/color scheme/reduced motion. Browser generations are tracked so
a late disconnect from an old process cannot retire a new one; a dead
generation fails its jobs exactly once. Health distinguishes missing
executable, launch failure, saturation, recovery and ready, and is probed on
demand (cached 60 s).

Playwright exposes no browser process handle, so a hung `close()` is bounded
by the cleanup deadline rather than a process kill.

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

History (`design-history.ts`) is persistent and bounded (50 entries and
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
version and generation. `design_sync` answers from one immutable record:
`unchanged`, `status` (metadata only), `delta` (exact base → current revision;
geometry patches omit HTML; HTML only for new content), `reset` (generation,
future cursor, expired range, too large: >256 KiB or >64 frames), or a
snapshot/deleted/missing/problem result. The client installs a delta only when
generation and base match exactly, validates every patch first, and applies it
in one store update; otherwise it fetches a snapshot.

## Client

`design-controller.ts` keeps one projection, hint listener and intent queue
per backend/environment/canvas (`apps/web/src/stores/designStore.ts`).
Activation subscribes before reading; a 3 s cursor check repairs lost hints
while visible; with no visible view, polling stops but queued and admitted
work continues. `refresh()` resolves only after a sync cycle that started
after the call. Tokens are persisted with their drafts
(`design-drafts.ts`, ≤8 per canvas, 32 per client, 2 MiB) before execution;
restored drafts never run without **Resume draft**. A lost execute response is
reconciled by status, never by preparing again. A failure pauses later edits
in the same lane only. The footer separates **Saved in workspace**, pending
edits, **Needs review** and **Exported revision N to path**.

The canvas renders only frames near the viewport with at most eight live
iframes (pinned frames never cull mid-gesture; the rest show placeholders).
Iframe HTML is replaced only when content identity changes; geometry updates
move chrome only. The layer tree is lazy, paged (≤200 nodes/128 KiB per page,
cursors bound to structure) and virtualized.

Navigation: Fit all (Shift+1), Zoom to selection (Shift+2), 100% (Ctrl/⌘+0),
pointer-anchored wheel/pinch zoom, Shift+wheel and middle-drag pan, keyboard
move/resize of frames (Arrow, Alt+Arrow, Shift for 10 px), numeric frame
fields and device presets, Escape priority (gesture → preview → selection →
drawers), design undo only when the canvas owns the shortcut. Narrow panes use
Layers/Inspector drawers. **Preview** mode routes scroll and hover into the
frame while links, forms, navigation, scripts and network stay blocked; Escape
inside the frame returns to Inspect.

## Save, export and download

Export (Save As) writes one exact committed revision to a repository-root
`.orkdes` path (`design-exports.ts`, `design-export-writer.ts`). The default
name is the sanitized design name plus a short canvas-id suffix. The write
uses a same-directory temporary file, sync and `link()` for new files (atomic
no-clobber) or a fingerprint-checked `rename()` for an explicit replacement;
container exports run the same protocol through an owned helper inside the
workspace, streamed over stdin. Intent (path, revision, digest) is recorded
first; a lost outcome is reconciled by comparing the destination's exact
digest, never by writing again. A replacement keeps a private backup of the
overwritten bytes (≤16 per canvas). The replace path is check-then-rename, not
an atomic compare-and-swap against arbitrary external writers. Filesystems
without hard links cannot export new files.

Download fetches a committed snapshot and names its revision.

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

A canvas remembers bounded links (≤8) to the conversations that worked on it
(environment + tab id, platform, role design/implementation). **Ask agent**
adds a removable, revisioned design-context annotation to a conversation's
draft without sending it; the agent is told to re-read the canvas before
editing, and every edit is still revision checked. **Use as implementation
reference** prepares a reviewable handoff draft for an ordinary conversation;
nothing is submitted, approved, committed or deployed automatically. Closing a
native tab ends its conversation, so a link to a closed tab offers a new
conversation instead of a silent replacement.

## Bounds

256 live canvases, 64 frames per canvas, 256 KiB HTML per frame, 4 MiB
portable document, 6 MiB private record, 4,096 × 4,096 frame viewport, 5,000
DOM elements, 64 style properties per operation, 16 concurrent MCP requests,
16 admitted render jobs, 32 pending iframe requests, 8 MiB per PNG. Logs carry
operation kinds, counts, timings and reason codes, never design content,
credentials or prompts.

## Tests

Backend: `design-service`, `design-operations`, `design-history`,
`design-lifecycle`, `design-sync`, `design-records`, `design-exports`,
`design-export-writer`, `design-renderer`, `commands-registry-design` and
`design-mcp` tests (a happy-dom runtime renderer from `design-test-support.ts`
plus one real-Chromium renderer test). Web: controller, drafts, viewport,
canvas tab, inspector, layer tree, history/export, entry/library and agent
context tests. Browser: `e2e/DesignCanvas.spec.ts` runs the real runtime and
command registry at desktop and phone widths;
`e2e/agent-testing/design-canvas.spec.ts` runs against the isolated stack.
`scripts/benchmark-design.ts` measures transfer, commit and latency fixtures.
