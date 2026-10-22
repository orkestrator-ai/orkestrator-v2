# Design operation recovery edges

Checked against `main` at `2459b05c` (2026-10-15); the correlation-id item
was re-checked and closed against `9906db30` (2026-10-16).

Design edits are recoverable operations: every submitted edit should end in a
truthful terminal outcome and never run twice
([`design-canvas.md`](../../architecture/design-canvas.md), "Operations"). A
client that loses a response reconciles by reading status, so the status it
reads must be exact. Three edges give a less precise outcome than that
promise, and one renderer edge can leave a hung Chromium process running.
(A fourth edge, a reused correlation id with different input replaying a
settled receipt, is fixed; see "Constraints and rationale".)

## Current state

- A correlation id is bound to its input while pending and once settled.
  `intentDigest` (`core/design/records.ts`) hashes the canonical JSON of the
  validated descriptor; the record keeps it per correlated receipt in the
  private `receiptDigests` index (`addReceipt`, pruned with the receipts by
  `pruneReceipts`). `submit` in `core/design/tools.ts`, `prepare` in
  `core/design/service.ts` and `prepareCreate`/`findCreate` in
  `core/design/service-lifecycle.ts` all apply `settledMatches`; a mismatch
  throws `reusedCorrelation` (`core/design/errors.ts`). Tests:
  `mcp.test.ts` ("submit_operation is idempotent by correlationId…", "a
  receipt settled before digests were kept…"), `operations.test.ts` ("a
  settled correlation id refuses different input at preparation", "a create
  prepared twice…", "a correlation id binds style order but not other key
  order") and `records.test.ts` (digest pruning, key and style order).
- Restart recovery (`recoverPendingFor` in `core/design/service.ts`) writes
  `interrupted` receipts only for migrated records. On a never-migrated legacy
  canvas (`loaded.legacy`) it rewrites the pending file without the dead
  owner's entries and records nothing, so `status()` later answers `unknown`
  with `expired-operation` instead of `interrupted`.
- `executeDuplicate` (`core/design/service-lifecycle.ts`) commits the copy
  under a deterministic id (`tokenUuid(entry.token)`) inside the global guard,
  then writes the source receipt in the source lane. A crash between the two
  leaves a live copy while recovery records the source operation as
  `interrupted`.
- Renderer shutdown (`terminate` in `core/design/renderer.ts`) closes the
  browser within the cleanup deadline and then calls `killBrowserProcess`,
  which works only when the browser exposes `process()`. Browsers from
  `chromium.launch()` do not (in the pinned `playwright-core` 1.64.0 only
  `BrowserServer` has `process()`), so a hung `close()` is bounded and the
  generation retired, but the process may keep running.

## Outstanding work

### Code

1. **Report restart interruptions on legacy canvases.** Give pending entries
   on never-migrated canvases the same outcome as migrated ones: either write
   `interrupted` receipts (which needs a migration on that path, since a
   legacy document has nowhere to keep receipts) or have `status()` report
   `interrupted` for a dead-owner token on a legacy canvas. Done when "the
   backend restarted before commit" is distinguishable from "expired" on both
   paths.
2. **Make an interrupted duplicate truthful.** Reproduce the crash between the
   copy commit and the source receipt in `lifecycle.test.ts` with the storage
   fault hooks. On recovery, either detect the deterministic destination and
   record the source operation as `committed` with `createdCanvasId`, or
   document why an `interrupted` outcome beside an existing copy is harmless
   (the deterministic id already stops a second copy).
3. **Prove or fix renderer termination.** Write a fault test showing whether a
   hung `browser.close()` leaves a Chromium process behind. If it does, launch
   through a handle that exposes the process (`chromium.launchServer()` plus a
   connection, or a dedicated render worker process under a supervisor with
   the repository fatal-rejection guard). Choose from the demonstrated fault,
   not from assumptions about the API.
4. **Retire the pre-digest receipt fallback** (low; no index line). Receipts
   settled before `receiptDigests` existed are compared on kind,
   preconditions, gesture and client ids only, so a reused id that changes
   only the input body still replays them. They age out of the 128-receipt
   window; once a release has shipped long enough, drop the fallback in
   `settledMatches` and treat a missing digest as "replay only".

## Constraints and rationale

- Unknown outcomes are never redispatched blindly; the client reconciles by
  status and never prepares again.
- Expired or pruned tokens never become executable again, and a restored
  canvas gets a new incarnation so old tokens stay dead.
- Do not relax compare-and-swap preconditions to make recovery simpler.
- Legacy one-shot adapters (`design_action`, the per-action MCP tools) keep
  their original response shapes.
- Never-migrated legacy documents are read directly until their first real
  edit, and reading never migrates. A fix for item 1 must not migrate on read.
- Renderer recovery fails a dead generation's jobs exactly once and never
  reruns a semantic edit in a new generation.
- **Correlation ids follow the public API's request-key rule** (compare
  `intentFingerprint` in `core/public-api/operation-ledger.ts`): same key and
  same input replays; same key and different input is refused and runs
  nothing.
  - *Fingerprint:* the whole validated descriptor (`canvasId`, `input`,
    `preconditions`, `predecessor`, `gestureId`, `clientId`,
    `correlationId`) as canonical JSON, so a retry that regenerates the call
    with another key order still matches. `styles` maps (top level and in a
    batch) keep their order as entry lists, because `applyStyles` sets them
    in order and a shorthand before or after its longhand gives a different
    result.
    Environment and canvas scope come from where the receipt is looked up.
    It is separate from the token's `digest`, which binds environment,
    canvas and descriptor bytes and is re-verified at execute; changing that
    would invalidate pending entries across an upgrade.
  - *Error:* `invalid-input`, retry `never`, message "This correlation id was
    already used for a different edit", `details.token` naming the original
    operation. No new failure code: `conflict` means "refresh and retry",
    which would loop on the same id, and a protocol code would need renderer
    mapping for a path the renderer never takes.
  - *Pending:* `prepare` compares intent digests of the stored and incoming
    descriptors (no stored value needed), so pending and settled agree.
  - *Settled:* `submit_operation` replays the stored receipt only on a match;
    `prepare` keeps refusing any settled id but names a mismatch as "different
    edit". `find_operation` and `operation_status` are unchanged.
  - *Storage:* a backend-private `receiptDigests` map on the record keyed by
    token, not a field on the receipt, so `DesignOperationStatus` and every
    response stay byte-identical. It is counted inside the 128 KiB receipt
    budget and pruned with its receipts. Records are parsed with
    `passthrough`, so an older backend sharing the directory keeps the map;
    receipts it writes simply have no digest and use the fallback below.
  - *Older receipts:* with no digest, kind, preconditions, gesture and client
    ids are compared; an identical retry still replays.
  - *Clients:* the renderer never reuses an id for new input (a new intent,
    `resume` and `runDesignLifecycle` mint fresh ids) and uses
    prepare/execute, not `submit_operation`, so its retry paths are
    unaffected. Only an MCP agent that reuses an id for a different edit sees
    the new error, where it used to get the old receipt as if it had run.

## Related

- [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md), whose
  real-container export run exercises the same reconciliation rules.
- [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md): the
  never-migrated legacy canvas path is a compatibility path.
- Flake [0215](../../tests/flaky-tests/0215-design-operation-replay-event-count.md)
  (resolved): the lost-execute and duplicate-execute case now holds the
  background validation before it counts hints.
- [`design-canvas.md`](../../architecture/design-canvas.md) ("Operations",
  "Concurrency and bounds", "Renderer").

## Replaces

- `docs/improvements/design-space/plan/00-index.md` (known residual edges and
  the Playwright process-handle deviation)
- `docs/improvements/design-space/plan/02-operation-contracts-and-durability.md`
  (residual edges; the rest is done)
- `docs/improvements/design-space/plan/03-client-controller-and-reconciliation.md`
  (done; nothing outstanding)
- `docs/improvements/design-space/plan/04-renderer-scheduling-and-recovery.md`
  (hung-close limitation; the second-worker evaluation is in
  [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md))
