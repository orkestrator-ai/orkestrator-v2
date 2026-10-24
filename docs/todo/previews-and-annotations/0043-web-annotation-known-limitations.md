# Web annotation known limitations

Checked against `main` at `2459b05c` (2026-10-15). All nine items done on
2026-10-24 (branch `todo-0043-annotation-limitations-8d52b6eaf37d`, node
mbp3, macOS 26.6.2 arm64); see "Evidence" and "Assumptions and decisions".
The behaviour now lives in
[web-page-annotations.md](../../architecture/web-page-annotations.md); once
this change is reviewed the file can be deleted (README: "Maintaining the
folders").

These were code gaps in the shipped annotation workflow. Some appeared under
"Known limitations" in
[web-page-annotations.md](../../architecture/web-page-annotations.md); others
were things the plan required that never landed. Each gap was small. Together
they decide how far a reviewer can trust the evidence, the provenance labels
and the request card's status. None of them may give a page or an agent the
power to resolve, retarget or dispatch work.

## Current state

- Region crops: `WebAnnotationRegionTarget.parentCaptureId` is gone from the
  contract. `validateWebAnnotationCaptureInput` refuses a payload that names it,
  `regionCrop` or `producerSource` ("assigned by the receiver"). The backend
  records `WebAnnotationCapture.regionCrop` (`assetId`, `sourceAssetId`,
  `sourceRect`) in `writeCapture` (`regionCropRelation` in
  `web-annotation-service-threads.ts`) only when the second image's stored size
  matches `target.imageRect` cut from the first, within one pixel. The brief
  labels the two images `viewport` and `region-crop` (`cropOf`, `sourceRect`),
  and the thread shows "The region is cut from the full screenshot above."
- Pins: `useAnnotationPins` tracks the newest document generation it has seen
  for the tab (events, pin snapshots, Show on page replies, the results
  themselves; reset when the tab or attached view changes) and keeps only
  results of that document (`currentDocumentResults`). A `pins-invalidated`
  event drops the previous page's results at once, before the pins come back.
- File checks: `checkWebAnnotationWorkspacePaths` checks container workspaces
  through a new backend command, `check_container_workspace_paths`
  (`commands-registry-terminal.ts`). It runs `CONTAINER_PATH_CHECKER`
  (`web-annotation-source-checks.ts`) with `docker exec -i … node -e` against
  `/workspace`: root canonicalized, lexical and post-`realpath` containment,
  `stat` only, at most 200 paths as JSON on stdin, a 2 s check budget inside the
  container and a 5 s hard kill on the host. A failed, slow or malformed check
  reports `unavailable`.
- Capture producer: the backend records `producerSource` on every capture:
  `client-declared` for what a client submitted, `backend` for legacy imports
  and result captures. Older records read through
  `webAnnotationProducerSource`. The brief carries `producerSource`, and the
  thread labels a client-declared producer "(reported by the client, not
  verified)". Provenance is unchanged and still server-assigned.
- Discuss: `capabilitiesFor` reports `planModeScope: "turn"` for Claude and
  `"session"` for a Codex, Cursor or Grok session whose recorded mode is
  already Plan. Such a session gets `readOnly: "plan-mode"`; its prompt carries
  `mode: "plan"` (its current mode) plus `requireSessionMode: "plan"`. Publish
  refuses when the session left Plan after preparation, and the queue drain
  (`native-agent-prompt-queue-dispatcher.ts`) parks the prompt instead of
  sending it if the session leaves Plan while it waits. When the chosen session
  is advisory, `DestinationPicker` lists the environment's sessions that can
  discuss read-only; with none, the advisory label stays and says how to get
  one. No session's mode is ever changed.
- Turn outcome and interactions: a native turn-end edge
  (`isAgentTurnEndTransition` in `core/index.ts`) calls
  `WebAnnotationService.noteTurnEnded`, which observes that session's active
  requests at once, in loaded environments only, so the outcome is read while
  the bridge that ran the turn is still up. A plan-mode Discuss brief now tells
  the agent to answer in its reply and not submit a plan for approval. Live
  runs on all six providers settled every request with a known outcome (see
  "Evidence").
- Review tray: summaries carry `currentCaptureAssets` (asset id, digest, exact
  bytes). `batchEvidenceBudget` counts those the way preparation does (once per
  digest across the batch, stored bytes), with no capture or image fetch.
- Metrics: `WebAnnotationMetrics` adds `evidence_omitted|section` and
  `evidence_unavailable|section` (on request creation),
  `request_turn_outcomes|agent|operation|outcome`, `acceptance_ms|source=request|operation`
  and `acceptance_ms|source=note`, `annotations_reopened`, and
  `anchor_resolutions|source=result-capture|state|rule`. The desktop exposes
  `getCaptureDiagnostics()` (spool depth and bytes against its limits, and
  pin and Show on page resolutions by `state|rule`). Settings → Web page
  annotations → Diagnostics reads both on demand and copies them as JSON.

## Outstanding work

### Code

1. Done. Region crop provenance: `parentCaptureId` removed from the contract
   and validation (a payload naming it is refused); the backend assigns
   `regionCrop` on the capture's assets. Code: `web-annotations.ts`
   (`WebAnnotationRegionCropRelation`), `web-annotations-validation.ts`,
   `regionCropRelation` and `writeCapture` in
   `web-annotation-service-threads.ts`, image roles in `web-annotation-brief.ts`,
   `AnnotationThread.tsx`. Tests: `web-annotation-capture-relations.test.ts`
   (relation, clamping, mismatch, forged payloads), the crop-role case in
   `web-annotation-brief.test.ts`, `web-annotations.test.ts` (protocol).
2. Done. Pin generations: `currentDocumentResults` / `newestGeneration` and the
   generation tracking in `useAnnotationPins.ts`. Tests:
   `useAnnotationPins.test.ts`.
3. Done. Container file checks: `CONTAINER_PATH_CHECKER`,
   `runContainerPathCheck` and the container branch of
   `checkWebAnnotationWorkspacePaths` (`web-annotation-source-checks.ts`);
   command `check_container_workspace_paths`; `checkWorkspacePaths` in
   `web-annotation-dispatch.ts`. Tests: `web-annotation-source-checks.test.ts`
   (the script run with Node against a real directory, including symlinks inside
   and outside the root, budget, bounded input, strict parsing, the docker
   argument list and the timeout kill). Live: the script in a real
   `orkestrator-v2:latest` container (see "Evidence").
4. Done. Producer attestation: decided against attestation; the producer is
   shown and briefed as client-declared (decision D2). Code:
   `producerSource` in `writeCapture` / `captureFromInput`, migration,
   `webAnnotationProducerSource`, `captureProducerLabel` (`format.ts`), the
   brief's `page` section. Tests: `web-annotation-capture-relations.test.ts`,
   `web-annotations.test.ts`, `WebAnnotationDiagnostics.test.ts` (label).
5. Done. Discuss outside Claude: a session-scoped session already in Plan is a
   read-only destination, guarded at publish and at drain; otherwise the picker
   offers the read-only sessions, or keeps the advisory label (decision D3).
   Code: `capabilitiesFor` / `dispatchModeFields` / `publish`
   (`web-annotation-dispatch.ts`), the drain guard, `DestinationPicker.tsx`,
   `RequestComposer.tsx`. Tests: the session-plan case in
   `web-annotation-dispatch.test.ts`, "native queue required session mode" in
   `native-agent-service-turn-outcome.test.ts`, two composer cases in
   `RequestComposer.test.tsx`. Live: Codex, Cursor and Grok (see "Evidence").
6. Done. Fewer `unknown` outcomes: the live runs found no `unknown` outcome on
   any provider; the common non-completion was Claude's plan-mode Discuss ending
   in a pending plan approval (3 of 5 runs), now closed by the brief. The
   turn-end reconcile removes the timing window in which the bridge could go
   away first. Code: `noteTurnEnded` (`web-annotation-service-requests.ts`),
   the turn-end wiring in `core/index.ts`, `operationSection` in
   `web-annotation-brief.ts`, `request_turn_outcomes`. Tests:
   `web-annotation-observability.test.ts`, the brief test. No idle session is
   hydrated, no bridge started, no tab-facing route polled.
7. Done. Review-tray capacity: `currentCaptureAssets` on summaries (`summary`
   in `web-annotation-service-threads.ts`) and the exact path in
   `batchEvidenceBudget`. Tests: `web-annotation-capture-relations.test.ts`
   (summary sizes and digests), `BatchReviewTray.test.tsx`.
8. Done. Observability: the series above, the desktop diagnostics
   (`stats()` in `browser-preview-capture-store.ts`,
   `anchorResolutionCounts()` in `browser-preview-capture-pins.ts`,
   `getCaptureDiagnostics` through `ipc.ts` and `preload-api.ts`), and the
   settings view (`WebAnnotationDiagnostics.tsx`); decision D5 on the consumer.
   Labels are closed vocabularies only. Tests:
   `web-annotation-observability.test.ts`, `browser-preview-capture-store.test.ts`
   (stats), `browser-preview-manager-capture.test.ts` (resolution counts),
   `preload-api.test.ts`, `WebAnnotationDiagnostics.test.ts`.
9. Done. Comments citing deleted plan steps reworded in all thirteen files
   listed (they now name the section of `web-page-annotations.md` or the
   behaviour). `rg "plan step|[Ss]tep (0[0-9]|1[0-9])\b"` over the annotation
   sources finds none.

### Qualification

Nothing left in this file. The real-stack Docker path through the product
(a Docker fixture environment reporting `exists` for a reported path) belongs to
code item 2 of
[0044-web-annotation-qualification.md](0044-web-annotation-qualification.md),
which is updated to expect the container check instead of `unavailable`.

## Evidence

Runs on 2026-10-24, node mbp3 (macOS 26.6.2, arm64), Docker 29.7.2.

Live gateway spec (`e2e/agent-testing/web-annotations-gateway.spec.ts`,
`--grep 'live agent'` plus the new session-Plan case), one disposable profile
`qa-0043-live` started with `mise run dev:test --profile qa-0043-live --fixture`
(host logins; stopped and reset afterwards). Each request's settled facts come
from the `[annotation-live] outcome` line the spec now records:

| Provider | Implement | Discuss | Discuss in a session already in Plan |
| --- | --- | --- | --- |
| claude | `awaiting-review`, outcome `completed`, mode `session` | before the brief fix: 2 of 5 `completed`, 3 of 5 `needs-input` on `plan-approval:pending`; after it: 5 of 5 `completed`, `plan-mode` | not applicable (per-turn) |
| codex | `awaiting-review`, `completed` | `completed`, advisory | `completed`, `plan-mode`, mode `plan`; refused after a switch to Build |
| cursor | `awaiting-review`, `completed` | `completed`, advisory | same as Codex |
| grok | `awaiting-review`, `completed` | `completed`, advisory | same as Codex |
| opencode | `awaiting-review`, `completed` | `completed`, advisory | no modes |
| pi | `awaiting-review`, `completed` | `completed`, advisory | no modes |

The refusal reason recorded live was "The session is no longer in Plan mode,
so this read-only discussion was not sent. …", and the session stayed in
Build. No run produced an `unknown` outcome or an unanswerable interaction.
Grok passed for the first time since 2026-10-15, and Pi for the first time
(recorded in 0044).

Container path check in a real container: `orkestrator-v2:latest` with a temp
workspace bind-mounted at `/workspace`, called through `runContainerPathCheck`
with the real `spawn`. Results: existing file `exists`, missing file `missing`,
an in-workspace symlink `exists`, a symlink to `/etc/passwd`
`outside-workspace`, a symlink to a host file outside the mount `missing`
(not visible in the container), a path under a file `missing`; 185 ms for six
paths, 175 ms for 200.

## Constraints and rationale

- Evidence stays untrusted. Provenance is assigned by the receiving boundary,
  never by the payload. The crop relation and producer basis follow the same
  rule.
- Nothing here may let an agent or a page resolve, retarget or dispatch.
- Uncertain anchor matches stay explicit (`ambiguous`, `stale`, `missing`).
  They are never retargeted. Geometry never establishes identity.
- The reconciler reads storage and in-memory activity only. It never polls
  tab-facing bridge routes or hydrates idle sessions. The turn-end reconcile
  only moves its existing read to the moment the turn ends.
- File checks never read contents, and never follow a path outside the
  workspace.
- A session's mode is never changed to make a discussion read-only.

## Assumptions and decisions

**D1. Crop relation: implement it, or delete `parentCaptureId`?**
Options: (a) have Electron main set `parentCaptureId`; (b) delete the field
and record a backend-assigned relation between the capture's own assets;
(c) delete the field and keep the positional convention (asset 0 is the
viewport, asset 1 the crop).
Chosen: (b).
Why: the full-viewport image is not another capture: it is asset 0 of the same
capture, so a capture id pointed at the wrong thing. Main never sees the
backend's asset ids, so it cannot name assets either. The backend can check the
relation against stored image sizes, which is the receiver-assigned rule the
trust model asks for.
Pros: the relation is explicit, checked and unforgeable from a payload; the
brief can tell the agent which image is the crop and where it sits; old
records still render through the positional fallback.
Cons: the check is geometric (size within a pixel), not a pixel comparison, so
a client could upload an unrelated image of exactly the crop's size and still
get the relation; this is evidence labelling, not an integrity proof.

**D2. Producer attestation, or show the producer as unverified?**
Options: (a) Electron main signs captures with a desktop key the backend
verifies; (b) label every client-submitted producer as client-declared;
(c) leave it as is.
Chosen: (b).
Why: the backend cannot tell which client sent a command: the local desktop,
a remote desktop and a browser all use the same authenticated command surface
with the single gateway token, and a remote desktop has no secret the backend
could check beyond that token. A signature would prove only that the caller
holds the token, which any caller already does. That is the broader
authentication question shared with other environment-scoped commands.
Pros: honest labels with no new key management; the field leaves room for a
future `desktop-attested` value if per-client credentials appear.
Cons: a real desktop capture is also labelled "not verified".

**D3. Discuss for Codex, Cursor and Grok: a second session, or advisory?**
Options: (a) open a new session in Plan mode for the discussion; (b) treat an
existing session that is already in Plan as read-only, and offer those
sessions when the chosen one is advisory; (c) keep advisory only; (d) switch
the session to Plan for the turn and back.
Chosen: (b), with (c) where no such session exists.
Why: (d) changes a running session's mode, which is forbidden. (a) means the
backend creating tabs and choosing modes for them, outside the annotation
flow, and leaves an extra session per discussion. A session already in Plan
needs no change at all, and the user can put any session in Plan themselves.
Pros: real read-only discussion on three more providers with no mode change;
guarded at publish and at drain, so a later switch to Build can never run the
discussion with write access or flip the mode back; the user sees why and what
to do.
Cons: the user has to have (or make) a session in Plan; a prompt parked by the
drain guard needs an explicit Retry or Cancel. OpenCode and Pi have no modes
and stay advisory.

**D4. Which `unknown` / Answer-in-chat paths to close.**
Options: (a) wait for more field data; (b) close what the live runs showed and
the one timing window the code shows; (c) also read the outcome in the chat
send path before a later prompt supersedes it.
Chosen: (b).
Why: the live runs on all six providers found no `unknown`; they found Claude's
plan-mode Discuss ending in a pending plan approval most of the time, which the
brief now prevents (5 of 5 after, 2 of 5 before). The remaining window, a
bridge gone before the next three-second pass, is closed by reading at the
turn-end edge. (c) adds a status read to every chat send for a rare case.
Pros: the common case is fixed and measured; no extra provider reads (the
reconcile makes the same single read, earlier); `request_turn_outcomes` will
show any provider that still settles `unknown`.
Cons: a prompt sent from chat before the edge is observed can still supersede
an annotation turn and leave it `unknown`; Answer in chat remains for
interactions whose bridge is gone (they cannot be answered from the card then
anyway).

**D5. Who reads `web_annotations_metrics`.**
Options: (a) tests only; (b) a diagnostics view with a JSON copy; (c) export to
an external sink.
Chosen: (b), in Settings → Web page annotations, loaded on demand.
Why: an operator needs the numbers when something is wrong, and the series are
already content-free; nothing else in the app exports metrics.
Pros: no background cost; the copy is safe to paste into a bug report.
Cons: counts are per backend process and reset on restart; desktop counters
cover only the desktop the view runs in.

**D6. Where desktop spool and anchor counters live.**
Options: (a) push them to the backend; (b) keep them in the desktop process and
read them through the preload API.
Chosen: (b).
Why: several desktops can share one backend, and a push would need its own
command, bounds and merge rules for a diagnostic.
Pros: exact, local, no new backend surface.
Cons: not visible from a browser or iOS client, and not aggregated across
desktops.

**D7. Container check limits.** Same 200 paths and 2 s check budget as local,
plus a 5 s host-side kill because `docker exec` and Node start-up are outside
the in-container budget (measured about 180 ms on Docker Desktop for macOS).
Paths travel as JSON on stdin, never on the command line.

**Assumptions.** The persisted session control `controls.mode` is the
authority for a session-scoped provider's current mode (the composer persists
it when the user changes mode); a mode changed only inside a provider's own
terminal UI is not seen, which errs towards advisory and towards refusing.
The region crop is the second of exactly two images on a region capture, as the
desktop commit path produces.

## Open questions

- None left from the original list (crop relation: D1; attestation: D2;
  a second session: D3).

## Needs verification

- Done 2026-10-24: which providers produce `unknown` outcomes or Answer in chat
  (see "Evidence"). Re-check `request_turn_outcomes` after real use.

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
- Flake [0780](../../tests/flaky-tests/previews-annotations-and-gateway/0780-annotation-script-structural-html-custom-element.md),
  seen once while validating this change in a file it does not touch.

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
