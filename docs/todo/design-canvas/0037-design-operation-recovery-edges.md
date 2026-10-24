# Design operation recovery edges

Checked against `main` at `2459b05c` (2026-10-15); the correlation-id item
was re-checked and closed against `9906db30` (2026-10-16). Items 1–3 were
fixed and re-checked against `06297124` (2026-10-23). Item 4, the pre-digest
receipt fallback, was retired on 2026-10-24 once
[0034](../cross-cutting/0034-mixed-version-compatibility.md) set the support
window. Nothing is left.

Design edits are recoverable operations: every submitted edit should end in a
truthful terminal outcome and never run twice
([`design-canvas.md`](../../architecture/design-canvas.md), "Operations"). A
client that loses a response reconciles by reading status, so the status it
reads must be exact. The three restart and renderer edges this file tracked
are fixed, and the pre-digest receipt fallback is retired (see "Done").

## Current state

- A correlation id is bound to its input while pending and once settled.
  `intentDigest` (`core/design/records.ts`) hashes the canonical JSON of the
  validated descriptor; the record keeps it per correlated receipt in the
  private `receiptDigests` index (`addReceipt`, pruned with the receipts by
  `pruneReceipts`). `prepare` and `settledCorrelation` in
  `core/design/service.ts` (through `settledUnder`), `submit` in
  `core/design/tools.ts` and `prepareCreate`/`findCreate` in
  `core/design/service-lifecycle.ts` all apply `settledMatches`; a mismatch
  throws `reusedCorrelation` (`core/design/errors.ts`). Tests:
  `mcp.test.ts` ("submit_operation is idempotent by correlationId…", "a
  receipt settled before digests were kept refuses every retry"), `operations.test.ts` ("a
  settled correlation id refuses different input at preparation", "a create
  prepared twice…", "a correlation id binds style order but not other key
  order") and `records.test.ts` (digest pruning, key and style order).
- A receipt with no kept digest (settled before `receiptDigests` existed, in
  a build older than v2.21.0) never matches: `settledMatches` takes only the
  stored digest, so the retry is refused with `reusedCorrelation`, runs
  nothing, and `operation_status` still answers from the receipt. Digests
  first shipped in v2.21.0 (2026-10-16), the floor of the support window.
- A dead owner's unsettled entry resolves through `deadOutcome`
  (`core/design/service.ts`): `interrupted`, or `committed` for a duplicate
  whose copy exists (`committedDuplicate` in `service-lifecycle.ts`).
  Restart recovery, `status`, `execute`, `cancel` and a running peer use it.
- On a never-migrated legacy canvas, dead owners' pending entries stay in the
  pending file as their outcomes (`retainedOutcomes`, `settleDead`,
  `fittingOutcomes`), and the migrating commit turns them into receipts
  (`keepRetainedOutcomes`, called from `commit`).
- The renderer launches each generation through `launchDesignBrowser`
  (`core/design/renderer.ts`): a loopback browser server plus `connect`, so
  `terminate` can close it and then kill it.

## Outstanding work

None.

## Done

4. **Pre-digest receipt fallback retired** (2026-10-24). 0034 set the support
   window: published releases from the floor, v2.21.0 today
   ([`version-compatibility.md`](../../architecture/version-compatibility.md)).
   Every backend in it keeps digests (`receiptDigests` is in v2.21.0, #1021),
   so this item's condition is met. `settledMatches`
   (`core/design/records.ts`) now takes only the stored digest and the
   descriptor, and a missing digest is a mismatch, as recorded below. The
   three callers (`service.ts`, `service-lifecycle.ts`, `tools.ts`) pass the
   digest only. Evidence: `mcp.test.ts` ("a receipt settled before digests
   were kept refuses every retry") strips the digest index from a settled
   record, then shows that an identical retry and a changed one are both
   refused as a different edit, the canvas revision does not move, and
   `operation_status` still returns the original receipt. The design suite
   (`apps/backend/src/core/design`) passes.
1. **Restart interruptions on legacy canvases** (2026-10-23). Recovery no
   longer drops a dead owner's entries on a never-migrated canvas; they stay
   in the pending file as the canvas's outcomes. `status` answers
   `interrupted` from them, `execute` and `cancel` answer the same without
   writing (so nothing migrates), and a retry with the same correlation id is
   refused as settled, or as a different edit. `submit_operation` replays the
   outcome for the same edit (`settledCorrelation`). Prepare keeps them while
   they fit the 8-entry and 8 MiB pending bounds; the oldest give way to new
   edits. The first real edit's commit migrates the canvas and records them as
   receipts with their intent digests. Evidence: `records.test.ts` ("restart
   reports a never-migrated canvas's admitted edits as interrupted without
   migrating it", "a never-migrated canvas keeps restart outcomes within the
   pending bounds"). Both failed on `06297124` (status answered `unknown`
   with `expired-operation`) and pass with the change.
2. **Truthful interrupted duplicates** (2026-10-23). Reproduced in
   `lifecycle.test.ts` ("a duplicate stopped between its copy and its source
   receipt") with the storage fault hooks failing the source record's rename
   after the copy committed. On `06297124` three outcomes were wrong:
   in-process, a single failed source write left the source operation
   `rejected` beside the copy (a variant this file had not recorded); after a
   restart it was `interrupted`; and a running peer answered `interrupted`
   before any recovery. In each case the client's "submit it again" would
   have made a second copy. Now all three are `committed` with
   `createdCanvasId` and the copied revision, and a correlated retry is
   refused as settled. The live duplicate's receipt also reports the copied
   revision (the precondition), so a receipt rebuilt from the copy is
   identical. After Multi Review the live owner is covered too: while the
   source receipt keeps failing to save, execute answers `committed` and keeps
   the entry; status and later executes (also past the entry's TTL) answer
   from the copy; and the next duplicate on that canvas records the missing
   receipt first, refusing with `unknown-outcome` only while that write still
   fails (`lifecycle.test.ts`: "reconciles a committed copy on its live owner
   while source writes keep failing", "a later duplicate records an unsaved
   one's receipt once saving works", "an unsaved duplicate executed after its
   entry expired still reports its copy", "status prefers a committed copy
   over an unrecorded live-owner failure").
3. **Renderer termination proved and fixed** (2026-10-23). Fault probe on
   macOS (arm64, Bun 1.4.2, `playwright-core` 1.64.0, Playwright's Chromium
   build 1248): with `chromium.launch()`, a browser stopped with `SIGSTOP` did
   not finish `browser.close()` within 3 s, `process()` was `undefined`, and
   the browser process was still running afterwards. With
   `chromium.launchServer({ host: "127.0.0.1" })` plus `chromium.connect`,
   launch and connect took about 340 ms, the server listened on loopback only,
   and `BrowserServer.kill()` ended the stopped process in 14 ms. The renderer
   now launches that way; `terminate` closes the server within the cleanup
   deadline and kills it, also bounded, when the close hangs or fails.
   Evidence: `renderer.test.ts` ("kills a browser whose close hangs instead
   of leaving it running", real Chromium, skipped where Chromium is missing
   and on Windows). After Multi Review, a generation whose connection drops is
   retired the same way, because the server process can outlive its
   connection ("terminates an owned server after its browser connection
   disconnects and renders with a replacement"). With the kill replaced by a no-op the test fails ("condition
   not met": the process survived), so it detects the leak. The fake-browser
   cases now cover the kill through the launch handle.

## Assumptions and decisions

- **Item 1: keep outcomes in the pending file, not migrate.**
  - *Options:* (a) migrate the canvas during recovery and write `interrupted`
    receipts; (b) have `status` infer `interrupted` for a dead-owner token on
    a legacy canvas while recovery keeps the entries; (c) a new sidecar file
    of outcomes per legacy canvas.
  - *Choice:* (b), with the migrating commit folding the kept entries into
    receipts.
  - *Why:* (a) breaks the rule that a never-migrated document is read
    directly until its first real edit. (c) adds a file kind that deletion,
    the orphan sweep and older backends would all have to learn. (b) needs no
    new storage: `status` already answered `interrupted` for a dead owner's
    entry, and the entry already has the descriptor a receipt needs.
  - *Pros:* no migration on recovery or on reading; same answers as migrated
    canvases; older backends sharing the directory read the file unchanged
    (no new fields, no new state value).
  - *Cons:* outcomes compete for the 8 pending slots and 8 MiB with new
    edits. The oldest give way, and one that gives way answers `unknown` as
    before; that needs more than eight edits admitted before a crash and no
    edit committed since. An older backend's recovery still drops them.
- **Item 1: answers that write nothing.** `execute` and `cancel` of a kept
  outcome answer `interrupted` without a commit, because writing the receipt
  would migrate the canvas without an edit. Only a commit that changes the
  canvas, or a committed duplicate, migrates it.
- **Item 2: record the duplicate as committed rather than document
  `interrupted` as harmless.**
  - *Options:* detect the deterministic copy and record `committed` with
    `createdCanvasId`; or keep `interrupted` and document it.
  - *Choice:* detect the copy.
  - *Why:* `interrupted` tells the client to review and submit again, and a
    new submission has a new token and therefore a new copy id, so the
    deterministic id does not stop a second copy. It only stops the same
    token from copying twice.
  - *Pros:* status is exact on every path (in-process failure, restart,
    peer); the client never duplicates twice.
  - *Cons:* one extra record read for duplicate entries on these paths. A copy
    purged before recovery runs is not found, so that duplicate reads as
    `interrupted`; a copy that was deleted (still in the recycle bin) counts.
- **Item 2: the receipt's `canvasRevision` is the copied revision**, the
  duplicate's `canvasRevision` precondition, which execution has checked
  equals the source at copy time. Before, the live path used the source's
  revision when the receipt was written; the two differ only if the source
  changed between the copy and the receipt. Reporting what was copied lets
  recovery rebuild an identical receipt.
- **Item 3: loopback browser server rather than a supervised worker
  process.**
  - *Options:* `chromium.launchServer` plus `connect`; a dedicated render
    worker process under a supervisor; find the browser's PID by a marker
    argument and `pgrep`.
  - *Choice:* the browser server, bound to `127.0.0.1`.
  - *Why:* the fault probe showed it fixes the leak with Playwright's own
    process handle and works under Bun. A worker process adds a second
    supervision protocol, IPC bounds and fatal-rejection wiring for the same
    result. A marker and `pgrep` is platform-specific and could match an
    unrelated process.
  - *Pros:* `close` then `kill` is exact and bounded; no new process
    protocol; the renderer's generation and deadline logic is unchanged.
  - *Cons:* the browser is reachable over a loopback WebSocket instead of a
    private pipe. Any local process that learned the endpoint's random GUID
    path could drive it; the path is not logged by the renderer, and the
    renderer's contexts hold no credentials (every request is aborted). The
    connection adds a WebSocket hop per Playwright call, which the existing
    real-Chromium cases ran within the production budgets.
- **Item 3, assumption:** the kill was proved on macOS with Playwright's
  bundled Chromium. Linux uses the same Playwright code path
  (`BrowserServer.kill()` sends `SIGKILL` to the spawned process), so it is
  expected to behave the same; it was not run here. Windows has no
  `SIGSTOP`, so the fault test skips there.
- **Item 4: defer, do not retire yet.**
  - *Options:* retire now and refuse every receipt with no digest; retire
    now but replay every receipt with no digest; keep the fallback until the
    support window allows.
  - *Choice:* keep it, register it in 0034's compatibility-path index, and
    record the removal semantics (missing digest means mismatch).
  - *Why:* the item's own condition is not met (digests shipped seven days
    ago), backends older than 2.21.0 may still write digest-less receipts into
    a shared data directory, and replaying every digest-less receipt would
    bring back the original bug.
  - *Pros:* no identical retry of an older receipt is refused as a
    "different edit".
  - *Cons:* until then, a reused id that changes only the input body still
    replays a pre-digest receipt.
  - *Superseded 2026-10-24:* 0034 decided the window (floor v2.21.0), which
    met the condition, so the fallback was retired with the recorded
    semantics. Pro: a reused id can no longer replay a receipt for a
    different body. Con: an identical retry of a receipt settled by a pre-2.21
    source build is now refused; the client reconciles through
    `operation_status`, and no published release wrote such receipts.

## Constraints and rationale

- Unknown outcomes are never redispatched blindly; the client reconciles by
  status and never prepares again.
- Expired or pruned tokens never become executable again, and a restored
  canvas gets a new incarnation so old tokens stay dead.
- Do not relax compare-and-swap preconditions to make recovery simpler.
- Legacy one-shot adapters (`design_action`, the per-action MCP tools) keep
  their original response shapes.
- Never-migrated legacy documents are read directly until their first real
  edit, and reading never migrates. Recovery and the answers about a kept
  outcome do not migrate either.
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
    descriptors (no stored value needed), so pending and settled agree. A
    kept outcome on a legacy canvas counts as settled.
  - *Settled:* `submit_operation` replays the stored receipt (or a kept
    outcome) only on a match; `prepare` keeps refusing any settled id but
    names a mismatch as "different edit". `find_operation` and
    `operation_status` are unchanged.
  - *Storage:* a backend-private `receiptDigests` map on the record keyed by
    token, not a field on the receipt, so `DesignOperationStatus` and every
    response stay byte-identical. It is counted inside the 128 KiB receipt
    budget and pruned with its receipts. Records are parsed with
    `passthrough`, so an older backend sharing the directory keeps the map.
  - *Older receipts:* a receipt with no digest never matches, so even an
    identical retry is refused (item 4, retired 2026-10-24).
  - *Clients:* the renderer never reuses an id for new input (a new intent,
    `resume` and `runDesignLifecycle` mint fresh ids) and uses
    prepare/execute, not `submit_operation`, so its retry paths are
    unaffected. Only an MCP agent that reuses an id for a different edit sees
    the new error, where it used to get the old receipt as if it had run.

## Related

- [0036-design-canvas-qualification.md](0036-design-canvas-qualification.md), whose
  real-container export run exercises the same reconciliation rules.
- [0034-mixed-version-compatibility.md](../cross-cutting/0034-mixed-version-compatibility.md)
  decided the support window that retired item 4;
  [`version-compatibility.md`](../../architecture/version-compatibility.md)
  lists it as retired. The never-migrated legacy canvas path reads user data
  and is not governed by the window.
- Flake [0215](../../tests/flaky-tests/design-canvas-and-artifacts/0215-design-operation-replay-event-count.md)
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
