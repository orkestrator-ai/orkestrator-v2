# Rich transcript content: user guide

What agent responses can show in a conversation, what each control does, and
the limits that apply.

## Supported content

| Content | What you see | Controls |
| --- | --- | --- |
| Code | Highlighted source (24 lines, then **Expand**, up to 400 lines inline; longer code opens in the viewer) | Copy code, Copy as Markdown, Wrap lines, Expand, Open in viewer, Run in terminal (single-line shell commands only, after you click) |
| File references in inline code | `src/app.ts:12`, `src/app.ts:12:4` or `src/a.ts#L10` become links that open the file at that line | Click; bare names, URLs and fenced code stay plain |
| Diagrams (Mermaid) | Rendered diagram with its source one click away | Source/Preview, Copy source, Expand, Fit, Reset zoom, pan and zoom, Download SVG / PNG |
| Tables | Scrollable table; wide tables scroll inside the message | Wrap cells, Expand, Copy as Markdown, Copy as CSV, Download CSV, Download CSV (spreadsheet-safe) |
| Callouts | Note, Tip, Important, Warning, Caution blocks with an icon and a text label | — |
| Disclosures | `<details>` sections that open and close | Click or keyboard; state is remembered |
| Images and files | Thumbnails and file cards; images keep their size while loading and say whether they are loading, blocked, denied, unavailable, too large, unsupported or could not be decoded | Gallery viewer (previous/next, zoom, fit, original size), Copy image, Download original; video and audio previews load only when you press **Load video** / **Load audio** and never autoplay; they stream from the environment (seeking fetches only what is needed; up to 2 GiB for local files, 512 MiB for container files), and where streaming is not available (for example a remote browser without a hosted content origin) files over 8 MiB offer Download original instead |
| Charts | Bar, line, area, scatter and donut charts | Legend toggles, hover/focus values, Data table, Source JSON, Copy CSV, Download CSV / JSON / SVG, Reset view, Expand |
| Workflow snapshots | A historical **Snapshot** of a review or build run | Open live workflow, node links, table view |
| HTML artifacts | A saved preview image | Source, Download, Print, Expand; interactive artifacts add **Run interactive** |

## Expanded views

At most 50 blocks stay expanded at once. When opening another closes one,
the closed block says so and offers **Reopen**, which restores it with its
settings (hidden series, zoom, wrap, table view). An expanded diagram stays
open when you scroll away and back.

## Source is always available

Every rich block keeps its exact source. If a renderer fails, the block shows
what went wrong and the source; the rest of the message is unaffected.
Content larger than the inline limits shows a notice with the omitted amount
and a way to open or copy the full source.

## Copying and exporting

- **Copy code** copies exactly the code inside the fence (tabs, trailing
  newlines and all). **Copy as Markdown** includes a safe fence.
- **Copy as CSV** and **Download CSV** export the exact cell text.
  **Spreadsheet-safe** export prefixes cells that a spreadsheet would treat
  as formulas with `'`; it changes only the exported file.
- Chart exports always contain the full dataset unless you choose the
  filtered export, which says so.
- A downloaded HTML artifact is labelled **HTML source**: once saved it runs
  outside Orkestrator's isolation, so it is never opened automatically.
- **Copy message** copies the message text plus a one-line summary of each
  artifact, never toolbar labels or hidden duplicates.

## Inspecting drafts

Rows of the artifact authoring tools (create, update, preview, operation
status) have an **Inspect draft** action. It lists this conversation's
artifacts and shows, clearly labelled **Draft — not published**, the exact
source of the current revision (with **Copy source**), the latest
verification result with its error and diagnostic codes and locations, and
any screenshots captured when a preview failed. Drafts are never run or
published from here.

## Finding text in artifacts

Find matches an artifact's summary at once, and its chart labels, workflow
labels or Mermaid source (while the source view is open) once the card has
loaded them.

## Interactive HTML artifacts

Interactive artifacts show their verified preview image until you press
**Run interactive**. The running artifact:

- runs in an isolated sandbox with no network access, no access to your
  files, the conversation, the agent or Orkestrator's APIs;
- can ask to open a link — Orkestrator shows the destination host and opens
  it only when you click;
- keeps its state while you scroll, expand it or switch themes (theme changes
  are cosmetic and do not re-verify it);
- can be stopped at any time with **Stop**. Closing it ends only that view;
  it never cancels agent work or deletes anything;
- closes on its own when its environment is deleted, when you switch to
  another environment, or when the backend connection or session changes.
  The card then shows the saved preview and why the view closed.

Only one interactive artifact runs per window. Starting another offers to
switch. Restarting creates a fresh session with the artifact's initial
values; in-memory state is not saved.

The preview badge says which profile was verified (for example *light,
960 × 640*) and whether interactions were checked by declared probes or
*not assessed*. A preview proves the artifact rendered, not that its content
is correct.

## Historical snapshots versus live state

Published artifacts appear while the conversation is open, without waiting
for the next message. If a conversation has more published artifacts than
the transcript loads, a notice says how many older ones were not loaded.

A workflow **Snapshot** shows the run exactly as it was when captured, with
the capture time and revision. It never changes. **Open live workflow**
opens a separate live view that shows connecting, live, offline or finished
states. Deleting a run keeps the snapshot; only live navigation becomes
unavailable.

## Platform notes

- Desktop runs interactive artifacts in a separate sandboxed browser view
  with its own empty session and request filtering.
- Browser access runs them in a sandboxed frame on a separate content origin.
  Browsers isolate origins but cannot guarantee CPU isolation: a runaway
  artifact can slow the tab until you press Stop.
- Previews, Mermaid diagrams and HTML verification need the backend's
  headless Chromium. Without it, diagrams and HTML show their source with an
  explanation; charts, tables, code and workflow snapshots still render.
