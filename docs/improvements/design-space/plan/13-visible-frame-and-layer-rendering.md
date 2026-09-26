# 13 — Visible-frame and layer rendering

Status: Implemented (2026-09-24) — see the [implementation record](00-index.md#implementation-record).  
Dependencies: [09](09-selection-and-inspector.md),
[10](10-navigation-and-accessibility.md),
[12](12-incremental-synchronization.md).  
Findings: E2.

## Outcome

Large canvases do not mount every iframe or thousands of hidden layer buttons.
Offscreen work remains authoritative in the backend, and re-entering the
viewport always displays the current content before enabling interaction.

## Owners

`DesignCanvasTab.tsx`, `DesignFrameView.tsx`, `frame-bridge.ts`, the client
controller, `design-runtime.ts`, and the backend thumbnail/hierarchy adapters.
Extract proposed `DesignLayerTree.tsx` and `design-visibility.ts` as needed.
Reuse an existing virtualization primitive if suitable; verify library APIs
at implementation time rather than adding a new dependency by default.

## Visibility and live-preview budget

- [ ] Convert the viewport plus overscan into canvas coordinates using step-10
  helpers. Recalculate once per animation frame during gestures.
- [ ] Start with an eight-live-iframe budget and roughly one-quarter viewport
  overscan; measure and tune. At very low zoom, many visible frames still need
  thumbnails/placeholders instead of bypassing the budget.
- [ ] Prioritize the frame being edited, then selected/focused, then visible
  frames near the viewport center. Pin active pointer/keyboard interactions
  until they settle; never tear down a pointer-capture target mid-gesture.
- [ ] Give focus a safe destination before culling an iframe or frame control.
  A selected item in the hierarchy remains reachable when its frame is offscreen.
- [ ] Use cached thumbnails only when their version/viewport/runtime metadata
  matches. Label outdated thumbnails or show a placeholder; do not present them
  as the current editable rendering.
- [ ] Clicking an unloaded thumbnail brings the frame into view, obtains the
  live current render, and only then performs hit testing. A thumbnail's pixel
  coordinates are not a valid DOM selector result.
- [ ] Settle/reject all pending iframe requests on teardown and clean listeners,
  object URLs, timers, and bridge entries. Culling is presentation cleanup only.

## Rehydration and inactive behavior

- [ ] Unmounted frames retain no DOM authority. Their snapshots live in the
  bounded controller projection and backend; history/operations remain durable.
- [ ] While a frame is absent, accept delta updates to its cached data without
  mounting it to “keep it synchronized.”
- [ ] When remounted, render the exact current content identity and viewport,
  wait for runtime readiness, then enable selection. Ignore stale completions.
- [ ] Switching environments removes preview resource use promptly without
  stopping renderer jobs, agent turns, or admitted edits in the backend.
- [ ] Do not schedule captures for every frame on each edit. Thumbnails are
  lazy, invalidated by identity, and lower priority than user/agent operations.

## Layer tree contract

- [ ] Add expandable frame roots and element branches. Closed roots need only
  summary labels/counts, not an eager hierarchy request.
- [ ] Extend runtime hierarchy queries with root identity, cursor, maximum
  nodes/bytes, and structure identity. Initial page cap: 200 entries/128 KiB;
  stop at whichever bound is reached first.
- [ ] A hierarchy cursor is tied to structure identity. A structural change
  invalidates paging; restart the relevant branch rather than merging old paths.
- [ ] Report total/has-more/truncated information where known. Depth/element
  limits have a visible explanation and an accessible “load more”/focus path.
- [ ] Provide hierarchy from a validated backend render/cache when needed for
  an offscreen frame. Do not require a hidden iframe per frame just for layers.
- [ ] Virtualize the visible expanded rows with stable keys and bounded cached
  pages. Retain the focused/selected row or restore focus deliberately on paging.
- [ ] Search is bounded and explicitly scoped to loaded content unless the
  backend implements an authoritative bounded search. Do not claim global
  results while silently searching only the first 1,000 entries.

## Render-work isolation

- [ ] Keep pan/zoom transforms outside content/inspector subscriptions where
  practical. A transform update should not rebuild every layer row or parse HTML.
- [ ] Memoize by verified frame/content metadata, not an object rebuilt for
  every snapshot. Preserve immutable references for unchanged frames.
- [ ] Debounce low-priority hierarchy/thumbnail work while dragging; flush a
  final current request afterward so the result cannot remain permanently stale.
- [ ] Track live iframe count, mounted layer row count, hierarchy bytes, and
  resource cleanup. Never record DOM text or CSS values in these metrics.

## Required tests and performance evidence

| Fixture/action | Acceptance |
| --- | --- |
| 64 frames, zoomed far out | Iframe count stays within budget; all frames remain discoverable |
| Pan rapidly between distant frames | Current frames hydrate; no old HTML/selection flashes as editable |
| Edit pinned frame while panning | Gesture target survives until safe to release |
| Agent edits an offscreen frame | Returning shows current authoritative content without a second edit |
| Expand many large layer branches | Mounted rows/cache bytes bounded; pagination exposes omitted content |
| Structural change during hierarchy paging | Old cursor rejected/reset, no mixed tree |
| Keyboard focus in a soon-hidden row/frame | Focus retained or moved to documented fallback |
| Repeated activate/deactivate/cull cycles | No increasing listener, iframe, timer, or blob count |

Record p50/p95 gesture processing time and frame drops on the same host/build
as the baseline. A 60 Hz display's approximately 16.7 ms frame interval is a
measurement reference, not a promise that all hardware will hit it. Require
bounded resource counts and no correctness regression even when latency targets
cannot be met.

Review slices: visibility decisions/placeholders; live-preview lifecycle;
bounded hierarchy protocol; virtualized accessible tree; benchmark and leak
qualification. Do not combine unproven caches with culling in one unreviewable PR.

## Implementation notes (2026-09-24)

- `design-visibility.ts`: ≤8 live iframes, ¼-viewport overscan, pinned gesture targets, placeholders at very low zoom; clicking a placeholder brings the frame into view before any hit testing.
- `DesignLayerTree.tsx` / `design-layer-model.ts`: lazy expandable branches, ≤200 nodes/128 KiB pages with structure-bound cursors (runtime `hierarchyPage`, backend `design_hierarchy` for offscreen frames), bounded caches, fixed-row windowing, WAI-ARIA tree with roving focus, filter of loaded rows only.
- Canvas actions are passed through stable refs so pans and snapshot updates do not re-render every frame; iframe bridges live exactly as long as their iframe.
