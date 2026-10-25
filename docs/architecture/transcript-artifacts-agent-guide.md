# Transcript artifacts: agent tool guide

Orkestrator's ordinary agent tool server (`orkestrator`, injected for Claude,
Codex, OpenCode, Cursor, Grok and Pi) exposes seven artifact tools. They are
the only way to put durable, verified rich content into a conversation. This
guide is the long form of the tool server's instructions.

## Markdown or an artifact?

Use **plain Markdown** for ordinary answers: prose, small code fences,
tables, callouts (`> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`,
`> [!CAUTION]`), `<details>`/`<summary>` disclosures, and small ` ```mermaid `
diagrams or ` ```chart ` fences holding one `ChartSpecV1` JSON object. These
render natively in the transcript and need no tool call.

Use an **artifact** when the result should be durable, verified, revisable or
interactive:

| Kind | Use for | Verification gate |
| --- | --- | --- |
| `chart` | A bar, line, area, scatter or donut chart of supplied data | Strict schema + deterministic native render |
| `mermaid` | A larger or durable diagram | Syntax parse + bounded isolated render |
| `workflow-snapshot` | A snapshot of an existing Multi Review, Looped Review or Build pipeline run | Backend captures the run itself |
| `html-static` | A designed static page, report or mock-up | Static sanitizer + supervised visual preview |
| `html-interactive` | An offline calculator, simulation, explorable diagram or mini tool | Executable-package validation + supervised preview + your declared probes |

Facts that matter:

- HTML code fences in Markdown **never execute**; they render as source.
- Mermaid math labels (`$$…$$`) are not supported (HTML labels are off and
  KaTeX is not used); a preview fails with `math_labels_unsupported`. Write
  the expression as plain text or Unicode instead (`x² + y²`).
- `html-interactive` previews need the container worker. On a host without
  it the preview answers `renderer_unavailable`; the source is kept.
- `html-static` strips every authored script, frame and event handler.
- `html-interactive` runs offline in an isolated sandbox: no network, no
  storage shared with Orkestrator, no access to tools, files or the
  conversation. Dependencies are limited to Orkestrator's pinned offline
  manifest (`d3@7.9.0`, `chart.js@4.5.1`), declared in `dependencyIds`. A
  classic `<script>` uses their globals (`d3`, `Chart`); a
  `<script type="module">` may also `import` them by bare specifier. Every
  other import (relative, URL, `node:`, dynamic `import()`) is rejected.
- Workflow facts come from the backend. You name a run; you never author its
  nodes, statuses or results.
- A rendered preview is not proof that content is correct. A chart shows the
  numbers you supplied; a screenshot does not prove an interaction works —
  declare probes for that.

## The lifecycle

`create_artifact` → `preview_artifact` → `get_artifact_operation` (inspect)
→ `publish_artifact`. After a failed preview: `update_artifact` (a complete
replacement, creating the next immutable revision) → preview → inspect →
publish. Nothing is published automatically. Publishing requires the current
head revision and a successful receipt for exactly that revision.

Every mutating call takes a `requestKey` you generate once and **reuse on
retry** after a timeout. The same key with the same arguments returns the
original result; with different arguments it fails with
`idempotency_conflict`.

The repair budget is the initial preview plus at most two corrective
revisions per requested output. When it is exhausted, report the final
failure with the diagnostics; the draft source stays inspectable.

### create_artifact

```json
{
  "requestKey": "chart-suites-1",
  "draft": {
    "title": "Illustrative test outcomes",
    "summary": "Passed tests per suite for two synthetic runs.",
    "payload": { "kind": "chart", "spec": { "...": "ChartSpecV1, below" } }
  }
}
```

Returns `{ artifactId, revision: 1 }`. HTML drafts may list
`assets: [{ name, assetRef }]`, where `assetRef` is an upload the user staged
for this conversation (`stg-…`); never a path or URL. Workflow snapshots use
`"payload": { "kind": "workflow-snapshot", "workflowId": "multi-review", "runId": "<id>", "expectedWorkflowRevision": "<optional>" }`.

### preview_artifact

`{ requestKey, artifactId, revision, profile? }` returns an `operationId`
immediately. `profile` defaults to light theme at 960 × 640, scale 1. One
preview verifies one profile.

### get_artifact_operation

`{ operationId, includePreviewImage?, captureIndex? }` returns the durable
status (`queued`, `running`, `succeeded`, `failed`, `cancelled`,
`interrupted`), bounded diagnostics with codes and locations, probe results,
and evidence references. With `includePreviewImage: true` an image block of
the receipt capture (or a failed-preview diagnostic capture) is added when
your client supports images (`imageDelivery: "attached-if-supported"`).
Visual inspection is always reported as `not-assessed`: an attached image is
not an assessment. A `receiptId` appears only on success.

### publish_artifact

`{ requestKey, artifactId, expectedRevision, receiptId }` publishes exactly
that revision and returns the durable reference. Retrying returns the same
publication; it never creates a second transcript item.

### get_artifact, cancel_artifact_operation

`get_artifact` returns metadata, or a bounded UTF-8 `sourceRange` slice with
`nextOffsetBytes`/`omittedBytes`. `cancel_artifact_operation` stops queued or
running verification; it never deletes or unpublishes anything.

## Errors

Errors are `{ code, message, retryClass, fieldErrors?, currentRevision? }`.
`retryClass` tells you what to do: `after-edit` (change the source),
`after-refresh` (re-read state, e.g. `revision_conflict`, `preview_stale`),
`transient` (retry the same key later), `never`.

## Chart example (runnable)

This is synthetic data, not project metrics:

```json
{
  "schemaVersion": 1,
  "kind": "bar",
  "title": "Illustrative test outcomes",
  "description": "Synthetic fixture: three suites, two recorded runs.",
  "sourceNotes": ["All numbers are synthetic test data."],
  "xAxis": { "kind": "category", "label": "Suite" },
  "yAxis": { "label": "Passed tests", "unit": "tests" },
  "categories": [
    { "id": "unit", "label": "Unit" },
    { "id": "integration", "label": "Integration" },
    { "id": "browser", "label": "Browser" }
  ],
  "series": [
    { "id": "a", "label": "Run A", "points": [
      { "categoryId": "unit", "value": 40 },
      { "categoryId": "integration", "value": 12 },
      { "categoryId": "browser", "value": 8 }
    ] },
    { "id": "b", "label": "Run B", "points": [
      { "categoryId": "unit", "value": 44 },
      { "categoryId": "integration", "value": 12 },
      { "categoryId": "browser", "value": null }
    ] }
  ]
}
```

Every bar series has exactly one point per category; use `null` for a
missing observation. Line/area x values strictly increase per series;
`utc-time` x values are integer epoch milliseconds. No colours, SVG, CSS,
URLs or formatter functions are accepted.

## Interactive example with probes

```json
{
  "kind": "html-interactive",
  "html": "<label>Tasks <input type=range min=0 max=20 value=5 data-artifact-test=tasks></label> <label>Minutes per task <input type=number value=12 data-artifact-test=minutes></label> <p>Total: <output data-artifact-test=total>60</output> minutes</p><script>const t=document.querySelector('[data-artifact-test=tasks]'),m=document.querySelector('[data-artifact-test=minutes]'),o=document.querySelector('[data-artifact-test=total]');function u(){o.textContent=String(Number(t.value)*Number(m.value))}t.addEventListener('input',u);m.addEventListener('input',u);</script>",
  "probes": [
    { "op": "expect-text", "target": "total", "equals": "60" },
    { "op": "set-number", "target": "tasks", "value": 8 },
    { "op": "expect-number", "target": "total", "equals": 96 },
    { "op": "set-number", "target": "minutes", "value": 0 },
    { "op": "expect-number", "target": "total", "equals": 0 }
  ]
}
```

Probes target unique `data-artifact-test` identifiers only
(`[A-Za-z][A-Za-z0-9_-]{0,63}`), at most 20 steps, each bounded to two
seconds. Operations: `click`, `set-number`, `fill`, `expect-text`,
`expect-number` (with optional `tolerance`), `wait-visible`. Every declared
probe must pass for a receipt; a failing probe returns the exact step and
observed value plus a diagnostic capture. Use `addEventListener`, not
inline `on…=` attributes (the policy forbids inline handlers). Reference
supplied assets as `artifact-asset:<name>`.

## Dependencies and module imports

| `dependencyIds` entry | Classic global | Module specifiers |
| --- | --- | --- |
| `d3@7.9.0` | `d3` | `"d3"` |
| `chart.js@4.5.1` | `Chart` | `"chart.js"`, `"chart.js/auto"` |

Declare every dependency you use, whether through its global or an import:
importing `"d3"` without `"d3@7.9.0"` in `dependencyIds` fails with
`undeclared_dependency` and the id to add. Only static `import` declarations
of the specifiers above are allowed, in `<script type="module">` only. These
fail with `unresolved_import`: relative or absolute paths, URLs, `data:`,
`node:`/`bun:` built-ins, other packages (including `d3-selection` or
`chart.js/helpers`), `require()`, and any `import()` (including
`await import("d3")`). Inline your own helpers in the module script instead.

```json
{
  "kind": "html-interactive",
  "dependencyIds": ["d3@7.9.0", "chart.js@4.5.1"],
  "html": "<svg id=bars width=320 height=120></svg><canvas id=line width=320 height=160></canvas><p>Bars: <span data-artifact-test=bars>0</span></p><script type=\"module\">import * as d3 from \"d3\"; import { Chart } from \"chart.js\"; const data = [3, 7, 4]; const x = d3.scaleBand().domain(d3.range(data.length)).range([0, 320]).padding(0.2); d3.select('#bars').selectAll('rect').data(data).join('rect').attr('x', (_, i) => x(i)).attr('width', x.bandwidth()).attr('y', (d) => 120 - d * 10).attr('height', (d) => d * 10); document.querySelector('[data-artifact-test=bars]').textContent = String(data.length); new Chart(document.getElementById('line'), { type: 'line', data: { labels: ['a', 'b', 'c'], datasets: [{ label: 'Tasks', data }] }, options: { animation: false, responsive: false } });</script>",
  "probes": [{ "op": "expect-number", "target": "bars", "equals": 3 }]
}
```

`import Chart from "chart.js/auto"` also works. The Chart.js build already
registers every chart type, scale and plugin, so `Chart.register(...registerables)`
is accepted but does nothing. A module script and a classic script share the
same library instance. Module scripts run after the document is parsed, as
in any browser. They may use top-level `await` on values, not on imports.

## Shared registrations

Where a provider's tool connection is environment-wide rather than per tab
(OpenCode), the dispatch instructions carry an artifact-only
`scopeCapability`. Pass it unchanged as the `scopeCapability` argument. It
grants nothing beyond artifact operations for this conversation and turn,
and it expires.

## Workflow turns

A Multi Review reviewer, a build-pipeline stage (including its reviewers and
consolidation) and a feature-planning turn publish too. Their artifacts
belong to that workflow session's own transcript, and their cards appear
there beside the publish call (in a planning chat, at the point the turn
published them).

- On OpenCode the same tools on `orkestrator` are used, with the
  `scopeCapability` from the turn's instructions.
- On the other providers a turn whose `orkestrator` server is the
  workflow-result server also has an `orkestrator-artifacts` server with the
  same seven tools. It is already bound to this conversation and turn: omit
  `scopeCapability`. Its tools work in read-only review turns; they never
  change the repository and never submit or replace your workflow result,
  which still goes only through the result tool your instructions name.
- The authority ends with the turn. A later turn of the same session gets a
  fresh one and can still read and repair the session's earlier artifacts.
