# Design Space: improvement assessment

Date: 2026-09-21  
Reviewed revision: `88c2f9cc`  
Scope: the feature called **Design workspace** in the UI and **Design canvas**
in the implementation. This is an investigation and proposed backlog; no
application code was changed.

The highest-value work is to make editing trustworthy, make saved work easy to
resume, and reduce the cost of small changes. The existing backend ownership
and reconciliation architecture should be retained.

## Evidence and limitations

This assessment traces the launch flow, canvas and inspector components,
iframe runtime, command registry, persistence service, backend renderer, MCP
tools, and relevant tests. Findings marked **source-confirmed** describe paths
present in the code; they are not claims of observed production incidents.
Product proposals are distinguished from defects. Performance estimates are
structural bounds, not measured latency or memory results.

Two focused validation runs passed:

```sh
mise run test:logged -- --name design-space-backend-audit -- \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./src/core/design-service.test.ts ./src/core/design-renderer.test.ts \
  ./src/core/commands-registry-design.test.ts ./src/core/design-mcp.test.ts \
  --parallel=1 --only-failures

mise run test:logged -- --name design-space-web-audit -- \
  bun test --cwd apps/web \
  ./src/components/design/latest-mutation-queue.test.ts \
  ./src/components/design/design-launch.test.ts \
  ./src/components/design/frame-bridge.test.ts \
  ./src/components/design/DesignFrameView.test.ts \
  --parallel=1 --only-failures
```

A separate, in-memory probe against the actual `LatestMutationQueue` also
reproduced the discarded-edit behavior in R2 below. It added no test files.
Existing browser specifications were read, but interactive browser/Electron
QA, the full repository suite, actual agent generation, and performance
benchmarks were not run. In particular, the stale-selector scenario in R1
still needs an end-to-end regression test.

## Current experience and strengths

The paintbrush opens a dialog for creating a named canvas with Claude or Codex,
opening an existing canvas, or importing `.orkdes`. Creation launches an
ordinary native-agent chat and a canvas in a split pane. The canvas offers
frames, pan/zoom, a layer list, element inspection, style changes, resizing,
repository save, and download.

Several important properties already exist:

- Documents live in the backend and survive renderer/tab lifetimes. Agent
  editing and capture do not require a visible canvas.
- Writes are serialized and revision checked. Document replacement uses a
  temporary file, file sync, and rename before emitting a change notification.
- Clients subscribe before reading, reconcile on activation/reconnection, and
  check their cursor every three seconds while active. Generation changes and
  expired event ranges request snapshots.
- Live events are bounded, content-free hints. HTML is excluded from pane
  layout persistence.
- Authored scripts and external resources are disabled. Client previews and
  backend operations share the runtime, and MCP requests enforce environment
  ownership.
- Document size, frame count, render queue, write queue, and iframe request
  limits already constrain resource use.

These are valuable safeguards, not areas to replace with renderer-only state
or optimistic writes without reconciliation. See the
[architecture guide](../architecture/design-canvas.md),
[service](../../apps/backend/src/core/design-service.ts),
[runtime](../../packages/protocol/src/design-runtime.ts), and
[MCP authorization boundary](../../apps/backend/src/core/agent-tools.ts#L708).

## Priorities

P1 means address before encouraging heavier editing or more concurrent users;
P2 means the next usability/performance iteration; P3 means follow after
measurement or user validation. Effort is relative: S is localized, M crosses
several owners, L changes persistence or workflow contracts.

| ID | Priority | Improvement | Main benefit | Effort |
| --- | --- | --- | --- | --- |
| R1 | P1 | Preserve the revision and target of an edit | Prevent applying stale intent to changed HTML | M |
| R2 | P1 | Preserve distinct queued operations and reconcile their results | Prevent silent edit loss and confusing failures | M |
| R3 | P1 | Make repository saves collision-safe and explicit | Protect existing exports; clarify what was saved | M |
| R4 | P1 | Bound renderer lifetime and isolate unrelated writes | Keep one slow render from delaying every canvas | M–L |
| U1 | P2 | Add recovery history and complete canvas/frame management | Let users experiment and recover | L |
| U2 | P2 | Make entry, readiness, and reopening understandable | Reduce blocked starts and lost context | M |
| U3 | P2 | Improve direct manipulation and navigation | Reduce repeated selection and navigation work | M |
| U4 | P2 | Connect agent conversations to selections and saved work | Reduce prompting overhead | M |
| R5 | P2 | Make rendering failures and document deletion explicit | Recover cleanly without misleading stale screens | M |
| E1 | P2 | Transfer and render only what changed | Reduce bandwidth and editing latency | M |
| E2 | P2 | Render visible frames and expandable layer branches | Keep larger canvases responsive | M |
| E3 | P3 | Reduce disk/render work and large agent responses | Improve sustained editing efficiency | M–L |

## Reliability findings

### R1. The UI can replace an edit's original revision

**Source-confirmed, high priority.**
[The mutation worker](../../apps/web/src/components/design/DesignCanvasTab.tsx#L130)
replaces a request's `expectedRevision` with the latest frame revision in
`canvasRef`. This applies to selector-based style edits as well as geometry.
The backend's compare-and-swap check remains correct, but the client has
changed the precondition it sends.

Example: a user starts resizing the second element at revision 5. An agent
inserts a new element before it; the client receives revision 6 before the
pointer is released or the queued operation runs. The resize still carries
the original selector, but the worker can send revision 6. The runtime uses
[positional `:nth-child` selectors](../../packages/protocol/src/design-runtime.ts#L29),
so the request can now target a different element and pass the backend check.
The inspector's stale warning does not protect an already-started gesture or
queued request.

Preserve the original revision for selector-based operations. On conflict,
retain the user's draft, fetch the authoritative snapshot, and offer explicit
reselection/reapplication. Stable element identities would improve selection
continuity, but must not replace revision validation. If geometry operations
are rebased, define the allowed cases explicitly and distinguish this client's
acknowledged predecessor from another writer's edit.

**Acceptance:** start a drag, replace/reorder the HTML from another client,
deliver the new snapshot, and release the drag. The old intent must never
change a newly matching element. Repeat with the operation waiting in a queue.

### R2. Coalescing by frame can silently discard a different edit

**Reproduced at queue level; integration consequences are source-confirmed.**
[The queue](../../apps/web/src/components/design/latest-mutation-queue.ts)
retains one pending request per key, and
[the canvas](../../apps/web/src/components/design/DesignCanvasTab.tsx#L152)
uses only `frameId` as that key. Every new pending request replaces the entire
previous request for that frame, regardless of action or changed properties.

Probe: block an operation on frame A, enqueue `{x:100,y:50}` for frame B, then
enqueue `{width:900,height:600}` for frame B. After release, the queue executes
the blocking operation and the resize; the move is absent. The existing queue
test intentionally verifies newest-request behavior, but not whether two
requests express interchangeable intent. Frame dragging remains available
while another mutation is busy.

Coalesce only compatible absolute updates within the same gesture or operation
family. Preserve independent geometry fields where merging is safe; preserve
ordered semantic edits where it is not. Do not merge selector edits across
unverified content revisions. Give the queue explicit count/byte bounds and
visible pending, committed, conflicting, and failed states.

There is a related completion gap: the worker discards successful mutation
responses and then awaits `sync.current`. An already-running refresh returns
early after setting `again`, and activation cleanup sets `sync.current` to
null. Consequently, the next queued operation is not guaranteed to see its
predecessor's acknowledged revision. Switching tabs does not stop the backend
agent, but pending UI edits need a defined lifecycle too.

Use acknowledged responses to advance the local mutation chain, and let
callers await reconciliation actually finishing. Keep submitted work owned
outside the mounted view or expose precisely which drafts were not submitted.
For lost responses, use bounded request IDs/operation receipts to distinguish
committed from unknown outcomes; revision checks alone cannot explain whether
the user's previous operation succeeded. Never blindly retry an uncertain
append/create operation.

**Acceptance:** slow one operation, move and resize another frame, then switch
tabs before completion. Both intents must persist or be explicitly rejected;
returning must show the authoritative result. Also test response loss after a
successful commit and overlapping refreshes.

### R3. Repository saves can overwrite another canvas's export

**Source-confirmed.** The UI
[derives the filename solely from the canvas name](../../apps/web/src/components/design/DesignCanvasTab.tsx#L167).
The default is repeatedly `Untitled design`. Different names can also collapse
to the same sanitized filename. The
[save command](../../apps/backend/src/core/commands-registry-design.ts#L42)
does not associate a path with a canvas or check the existing target's identity.
The [local writer](../../apps/backend/src/core/shell.ts#L225) permits overwrite;
the [container writer](../../apps/backend/src/core/commands-registry-terminal.ts#L940)
redirects directly into the destination.

Offer Save/Save As with an explicit path, use a collision-safe initial name,
and detect an existing export belonging to another canvas. Remember the chosen
path separately from the portable document identity. Repository export should
use atomic replacement, including the container path, so an interrupted write
does not leave a truncated file.

The backend already persists every committed edit, but the UI only announces
`Saved <filename>` for a repository export. Distinguish **Saved in workspace**
from **Exported revision N to path**. Show when subsequent changes make the
export outdated. Track save and edit activity independently rather than sharing
the same `busy` boolean. Download should either wait for pending edits or
explicitly identify the committed revision it exports.

**Acceptance:** save two default-named canvases and two names with the same
sanitized form; neither silently replaces the other's export. Interrupt a
container export. Save while an agent edits and show the exact exported
revision, even if newer work exists.

### R4. Slow rendering delays writes to unrelated environments

**Source-confirmed architecture; latency impact is unmeasured.**
[DesignService](../../apps/backend/src/core/design-service.ts#L74) has one global
write queue. Its
[mutation transaction](../../apps/backend/src/core/design-service.ts#L292)
holds that queue while awaiting backend DOM rendering. The
[renderer](../../apps/backend/src/core/design-renderer.ts#L44) also serializes
all work globally, including captures and inspection. Thus a style edit waiting
behind captures can also block a simple geometry update in another environment.

The existing limits prevent unlimited queue growth, but they do not bound the
whole request lifetime. The 15-second context timer starts **after** browser
launch and `newContext`; waiting for queue admission is outside it. Cleanup
awaits `context.close`, and renderer shutdown awaits the entire queue. The
timer is useful but is not an end-to-end deadline or proof of recovery from a
wedged browser.

Use bounded per-canvas serialization with a global admission limit and fair
renderer scheduling. Do expensive work from an immutable frame snapshot, then
recheck its revision before commit. Never hold a global document write lock
while waiting for Chromium. Retain a separate atomic guard for global quotas
and environment deletion when introducing finer-grained concurrency.

Budget queue wait, launch, context creation, execution, and cleanup separately
under an overall deadline. Escalate a stuck browser to a controlled restart;
settle all affected callers and permit later work to recover. Start with a
small measured concurrency limit rather than unlimited render workers. The
UI should distinguish queued work from failed work and offer safe cancellation
before execution; cancellation after dispatch must reconcile the outcome.

**Acceptance:** stall capture/context creation/cleanup in one environment;
another canvas's metadata operation remains responsive, all requests settle
within documented bounds, and subsequent rendering recovers.

### R5. Invalid rendered content and deleted canvases need explicit states

**Source-confirmed.**
[Frame creation and raw HTML replacement](../../apps/backend/src/core/design-service.ts#L261)
validate schemas and byte sizes but do not run the runtime's DOM-element limit.
A document can therefore be durably accepted and later fail rendering because
it exceeds 5,000 elements. This is a validation mismatch, not a script-isolation
bypass. Errors currently appear in a shared canvas alert, making the affected
frame and recovery action unclear.

Also, [canvas deletion](../../apps/backend/src/core/design-service.ts#L225)
removes the file and its replay hints without publishing a deletion event.
An already-open client eventually encounters a missing-file error through
polling; it has no typed deleted state. Previously rendered content can remain
on screen beside the error.

Return renderability diagnostics with create/import/replace operations, or
persist an explicit invalid-frame status if validation is asynchronous. Keep
each bad frame isolated with Retry, Replace HTML, and Recover previous version
actions. Explain which scripts/resources were omitted so an apparently broken
mockup has an understandable cause. Continue to enforce the existing sandbox.

Add a revisioned deletion/tombstone outcome, including snapshot reconciliation
when its live event is missed. Disable edits on deleted documents and offer
Close or recovery from an explicitly identified last-known snapshot. Preserve
normal recoverable error handling for temporary backend disconnection.

**Acceptance:** import a byte-valid frame containing over 5,000 elements and
delete an open canvas from another client. Neither should leave an apparently
editable, unexplained stale preview or an endless generic Refresh loop.

## User-experience opportunities

### U1. Make exploration reversible and complete the document lifecycle

**Product gap.** Revisions detect conflicts but do not provide user-accessible
history. The
[action inventory](../../apps/backend/src/core/design-tools.ts#L21) has no
frame deletion, frame duplication, canvas rename, or undo/restore action. Frame
rename and canvas deletion exist as tools, but corresponding management
controls are absent from the current canvas/launch UI.

Add canvas/frame rename, duplicate, delete with recovery, and bounded undo/redo
or checkpoints. Group a continuous gesture into one undo step. Record enough
authorship to distinguish agent edits from user edits; undo should create a
new revision and conflict when necessary, not blindly roll back someone else's
work. Make full-HTML agent replacement recoverable before expanding automation.

Add a searchable recent-designs view with thumbnails, last modified time,
environment, and a visible storage/quota state. The global 256-canvas limit is
currently easier to reach than to manage through the UI. Environment deletion
[also removes its canvases](../../apps/backend/src/core/commands-servers.ts#L1509);
make workspace storage versus repository export clear and offer export or
transfer when useful.

**Success measure:** a user can find, rename, duplicate, and recover a design
without asking the agent to issue maintenance commands.

### U2. Improve discovery, prerequisite recovery, and reopening

**Source-confirmed behavior; proposed UX changes.**
[The launch button](../../apps/web/src/components/design/DesignLaunchButton.tsx#L46)
is entirely disabled unless the renderer status is ready. This blocks its
open/import paths as well as new generation. The error is exposed through a
button title, and the status effect reruns on environment/hydration changes,
not through an explicit Retry. Meanwhile,
[renderer status](../../apps/backend/src/core/design-renderer.ts#L36) only
checks whether a candidate executable exists, not whether it launches.

Keep the entry accessible and show a clear readiness panel with Retry and
backend-specific setup guidance. A remote user needs to know that Chromium
belongs on the backend host. Separate capabilities: browsing/exporting stored
documents and client-side preview need not be gated by headless capture being
unavailable. Probe real launch health on demand and cache the result with a
bounded lifetime, rather than spawning a browser on every toolbar mount.

Separate Create, Open, and Import visually. Show the chosen agent's availability
and explain the self-contained HTML/CSS limitations before generation. Offer
brief templates and frame-size presets.

[Opening a canvas always creates a split tab](../../apps/web/src/components/terminal/TerminalContainer.view.tsx#L1270).
Focus an already-open canvas first; allow opening in the current pane when a
split is unavailable. This also avoids duplicate subscriptions and iframes.

**Success measure:** a user can recover from missing Chromium, reopen a canvas
at the split limit, and understand which actions remain available.

### U3. Reduce friction in selection, inspection, and navigation

**Source-confirmed behavior; proposed interaction improvements.**
[Selection is tied to the entire frame revision](../../apps/web/src/components/design/DesignCanvasTab.tsx#L425).
An accepted style edit or a geometry-only change makes it stale. The user must
select again before continuing. The
[inspector](../../apps/web/src/components/design/DesignInspector.tsx) shows a
flat list of computed CSS strings; it does not separate authored overrides
from inherited/computed values. The runtime accepts style strings and calls
`setProperty`, with no feedback that a syntactically invalid CSS value was
ignored.

After an acknowledged edit, safely re-inspect the same element when its
identity is known to survive. Keep explicit stale handling for structural
changes. Group properties into layout, spacing, typography, and appearance;
add unit-aware inputs, color controls, reset-to-inherited actions, inline
validation, and access to advanced properties. Keep drafts on recoverable
errors and visibly confirm accepted values.

[Frame manipulation](../../apps/web/src/components/design/DesignFrameView.tsx#L85)
clears the drag preview on release before persistence finishes, which can make
the frame snap back while waiting for its authoritative position. Retain a
marked pending preview until acknowledgment or conflict. Element resizing
currently previews the outline rather than the element's actual layout; a
reversible local preview would give better feedback without becoming the
authoritative document.

Add Fit all, Fit selection, 100%, cursor-anchored zoom, remembered view state,
device-size presets, and frame geometry fields. Reset currently restores a
fixed origin and 65% zoom rather than fitting the user's content. Frame move
and resize controls need keyboard alternatives; only selected-element resize
currently has arrow-key handling. Add Escape to deselect/cancel and document
shortcuts. On narrow panes, make layers and inspector explicit drawers with
focus restoration, rather than relying only on the current overlay/hide rules.

Keep Inspect and Preview modes distinct. The current iframe is covered by a
selection surface and has pointer events disabled, so users cannot explore
overflow or ordinary interaction inside it. A preview mode can permit safe
scrolling/hover without enabling authored scripts or network access.

**Success measure:** complete several consecutive edits without repeatedly
reselecting; navigate all frames and adjust geometry using only the keyboard.

### U4. Preserve the relationship between agent, canvas, and selection

**Product gap.**
[Launch](../../apps/web/src/components/design/design-launch.ts#L17) sends the
canvas ID in the initial prompt, but the
[document model](../../packages/protocol/src/design-canvas.ts#L17) has no
association with its agent session. Reopening an existing canvas opens only the
canvas. Selecting an element does not create a structured reference in chat.

Add Resume design conversation and Ask agent about selection. Carry canvas ID,
frame ID, element identity/selector, and revision as structured context; require
the agent to re-read before editing if that context is stale. Store session
associations as backend workspace metadata, separate from portable exports
and separate from credentials. Reuse ordinary native-agent session state for
progress, approvals, and cancellation.

Offer Compare versions and Promote to implementation as explicit actions.
The latter should explain that a self-contained static mockup is a design
reference, not automatically production-ready application code. Let the user
choose the target screen/frame and relevant repository files for the handoff.

**Success measure:** after closing and reopening, the user can resume the
correct conversation and request a change to a selected element without
copying IDs or describing its position manually.

## Efficiency opportunities

### E1. Stop transferring and reconstructing unchanged frame content

**Source-confirmed amplification; benchmark needed.**
[Canvas reconciliation](../../apps/web/src/components/design/DesignCanvasTab.tsx#L80)
fetches the whole document whenever its revision changes, despite change hints
containing frame IDs. A mutation also returns the full changed frame, but the
UI discards that result before fetching again. Even a small coordinate change
can require another snapshot near the 4 MiB document limit.

[Frame rendering](../../apps/web/src/components/design/DesignFrameView.tsx#L64)
depends on `frame.revision`, so a position-only update sends HTML into the
iframe again and regenerates its hierarchy. The shared runtime replaces the
document contents for every render. This is unnecessary for moves and causes
selection/DOM state churn.

Start with small changes: consume acknowledged mutation results, keep separate
content and geometry invalidation, and avoid HTML replacement on an x/y change.
Resize can update viewport geometry and refresh bounds without reconstructing
unchanged HTML. Then introduce a coherent changed-frame read or bounded patch
response containing generation, base revision, resulting revision, and changed
frame revisions. Do not assemble unrelated frame reads into an allegedly
atomic snapshot without validating the revision range.

Keep full-snapshot recovery for missed ranges, generation changes, deletion,
and unknown changes. Live hints must remain hints. If multiple views show the
same canvas, share one client subscription/snapshot projection, rehydrate on
activation, and retain a bounded missed-event check. Use backoff with jitter
when disconnected rather than fixed-rate error polling.

**Measure:** transferred bytes and DOM rebuild count per move, style edit, and
agent append at 1, 16, and 64 frames. A move should transfer no unchanged HTML
once this work is complete.

### E2. Bound visible rendering work, not only document size

**Source-confirmed structure; performance impact unmeasured.**
[The canvas](../../apps/web/src/components/design/DesignCanvasTab.tsx#L319)
renders a layer button for every reported entry and an iframe for every frame
while active. With 64 frames and up to 1,000 hierarchy entries per frame, the
structural upper bound is roughly 64,000 layer buttons plus 64 live previews.
Panning and zooming update parent state with those children present.

Cull offscreen frames with an overscan margin; use cached thumbnails until
they approach the viewport, while keeping selected/actively edited frames
live. Mounting again must render the authoritative frame revision. Collapse
frame and layer branches, fetch hierarchy on demand, and virtualize long lists.
Signal when the runtime's 1,000-entry/depth limit truncates a hierarchy rather
than silently presenting it as complete. Throttle gesture updates to animation
frames and isolate the pan/zoom transform from unrelated child rendering.

**Measure:** drag-frame timing, pan responsiveness, iframe count, and renderer
memory at large frame counts and at narrow viewport widths. Confirm that
background agent progress remains independent of viewport culling.

### E3. Reduce repeated disk, browser, and agent-context work

**Source-confirmed costs; optimize after measurement.**
Every [commit](../../apps/backend/src/core/design-service.ts#L165) validates,
serializes, writes, and syncs the whole document. Every
[list](../../apps/backend/src/core/design-service.ts#L141) reads and parses each
canvas in the environment to return only ID/name/revision. Every
[DOM operation](../../apps/backend/src/core/design-renderer.ts#L69) opens a new
browser context and renders the complete frame. MCP mutations return the full
frame HTML; `export_canvas` returns the complete document for the agent to
copy into a repository file.

First add no-op detection, a bounded transactional batch for compatible edits,
and summaries in the existing metadata index so opening the design picker
does not read all HTML. Keep disk-backed snapshots authoritative and define
how index drift/corruption is repaired. Bound batches by operation count and
bytes and preserve atomic revision checks.

Offer compact mutation receipts with an explicit option to fetch content.
Provide a constrained repository-save tool so agents need not round-trip a
large export through their context just to persist it. Cache captures or
inspection results only by verified frame content/viewport/runtime identity,
with byte/count limits and clear invalidation. Consider an isolated warm
context pool only if context creation is a measured bottleneck; preserve
network blocking and environment isolation.

Do not introduce a write journal or asset store solely on speculation. If
whole-document writes or embedded data URLs prove expensive, assess bounded
checkpoints/journaling or deduplicated assets as a separately versioned storage
change, keeping `.orkdes` export portable and recoverable.

**Measure:** disk bytes and sync time per edit, list latency, render setup versus
execution time, capture-cache hit rate, and MCP response bytes. Do not log
prompts, HTML, CSS values, image data, credentials, or document contents.

## Delivery and verification plan

1. **Protect editing intent:** address R1 and R2 together; add tests for
   concurrent agent edits, distinct queued gestures, delayed refresh, tab
   switching, lost responses, and stale selectors. Stable identity work must
   not weaken conflict checks.
2. **Protect saving and availability:** address R3 and R4; verify filename
   collisions, interrupted exports, independent environments, queue saturation,
   hung context creation, browser death, and cleanup deadlines.
3. **Make normal use comfortable:** ship recovery history and lifecycle
   controls, prerequisite recovery, selection continuity, frame navigation,
   and conversation linkage. Include keyboard and narrow-pane review.
4. **Reduce measured costs:** implement E1/E2 incrementally, then select E3 work
   from benchmarks. Establish a baseline before choosing worker counts, caches,
   polling cadence, or latency targets.

The existing
[browser component test](../../e2e/DesignCanvas.spec.ts) covers inspection,
script isolation, conflict reporting, inactive-tab rehydration, reconnect,
reload, capture without a mounted canvas, save feedback, and download. The
[real-gateway test](../../e2e/agent-testing/design-canvas.spec.ts) covers repository
save, external edits, tab restoration, and opening a new design workspace.
These are a useful baseline; the latter does not establish that a real agent
successfully completed a design-tool generation workflow.

Extend validation with the scenarios above rather than treating passing
baseline tests as evidence against uncovered races. Include two clients,
multiple environments, slow disk/network, disconnected/restarted backends,
large documents, and renderer failure. For all background changes: start work,
switch environment, let it finish or request input, return, and verify the
authoritative design, transcript, approvals, and controls.

Track aggregate operation latency split into queue/render/persist/reconcile,
conflict rate, explicit edit failures, revision resets, transferred bytes,
active preview count, and successful recovery after renderer failure. Combine
those with usability tasks—first usable frame, reopen and resume, successive
style edits, recover an unwanted change—to decide whether the feature is
actually becoming easier and more dependable.
