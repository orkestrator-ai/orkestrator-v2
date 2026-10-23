# Web annotation known limitations

Checked against `main` at `2459b05c` (2026-10-15).

These are code gaps in the shipped annotation workflow. Some appear under
"Known limitations" in
[web-page-annotations.md](../../architecture/web-page-annotations.md); others are
things the plan required that never landed. Each gap is small. Together they
decide how far a reviewer can trust the evidence, the provenance labels and the
request card's status. None of them may give a page or an agent the power to
resolve, retarget or dispatch work.

## Current state

- Region crops: `WebAnnotationRegionTarget.parentCaptureId`
  (`packages/protocol/src/web-annotations.ts`) is in the contract and in
  validation (`web-annotations-validation.ts`). Electron main strips any
  page-supplied value ("capture-forged" in
  `apps/desktop/tests/browser-preview-manager-capture.test.ts`) and never sets
  one. The crop is stored as the capture's second asset (`cropPng` in
  `browser-preview-capture-image.ts`), with no recorded relation to the full
  viewport image.
- Pins: `BrowserPreviewAnchorResult` carries `documentGeneration`
  (`apps/desktop/electron/browser-preview-capture-pins.ts`), but
  `useAnnotationPins`
  (`apps/web/src/components/browser/annotations/useAnnotationPins.ts`) builds
  its result map (`resultMap`) without comparing it. After Show on page
  navigates, the pins of the page being left stay on screen until the next
  refresh.
- File checks: `checkWebAnnotationWorkspacePaths`
  (`apps/backend/src/core/web-annotation-source-checks.ts`) checks containment
  and existence only for local worktrees (200 paths, 2 s deadline). It reports
  every path in a container workspace as `unavailable`. The container file
  commands (`read_container_file`, `write_container_file` and others in
  `commands-registry-terminal.ts`) have no existence-only check.
- Capture producer: validation accepts `desktop-native`, `text-only` or
  `result-capture` from the client (`web-annotations-validation.ts`), so a
  gateway client can label its capture `desktop-native`. Provenance is still
  assigned by the server.
- Discuss: `WebAnnotationDispatchAdapter.capabilitiesFor`
  (`apps/backend/src/core/web-annotation-dispatch.ts`) sets `planMode` only
  when `composer.modeScope === "turn"`, which today means Claude
  (`nativeAgentCapabilities` in `packages/protocol/src/native-agent.ts`). Codex,
  Cursor and Grok have session-scoped modes; OpenCode and Pi have
  `mode: false`. For those providers `DestinationPicker.tsx` labels Discuss
  "advisory (no read-only mode)", and it runs under the session's existing
  permissions.
- Turn outcome and interactions: `sessionTurnOutcome` and
  `sessionPendingInteractions` (`native-agent-interaction-tracker.ts`) read through
  `observeProvider`, which never starts a bridge. Several cases leave the
  outcome `unknown`: no running bridge after three attempts, a status that is
  neither idle nor error, or a later request dispatched first. When no live
  read is possible, interactions fall back to `cachedProjectionSnapshot`. If
  that has none, the request card offers Answer in chat
  (`RequestInteractions.tsx`).
- Review tray: `batchEvidenceBudget` (`BatchReviewTray.tsx`) counts image
  bytes only for assets already fetched, and estimates note text. The backend
  checks both exactly when preparing the batch.
- Metrics: `WebAnnotationMetrics` (`apps/backend/src/core/web-annotation-metrics.ts`)
  records command, capture, change-feed, GC, migration, storage-commit,
  request-transition, queue-hold and unconfirmed series. Only tests read
  `web_annotations_metrics` (`web-annotation-rollout.test.ts`,
  `web-annotation-convergence.test.ts`).

## Outstanding work

### Code

1. Region crop provenance. Either have Electron main assign
   `parentCaptureId` (or an equivalent host-assigned crop-to-parent relation on
   the capture's assets), so the full-viewport context can be recovered for
   comparison, or remove the field from the contract and validation. Never
   accept a page-supplied value.
2. Pin generations. In `useAnnotationPins`, discard anchor results whose
   `documentGeneration` is older than the tab's current document, so a
   navigation never leaves the previous page's results on screen.
3. Container file checks. Add a containment and existence check for container
   workspaces with the same limits (200 paths, 2 s deadline, never read file
   contents). Resolve symlinks inside the container root before answering. It
   probably needs a new bounded backend helper, because no existing container
   file command fits.
4. Producer attestation. Either have Electron main attest the captures it
   produced (bound to the capture id it assigned), or show the producer as
   unverified for captures that arrive through the gateway. Provenance stays
   server-assigned either way.
5. Discuss outside Claude. Implement the planned fallback: when read-only
   execution would need a change to a live session's mode, offer a separate,
   compatible discussion session instead. Where none exists, keep the advisory
   label. Never relax permissions, and never switch a running session's mode
   silently.
6. Fewer `unknown` outcomes. After the live runs in
   [0044-web-annotation-qualification.md](0044-web-annotation-qualification.md), find
   which providers and paths still end at `unknown` or Answer in chat, and
   close the common ones. Do not hydrate idle sessions, start bridges from the
   reconciler, or poll tab-facing bridge routes to do it.
7. Review-tray capacity. Add per-capture asset byte sizes to annotation
   summaries, so the tray can match the backend's exact preparation check
   without fetching images.
8. Observability. Add the series the plan asked for and the metrics still
   lack: desktop pending-spool depth and bytes, anchor resolution rule
   outcomes, evidence omissions, time to acceptance, and reopen count. Decide
   whether anything should read `web_annotations_metrics` (diagnostics view,
   export) or whether tests stay the only consumer. Labels stay categorical:
   no URLs, selectors, text, paths or ids.
9. Reword code comments that cite deleted plan steps:
   `browser-preview-capture-responsive.ts`, `web-annotation-migration.ts`,
   `web-annotation-gateway-scope.test.ts`,
   `web-annotation-migration-compat.test.ts`,
   `web-annotation-convergence.test.ts`, `lib/web-annotations/sync.ts`,
   `capture-commit.ts`, `compose-migration.ts`, and in
   `components/browser/annotations/` `useAnnotationCapture.ts`,
   `useAnnotationDraft.ts`, `useThreadHistory.ts` and `format.ts`, and the
   header of `web-annotations-electron.spec.ts`.

## Constraints and rationale

- Evidence stays untrusted. Provenance is assigned by the receiving boundary,
  never by the payload.
- Nothing here may let an agent or a page resolve, retarget or dispatch.
- Uncertain anchor matches stay explicit (`ambiguous`, `stale`, `missing`).
  They are never retargeted. Geometry never establishes identity.
- The reconciler reads storage and in-memory activity only. It never polls
  tab-facing bridge routes or hydrates idle sessions.
- File checks never read contents, and never follow a path outside the
  workspace.

## Open questions

- Crop relation: implement it, or delete `parentCaptureId`?
- Is producer attestation worth it while the gateway token is a single
  credential that reaches every environment? That is a broader authentication
  question, shared with other environment-scoped commands.
- For Discuss on Codex, Cursor and Grok, is a second session acceptable to
  users, or should advisory stay the answer?

## Needs verification

- Which providers produce `unknown` outcomes or Answer in chat in practice.
  This needs the live runs in
  [0044-web-annotation-qualification.md](0044-web-annotation-qualification.md).

## Related

- [0044-web-annotation-qualification.md](0044-web-annotation-qualification.md),
  [0047-web-annotation-extensions.md](0047-web-annotation-extensions.md).
- [0001-agent-interactions-and-permissions.md](../agent-engines/0001-agent-interactions-and-permissions.md)
  and [0049-native-agent-idle-observation.md](../transcripts-and-observation/0049-native-agent-idle-observation.md)
  for no-touch status and interaction reads.
- [0004-composer-model-parameters.md](../agent-engines/0004-composer-model-parameters.md) for mode
  scope per provider.
- [web-page-annotations.md](../../architecture/web-page-annotations.md)
  §"Anchors and pins" and §"Request states".

## Replaces

- `docs/improvements/web-page-annotations/plan/06-agent-targeting-and-change-briefs.md`
  (separate discussion-session fallback)
- `docs/improvements/web-page-annotations/plan/11-batch-review-and-evidence.md`
  (done; review-tray estimate is the remaining gap)
- `docs/improvements/web-page-annotations/plan/12-results-and-visual-verification.md`
  (container file checks)
- `docs/improvements/web-page-annotations/plan/13-capture-modes-and-client-support.md`
  (crop-to-parent relation)
- `docs/improvements/web-page-annotations/plan/14-validation-observability-and-release.md`
  (observability series)
