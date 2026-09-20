# Design canvas

Status: Living — first HTML/CSS design workspace.

Use **New design workspace** (the paintbrush in the environment toolbar).
Choose Claude or Codex and enter a brief. Orkestrator opens its ordinary native
agent chat on the left and a design-canvas tab on the right. The canvas has a
layer tree, pan/zoom, draggable and resizable frames, element selection and a
CSS inspector. The selected element's resize handle supports dragging and
arrow keys (Shift increases the step). Opening an existing canvas does not
start another agent.

The chat retains the existing approval, question, cancellation, transcript and
background-session behavior. Closing or hiding the canvas does not stop its
agent. A canvas tab stores only `designCanvasData: { canvasId }`, alongside the
ordinary tab id and type. HTML never enters the pane layout.

## Reference review

[Doop](https://github.com/kgoedecke/doop) separates canvas coordinates from the
HTML documents inside frames. Its `src/lib/frameBridge.ts` sends requests to
the frame runtime and checks the response's source window. Its
`src/lib/frameRuntime.ts` handles DOM inspection and editing, and its server
uses browser rendering for captures and inspection without a connected user.

This implementation independently follows that arrangement. It deliberately
does not adopt Doop's authored-script execution: only Orkestrator's editor
runtime executes. Doop's multiplayer presence, comments, replay, design memory
and resident agent are outside this first implementation.

## Ownership and revisions

`DesignService` persists documents under the backend data directory's
`design-canvases/<id>.orkdes`. A document contains `format: "orkdes"`, `version:
1`, id, environmentId, name, revision and frames. Each frame contains id, name,
x, y, width, height, HTML and its own revision.

All changes are serialized in a bounded backend write queue. Creating a frame
compares the **canvas** revision; editing HTML, styles or geometry compares the
**frame** revision. The write commits before publishing an event. An old
revision returns `Design revision conflict:`; neither the agent nor the UI
automatically reapplies the old edit over the new document. The inspector marks
an old selection stale so its selector cannot silently target changed HTML.

Snapshots are read from disk, not renderer state or a canvas cache. Atomic
temporary-file replacement prevents readers from seeing partial JSON.

## Live updates

The dedicated `design-canvas-changed` event contains only canvas id, revision,
optional frame id and backend generation. A global ring retains at most 256
content-free hints. `design_changes` detects a missing range, a future cursor
or a new generation and explicitly requests a snapshot reset.

Clients subscribe before reading, coalesce refreshes, and fetch authoritative
snapshots on changes. Mount, activation, gateway reconnection and a three-second
cursor check repair missed events, including a lost final event. Frame HTML is
not copied into the general event stream. Chunked agent appends commit complete
HTML fragments individually, so each fragment is visible and revision checked.

## MCP

`orkestrator-design` is a separate MCP server at `/design-mcp` on the existing
agent-tools listener. It has its own tool inventory; `/mcp` retains its existing
inventory. Claude and Codex receive the new server through trusted per-session
configuration when the backend advertises `agentMcp.design`.

The server reuses revocable environment/tab credentials and checks environment
ownership for every request. Workflow-result and broker credentials cannot
access this endpoint. Coordinator/control-MCP credentials do not advertise it.
No design credential is sent to the frontend or stored in `.orkdes` files.

Tools:

- `list_canvases`, `create_canvas`, `get_canvas`, `export_canvas`
- `create_frame`, `get_frame`, `update_frame`
- `replace_frame_html`, `append_frame_html`, `replace_element_html`
- `set_element_styles`, `move_element`, `inspect_element`, `capture_frame`

`append_frame_html` accepts complete fragments, not partial tags. Selectors for
element mutations must match exactly one element. `move_element` accepts a
parent selector and an optional sibling to insert before. `capture_frame`
returns a PNG and the captured frame revision.

## Runtime and deployment

The iframe has `sandbox="allow-scripts"` without same-origin privileges. A nonce
CSP allows only the trusted bootstrap. The runtime removes script, embed, frame,
navigation metadata and event-handler attributes from authored markup. Its
postMessage API includes hitTest, inspectElement, setStyles,
replaceElementHtml, moveElement, hierarchy and serialize. Parent requests are
bounded and expire, replies must come from the expected window, and unmount
rejects pending requests.

Designs are self-contained: inline CSS, data-URL images and data-URL fonts.
External stylesheets, fonts, network requests and authored scripts are disabled.
This also makes backend captures independent of client login state.

Backend element edits and captures use a separate headless Chromium context and
the same runtime. They work with no connected frontend. **Chromium is an
installer prerequisite** for the desktop app and standalone CLI: common Linux
and macOS installations and Playwright's pinned Chromium cache are detected, or
`ORKESTRATOR_DESIGN_CHROMIUM_PATH` can name the executable. The launch control
probes this prerequisite and stays gated with an actionable error when it is
missing. Each operation has a deadline and closes its context.

Bounds: 256 canvases, 64 frames per canvas, 256 KiB HTML per frame, 4 MiB per
document, 4096 × 4096 maximum viewport, 5000 DOM elements per rendered frame,
1000 hierarchy entries, 64 style properties per operation, 32 queued writes,
16 concurrent MCP requests, 16 queued render operations, 32 pending iframe
requests and 8 MiB per PNG.

## Files and validation

Save writes a `.orkdes` JSON snapshot to the environment's repository using the
existing local/container file writers. Download exports the latest snapshot to
the connecting client. The launch dialog imports `.orkdes` files under fresh
canvas/frame identities in the current environment. Agents can call
`export_canvas` and save that JSON with their normal repository file tools.

Tests cover persistence/restart, environment boundaries, competing CAS edits,
expired event ranges, imports and input bounds. The component browser test runs
at desktop and narrow widths and exercises real backend DOM edits, script
isolation, stale writes, inactive-tab recovery, reload and capture without a
mounted canvas. The agent browser test exercises the authenticated gateway,
repository save and persisted tab restoration.
