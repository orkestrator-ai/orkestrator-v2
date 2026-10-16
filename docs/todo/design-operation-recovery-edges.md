# Design operation recovery edges

Checked against `main` at `2459b05c` (2026-10-15).

Design edits are recoverable operations: every submitted edit should end in a
truthful terminal outcome and never run twice
([`design-canvas.md`](../architecture/design-canvas.md), "Operations"). A
client that loses a response reconciles by reading status, so the status it
reads must be exact. Three edges give a less precise outcome than that
promise, and one renderer edge can leave a hung Chromium process running.

## Current state

- `submit_operation` (the `submit` closure in `designActions`,
  `apps/backend/src/core/design/tools.ts`) looks up a settled receipt by
  `correlationId` and returns `compactStatus(settled)` without comparing the
  input. `create_canvas` does the same through `findCreate`
  (`core/design/service-lifecycle.ts`). Terminal receipts
  (`DesignOperationStatus` in `packages/protocol/src/design-operations.ts`)
  carry no descriptor digest. Pending entries do, so `DesignService.prepare`
  already rejects a pending entry whose `descriptorDigest` differs ("This
  correlation id was already used for a different edit"), but not a settled
  one.
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

1. **Reject a reused correlation id with different input.** Keep a bounded
   descriptor digest on terminal receipts (inside the existing 128-receipt,
   128 KiB budget), or a digest index keyed by `correlationId`. Compare it in
   `submit` and `findCreate`, and return `invalid-input` with the same message
   `prepare` uses when it differs. An identical retry must stay idempotent,
   and `find_operation` keeps returning the stored receipt.
2. **Report restart interruptions on legacy canvases.** Give pending entries
   on never-migrated canvases the same outcome as migrated ones: either write
   `interrupted` receipts (which needs a migration on that path, since a
   legacy document has nowhere to keep receipts) or have `status()` report
   `interrupted` for a dead-owner token on a legacy canvas. Done when "the
   backend restarted before commit" is distinguishable from "expired" on both
   paths.
3. **Make an interrupted duplicate truthful.** Reproduce the crash between the
   copy commit and the source receipt in `lifecycle.test.ts` with the storage
   fault hooks. On recovery, either detect the deterministic destination and
   record the source operation as `committed` with `createdCanvasId`, or
   document why an `interrupted` outcome beside an existing copy is harmless
   (the deterministic id already stops a second copy).
4. **Prove or fix renderer termination.** Write a fault test showing whether a
   hung `browser.close()` leaves a Chromium process behind. If it does, launch
   through a handle that exposes the process (`chromium.launchServer()` plus a
   connection, or a dedicated render worker process under a supervisor with
   the repository fatal-rejection guard). Choose from the demonstrated fault,
   not from assumptions about the API.

## Constraints and rationale

- Unknown outcomes are never redispatched blindly; the client reconciles by
  status and never prepares again.
- Expired or pruned tokens never become executable again, and a restored
  canvas gets a new incarnation so old tokens stay dead.
- Do not relax compare-and-swap preconditions to make recovery simpler.
- Legacy one-shot adapters (`design_action`, the per-action MCP tools) keep
  their original response shapes.
- Never-migrated legacy documents are read directly until their first real
  edit, and reading never migrates. A fix for item 2 must not migrate on read.
- Renderer recovery fails a dead generation's jobs exactly once and never
  reruns a semantic edit in a new generation.

## Related

- [design-canvas-qualification.md](design-canvas-qualification.md), whose
  real-container export run exercises the same reconciliation rules.
- [mixed-version-compatibility.md](mixed-version-compatibility.md): the
  never-migrated legacy canvas path is a compatibility path.
- Flake [0215](../tests/flaky-tests/0215-design-operation-replay-event-count.md)
  (resolved): the lost-execute and duplicate-execute case now holds the
  background validation before it counts hints.
- [`design-canvas.md`](../architecture/design-canvas.md) ("Operations",
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
  [design-canvas-qualification.md](design-canvas-qualification.md))
