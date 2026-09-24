# 14 — Storage, rendering, and MCP efficiency

Status: Planned; measurements select optional optimizations.  
Dependencies: [04](04-renderer-scheduling-and-recovery.md),
[05](05-safe-saving-and-export.md), [07](07-history-and-document-lifecycle.md),
[11](11-agent-context-and-handoff.md), [12](12-incremental-synchronization.md),
[13](13-visible-frame-and-layer-rendering.md).  
Findings: E3.

## Outcome

Avoid provably redundant revisions, whole-document reads for library metadata,
repeated identical captures, and large HTML responses when agents need only an
acknowledgment. Optimize measured costs without weakening atomic commits,
recovery history, sandboxing, or portable files.

## Owners and measurements first

Use the service/private-record/history owners, renderer scheduler,
`design-tools.ts`, `commands-registry-design.ts`, and library/controller clients.
Measure on synthetic documents using the step-01 fixture matrix:

- Admission and queue delay, parse/render/capture time, serialization/write/sync
  time, and response/decoded bytes.
- Current-record, receipt, history, temporary-file, and cache bytes separately.
- Cold/warm list latency at 1/50/256 canvases; changed/no-op edit counts.
- Browser startup/context setup versus actual DOM work.
- MCP input/output bytes and call count for a representative design/refinement
  cycle. Token counts are estimates unless measured by the provider.

Report hardware, runtime versions, local/container/remote path, competing load,
document size, and sample counts. Do not log design content to explain a timing.

## Required optimization A: explicit no-op results

- [ ] Detect exact metadata/geometry assignments that equal authoritative values
  before rendering. Detect byte-identical raw HTML replacement without claiming
  semantic equivalence between different markup strings.
- [ ] For style operations, compare accepted authored values after validation;
  a computed-value match alone is not proof of no-op because cascade/overrides
  may differ.
- [ ] Return an acknowledged no-change outcome: document/frame revisions do not
  increment, no content event emits, and no history checkpoint is added.
- [ ] Still provide a durable terminal receipt for recoverable operations. With
  step-02's single private record this can require an atomic record write; do
  not claim zero disk I/O or split receipt persistence unsafely just to save it.
- [ ] Explain no visible change appropriately in the inspector without treating
  it as failed persistence.

## Required optimization B: bounded transactional batches

- [ ] Add a same-canvas batch descriptor with at most sixteen operations and
  512 KiB aggregate decoded input initially, also respecting global admission
  and 4 MiB resulting-document limits.
- [ ] Scope the first implementation to compatible operations whose read/write
  set and preconditions are explicit. Disallow cross-canvas transactions and
  implicit selector retargeting after a preceding structural mutation.
- [ ] Validate all inputs, execute on one immutable working state, perform one
  final CAS/atomic commit, create one grouped history entry, and return one
  operation receipt plus bounded per-operation results.
- [ ] Define frame revisions as advancing once per changed frame per committed
  batch and canvas revision once per batch; no-op-only batches preserve both.
- [ ] Failure in any operation leaves the old document intact. Do not expose
  partial application as a successful batch.
- [ ] Batch only deliberately grouped user/agent intent. Never buffer arbitrary
  accepted edits for an unbounded period to increase throughput.

## Required optimization C: metadata-only listing

- [ ] Maintain a bounded summary index containing environment/canvas identity,
  name, revision, modified time, frame count, validation/export status, and
  thumbnail reference. Persist/rebuild it as a derived view of private records.
- [ ] Update summaries after durable commits; do not let a summary announce a
  revision whose document did not persist. Recover index drift on startup or
  explicit reconciliation without rescanning all HTML on every dialog open.
- [ ] Bound directory scan, parsing, and concurrency at startup. Treat corrupt
  files as recoverable entries/diagnostics without hiding healthy canvases.
- [ ] Page/sort/search summaries deterministically. A stale list item is checked
  against the authoritative document before opening/editing.
- [ ] If out-of-process edits to private backend records are unsupported, state
  that clearly; imports go through the import command. Do not add uncontrolled
  filesystem watchers solely to preserve an undocumented behavior.

## Required optimization D: compact agent operations and direct save

- [ ] Offer versioned compact mutation results: operation state, canvas/frame
  revisions, changed fields, validation summary, and explicit content retrieval
  options. Keep legacy tool response shapes until clients negotiate support.
- [ ] Add a constrained `save_canvas` tool backed by step-05 export behavior.
  It accepts an environment-scoped relative filename, exact revision, and
  destination precondition; it returns a path/revision receipt, not the full JSON.
- [ ] A collision requires a new path or a deliberately supplied replacement
  precondition. An agent cannot bypass safe overwrite rules by using this tool.
- [ ] Keep `export_canvas` for explicit portable-content retrieval and `get_frame`
  for targeted content. Update launch guidance to avoid copying the whole export
  through a language-model response merely to save it.
- [ ] Make operation-status reads compact and side-effect free. Bound text/image
  results before MCP encoding; oversized capture/report errors remain useful.

## Conditional optimization E: capture/inspection cache

Implement only if measurements show meaningful repeated work:

- [ ] Key by backend/canvas/frame incarnation, content identity, viewport, runtime
  and sanitizer version, browser generation/version as needed, scale, color
  scheme, and operation parameters. Same HTML at a different viewport is a
  different capture; same selector after structural change is a different inspect.
- [ ] Start with the index's 64-entry/64-MiB budget. Account for PNG/base64 copies,
  decoded metadata, and in-flight computations. Single-flight identical requests
  without coupling one caller's cancellation to all other callers.
- [ ] Keep cached artifacts private and environment-authorized on read. Expiry
  or eviction affects performance only; current documents remain authoritative.
- [ ] Invalidate or render deterministic handling for animated/time-dependent
  content. Do not cache unstable CSS animation frames as permanent truth.
- [ ] Thumbnail and user capture share safe artifacts where compatible, while
  foreground work keeps scheduler priority and fairness guarantees.

## Conditional optimization F: context reuse or storage redesign

Do not implement by default. If context startup dominates after other work,
evaluate a small warm pool with proven full reset of DOM, origin/storage,
listeners, routes, permissions, and request state between jobs. Compare it to
fresh isolated contexts, including memory and adversarial failure tests.

If full private-record rewrites dominate, write a separate storage decision
document comparing bounded immutable snapshots/manifest indirection against a
journal/database. It must preserve document+receipt atomicity, crash recovery,
history retention, and v1 export. An asset-store/package format requires an
explicit versioned import/export plan and is outside this step's default scope.

## Tests and completion criteria

- [ ] No-op operations produce no new document revision/history/content event.
- [ ] Batch failure, duplicate execute, and response loss preserve atomicity.
- [ ] Batches reject size/count/CAS violations before publishing partial state.
- [ ] List remains available with a corrupted index, repaired from valid records;
  normal listing does not parse every canvas body.
- [ ] Compact tool flow and direct save produce the same design/file as legacy
  content-heavy flow, including container and collision cases.
- [ ] Cache keys distinguish viewport, content, structure, runtime, and environment;
  cache eviction and browser restart cannot return mislabeled results.
- [ ] Required A–D work has measured before/after evidence. Conditional E/F are
  either justified and verified or explicitly marked deferred with measurements.

Review each required optimization separately. A performance regression or
unproven cache must be independently removable without reverting safety fixes.
