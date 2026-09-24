# Design Space implementation plan

Status: Planned — implementation has not started.  
Prepared: 2026-09-21, against `88c2f9cc`.  
Source: [Design Space improvement assessment](../../design-space.md).

This directory translates all twelve assessment findings into fifteen ordered
implementation steps. It is a proposed implementation contract, not a claim
that these APIs, files, or behaviors already exist. The report's focused test
results establish the old baseline only. This planning task changes documents
only; none of the implementation checkboxes are complete.

## Intended outcome

Users can create or reopen a design, make successive edits, collaborate with
an agent, switch environments, recover unwanted changes, and export a known
revision without losing intent or overwriting unrelated work. Small edits
should cause small transfers and little rendering work. One unhealthy render
must not stop document operations in another environment.

## Numbered steps and dependencies

Implement in numerical order by default. Dependencies identify the minimum
prerequisites, not a requirement to combine steps into one large PR. Each step
contains suggested review slices; keep every merged slice independently usable.

| Step | Document | Status | Requires | Findings | Delivery outcome |
| --- | --- | --- | --- | --- | --- |
| 01 | [Preserve editing intent](01-preserve-editing-intent.md) | Planned | — | R1, R2 | Immediate stale-target and queue-loss fixes plus regression evidence |
| 02 | [Operation contracts and durable records](02-operation-contracts-and-durability.md) | Planned | 01 | R2, R5 | Typed outcomes, recoverable operation receipts, compatible storage migration |
| 03 | [Client controller and reconciliation](03-client-controller-and-reconciliation.md) | Planned | 02 | R1, R2, E1 | Shared projections, awaitable synchronization, pending-edit recovery |
| 04 | [Renderer scheduling and failure containment](04-renderer-scheduling-and-recovery.md) | Planned | 02 | R4 | Per-canvas commits, fair bounded rendering, end-to-end deadlines |
| 05 | [Safe saving and export](05-safe-saving-and-export.md) | Planned | 02, 03 | R3 | Explicit export identity/path/revision with interruption recovery |
| 06 | [Validation, deletion, and error recovery](06-validation-deletion-and-recovery.md) | Planned | 02, 03, 04 | R5 | Per-frame validity, tombstones, actionable disconnected/deleted states |
| 07 | [History and document lifecycle](07-history-and-document-lifecycle.md) | Planned | 02, 04, 06 | U1 | Bounded recovery history, safe undo, rename/duplicate/delete/restore |
| 08 | [Entry, readiness, and design library](08-entry-readiness-and-library.md) | Planned | 03, 05, 06, 07 | U1, U2 | Accessible entry, capability-aware actions, searchable reopen workflow |
| 09 | [Selection and inspector](09-selection-and-inspector.md) | Planned | 03, 06, 07 | R1, U3 | Safe selection continuity, validated CSS, reusable drafts |
| 10 | [Canvas navigation and accessibility](10-navigation-and-accessibility.md) | Planned | 03, 08, 09 | U3 | Fit/zoom, stable gesture previews, keyboard and narrow-pane workflows |
| 11 | [Agent context and implementation handoff](11-agent-context-and-handoff.md) | Planned | 02, 07, 08, 09 | U4 | Resume conversation, ask about selection, compare and hand off |
| 12 | [Incremental synchronization](12-incremental-synchronization.md) | Planned | 02, 03, 06 | E1 | Coherent bounded deltas and zero HTML transfer for geometry-only edits |
| 13 | [Visible-frame and layer rendering](13-visible-frame-and-layer-rendering.md) | Planned | 09, 10, 12 | E2 | Bounded live previews, virtualized layers, safe culling/rehydration |
| 14 | [Storage, rendering, and MCP efficiency](14-storage-rendering-and-mcp-efficiency.md) | Planned | 04, 05, 07, 11, 12, 13 | E3 | No-op handling, atomic batches, compact tools, measured caches |
| 15 | [Qualification and rollout](15-qualification-and-rollout.md) | Planned | 01–14 | All | Migration, real-stack, concurrency, accessibility, and performance evidence |

Release boundaries:

1. **Correctness patch:** step 01 can ship immediately without a storage migration.
2. **Reliable foundation:** steps 02–06; existing interaction affordances remain
   available while the backend and controller improve.
3. **Usable workspace:** steps 07–11; history precedes expanded automation.
4. **Measured efficiency:** steps 12–14; preserve full-snapshot recovery.
5. **Broad qualification:** step 15 is the final gate, with its test matrix used
   throughout implementation rather than saved until the end.

## Current code map

Paths mentioned in individual plans are repository-relative. Proposed new
module names are labeled as proposed and may change if existing owners fit.
Avoid splitting solely to satisfy a file list; maintain coherent ownership and
the repository's 2,000-line guideline.

| Owner | Existing source |
| --- | --- |
| Shared document/event types | [design-canvas.ts](../../../../packages/protocol/src/design-canvas.ts) |
| Sandboxed DOM runtime | [design-runtime.ts](../../../../packages/protocol/src/design-runtime.ts) |
| Persistence and revision checks | [design-service.ts](../../../../apps/backend/src/core/design-service.ts) |
| Headless Chromium lifecycle | [design-renderer.ts](../../../../apps/backend/src/core/design-renderer.ts) |
| Validated actions and MCP inventory | [design-tools.ts](../../../../apps/backend/src/core/design-tools.ts) |
| UI command registration | [commands-registry-design.ts](../../../../apps/backend/src/core/commands-registry-design.ts) |
| Canvas projection and mutations | [DesignCanvasTab.tsx](../../../../apps/web/src/components/design/DesignCanvasTab.tsx) |
| Frame rendering and gestures | [DesignFrameView.tsx](../../../../apps/web/src/components/design/DesignFrameView.tsx) |
| Inspector | [DesignInspector.tsx](../../../../apps/web/src/components/design/DesignInspector.tsx) |
| Launch and import | [DesignLaunchButton.tsx](../../../../apps/web/src/components/design/DesignLaunchButton.tsx), [design-launch.ts](../../../../apps/web/src/components/design/design-launch.ts) |
| Queue and iframe bridge | [latest-mutation-queue.ts](../../../../apps/web/src/components/design/latest-mutation-queue.ts), [frame-bridge.ts](../../../../apps/web/src/components/design/frame-bridge.ts) |
| Integration coverage | [component browser test](../../../../e2e/DesignCanvas.spec.ts), [gateway test](../../../../e2e/agent-testing/design-canvas.spec.ts) |

## Shared architectural decisions

1. **Keep portable version 1 initially.** `.orkdes` import/export remains the
   documented version-1 shape and limits. Backend-only operation receipts,
   content/structure revisions, export associations, session links, and history
   metadata live in a separately versioned private record. Never add fields to
   strict version-1 exports accidentally. An asset-pack format is not part of
   these steps.
2. **One durable commit boundary.** A committed operation receipt and the
   corresponding document revision must become authoritative together. Step 02
   specifies an atomic private record replacement; separate best-effort JSON
   writes are insufficient. Derived indexes can be rebuilt.
3. **Exact preconditions.** Selector edits use the revision/identity observed by
   their author. Automatic chaining is allowed only for a proven predecessor
   from the same client and a compatible nonstructural operation. Agent changes
   cannot silently substitute a new precondition.
4. **Explicit uncertainty.** Missing/expired receipts, broken connections, and
   process death do not prove that a command did not run. Unknown work requires
   reconciliation; no blind redispatch. Unmount is never cancel.
5. **Backend-owned execution.** Once admitted, operation work and its outcome
   live in the backend. Client drafts and previews are projections of intent,
   never committed state. Native agents keep their existing session lifecycle.
6. **Version every catch-up path.** Snapshots/deltas include a generation and
   canvas revision. Content, structure, and viewport identities distinguish
   render invalidation from persistence revisions. Every lost update has a
   snapshot recovery path.
7. **Preserve isolation.** No authored-script execution or external asset
   access is introduced. Chromium contexts remain isolated; MCP continues to
   authenticate and authorize each environment. Inspect/Preview changes input
   routing, not sandbox permissions.
8. **Bound new resources.** Every new queue, cache, receipt list, history store,
   index, and decoded request has a byte and count bound. Admission rejects
   before mutation. Logs contain operation kinds, counts, timings, and reason
   codes, never design content, credentials, or prompt text.
9. **Capability negotiation.** New clients discover supported commands and
   response versions. An old backend uses the existing snapshot path; absent
   support does not mean an empty document or deleted session. Old clients do
   not receive an incompatible export shape.

## Initial bounds and measurement policy

Existing limits remain: 256 active canvases, 64 frames/canvas, 256 KiB HTML/frame,
4 MiB portable document, 4,096 × 4,096 frame viewport, 5,000 rendered elements,
1,000 legacy hierarchy entries, 32 writes, 16 render requests, 32 iframe asks,
and 8 MiB PNG. Lowering or raising these requires explicit coverage.

Proposed initial budgets below are engineering starting points, not measured
product requirements. Centralize them and revise using steps 01/15 evidence.

| New resource | Starting bound | Exhaustion behavior |
| --- | --- | --- |
| Admitted mutations | 32 globally; 8/canvas; 8 MiB aggregate decoded payload | Typed capacity result before admission |
| Private current record | 6 MiB including a portable document of at most 4 MiB | Reject mutation; retain previous record |
| Terminal receipt summary | 128/canvas and 128 KiB/canvas | Prune terminal receipts; old execution tokens never become executable again |
| Local mutation drafts | 8/canvas, 32/client, 2 MiB/client | Keep current draft and report capacity; do not drop accepted work |
| Renderer workers | Start with 1; evaluate 2 under load | Fair queue, at most 16 admitted render jobs |
| History | 50 entries/canvas, 64 MiB/canvas, 512 MiB/backend | Prune eligible unpinned entries; explicit limit if protected entries prevent admission |
| Recycle bin | 32 canvases and 128 MiB/backend, 7-day default retention | Explicit purge/retention outcome; never silently consume unbounded space |
| Thumbnail/capture cache | 64 entries and 64 MiB/backend | Least-recently-used eviction, never authoritative data deletion |
| Client snapshot cache | 16 inactive canvases and 32 MiB/client | Evict clean inactive projections; refetch on activation |

Count simultaneous temporary files and prepared data in disk/memory budgets,
not just the final live records. Document any platform-specific enforcement
limitations; filesystem crash guarantees differ from process-exit guarantees.

## Validation and completion rules

Use the [testing guide](../../../development/testing-guide.md) and
[isolated-stack guide](../../../development/agent-testing.md). Each step has
owning tests and concrete scenarios. For an implementation handoff, run the
required owning checks, `mise run check`, and `mise run test`, plus applicable
browser/agent/Electron/Docker checks through the prescribed logged workflow.
Do not invent success for unavailable browser or agent coverage.

When testing libraries, mocks, or browser integration, load applicable skills
and consult current library documentation as required by `AGENTS.md`. This plan
specifies behavior rather than freezing third-party API syntax.

Every background-flow step must include: start work, switch environment or
unmount the canvas, let work complete or request input, return, and verify
snapshot, pending intent, transcript, prompts, and controls. Add restart tests
where persistent state changes. Test both local and container exports.

Update the status in a step and this index together. Record PR, validation
commands/results, migration evidence, and remaining limitations. A step is
complete only when its acceptance criteria are verified and any excluded work
is explicitly moved to a deferred item. All integration into `main` is through
a reviewed PR; a human maintainer performs the merge.

## Deferred unless evidence changes

- Multiplayer cursors/comments, arbitrary authored JavaScript, external asset
  fetching, and a separate resident design agent.
- New agent-provider support beyond the existing Claude/Codex design launch.
- CRDT/general collaborative text editing or speculative automatic conflict
  merging.
- A new database, content-addressed asset package, and general write-ahead log
  solely for speed. The private atomic record is for correctness; history uses
  bounded snapshots before considering more complex storage.
- A warm reusable browser-context pool unless measured setup cost justifies it.
- Automatic implementation dispatch, auto-approval, publishing, or deployment.

## Plan maintenance

Before starting a numbered step, reread its source files: the audit revision
may no longer match the tree. Preserve completed behavior and amend stale
assumptions. If a storage/protocol decision changes, update all dependent plans
in the same documentation change. Keep the original assessment as dated
evidence; this directory owns implementation status.
