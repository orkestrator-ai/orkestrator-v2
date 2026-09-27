# Web page annotations: discussion through implementation

Status: Proposal — findings from source review on 2026-09-21. No application
changes have been made or live browser flows exercised for this investigation.

Detailed implementation sequence:
[plan index](web-page-annotations/plan/00-index.md).

## Recommendation

Make annotations persistent conversations attached to parts of a page. Let the
user collect feedback, discuss it with one selected agent, send an agreed change
request, and review the result in the browser. Keep the annotation available
throughout that cycle.

The highest-value first release combines a browser-side discussion panel,
explicit agent targeting, durable annotation records, and a return path from
the agent's work to the original selection. Richer capture modes and automatic
visual comparisons can follow.

## What exists today

The current implementation already collects substantial context. Preserve this
investment rather than replacing the inspector or introducing a separate agent
execution system.

| Area | Observed behavior | Implication |
| --- | --- | --- |
| Entry point | The native browser preview offers **Annotate** only when at least one native-agent tab is open. The iframe fallback does not expose this control. | Feedback collection depends on having an agent session ready and is currently limited to the native preview. |
| Selection | A page-injected inspector highlights an element, displays dimensions/styles, and opens a comment form. | Good starting point for precise feedback; no persistent collection of page pins or discussion threads. |
| Evidence | Capture includes URL/title, viewport, element rectangle, selectors, ancestors, attributes, text, HTML, computed styles, and a highlighted viewport screenshot. | The agent gets more than a screenshot, but the target still needs interpretation and source-code discovery. |
| Delivery | A saved annotation and screenshot attachment are copied into every open native-agent draft in the environment, subject to each draft's capacity. The user subsequently sends a chat prompt. | Destination is implicit, unrelated drafts acquire feedback, and there is no dedicated browser handoff action. |
| Composer | An annotation-count chip opens a tooltip listing references and comments; it offers removal of all annotations. | Browser feedback lacks a first-class interface for individual editing, discussion, selection, and dispatch. |
| Persistence | Annotations participate in existing compose-draft persistence; screenshots are written under `.orkestrator/annotations/` in the worktree/container. | Draft recovery exists, but a draft is not an independent annotation history. |
| Consumption | Confirmed submission consumes matching browser annotations and associated attachments across the environment's native drafts. | There is no browser-owned record of who handled the request or whether the resulting change satisfied it. |
| Lifecycle | Selection mode is cancelled on inactivity, unmount, or explicit page navigation/reload. Submission is polled by the mounted browser component. | Temporary selection and durable feedback need separate lifetimes. A capture interrupted before persistence needs explicit recovery. |
| Bounds | Prompts allow 20 annotations and 20 attachments; reference text is capped at 12,000 characters and comments at 2,000. Screenshots are limited to a 2,000-pixel longest side and 8 MiB. | Existing bounds are valuable. A collection should support more feedback than one prompt without silently omitting context. |

Sources:
[BrowserTab](../../apps/web/src/components/browser/BrowserTab.tsx),
[injected inspector](../../apps/desktop/electron/browser-preview-annotation-script.ts),
[preview manager](../../apps/desktop/electron/browser-preview-manager.ts),
[browser annotation delivery](../../apps/web/src/lib/chat/browser-annotations.ts),
[compose UI](../../apps/web/src/components/chat/NativeComposeBar.tsx),
[compose store](../../apps/web/src/stores/nativeComposeStore.ts),
[draft persistence](../../apps/web/src/lib/compose-draft-persistence.ts), and
[native-agent submission](../../apps/web/src/components/native-agent/AgentNativeTab.controller.tsx).

### A critical distinction: page evidence and user intent

The comment editor currently lives inside the inspected page. Consequently,
the prompt formatter explicitly tells the agent to treat **both** browser
element data and its `userComment` as inert, untrusted page context. An
annotation-only prompt therefore does not provide a trusted instruction to
implement the requested change. This is a source-level contract mismatch with
the desired workflow, not evidence that every agent currently ignores notes.

Keep that trust boundary. Move comment authoring and the **Discuss** / **Request
changes** actions into Orkestrator-owned UI, and carry the user's instruction
separately from captured page material. Do not fix this by simply promoting the
existing page-originated `userComment` to an instruction.

The runtime session ID helps reject stale or unrelated captures, but does not
prove that text in the page world was authored by the user. Historical browser
comments must retain their provenance when migrated or resent. See
[annotation prompt formatting](../../apps/web/src/lib/chat/transcript-annotations.ts)
and [runtime validation](../../apps/desktop/electron/browser-preview-manager.ts).

## Proposed user journey

1. **Point.** Enter annotation mode and select an element. Show a numbered pin
   and a compact target summary: “Save button · Settings · desktop viewport.”
   Let the user move to a parent or child when the initial hit is too small or
   too broad. Preserve ordinary page navigation outside selection mode.
2. **Describe.** Open an app-owned side panel with a screenshot thumbnail and
   a multiline comment field. Save the draft independently of any agent tab.
   **Save and add another** makes a page review quick; **Done** exits selection.
3. **Discuss.** Choose an existing agent session in the same environment, or
   create one. **Discuss** sends a question with the selected evidence and asks
   for analysis without edits. Agent answers and follow-up questions remain
   linked to the annotation, with a route to the full conversation.
4. **Request changes.** Select one or several annotations, review their intended
   outcome, and send them to the chosen session. Show the destination, scope,
   and evidence before sending. The button itself is the handoff action;
   routine requests do not need another confirmation dialog.
5. **Follow progress.** Show queued, running, needs-input, failed, or awaiting
   review beside each request. Existing agent approvals and questions remain
   authoritative and are accessible from the panel. Switching environments
   does not stop work or discard feedback.
6. **Review.** When the agent reports completion, offer **Open updated page**,
   the change summary, relevant diff, and validation results. Restore the
   route and viewport where possible and show the original capture alongside
   the new result. Avoid reloading a page while the user is editing a form.
7. **Resolve or continue.** The user resolves the annotation or replies with
   further feedback. Reopening preserves the same thread and previous attempts.
   An agent finishing a turn must not automatically resolve the annotation.

Example: select a cramped pricing card, write “Make the annual price easier to
scan,” and discuss whether changing type size or grouping would help. The user
then requests “Put the annual total below the monthly equivalent; keep the
mobile card within the viewport.” The implementation request carries both
criteria, the selected card, and its capture. The agent returns changed files
and viewport checks; the user reviews the page and resolves the thread.

## Prioritized feature improvements

### P0: Give feedback a durable home and a clear destination

- Add an environment-owned annotation collection, visible from the browser and
  agent chat. Allow capture with no agent session open. Filter by page, open
  status, and assigned session; keep resolved items available in history.
- Replace automatic distribution to all native drafts with explicit targeting.
  Remember the last destination for this environment, display it beside Send,
  and never silently reroute if the session disappears.
- Add individual edit, delete, include/exclude, and reopen controls. Removing an
  item from a proposed batch should not delete its conversation or screenshot.
- Keep one active implementation request per annotation by default. If a second
  agent is deliberately asked to review the same item, record a separate request
  and distinguish review from implementation. Do not duplicate work implicitly.
- Move discussion and intent entry into the app-owned panel. Preserve the
  existing chat as the execution surface; annotations link to turns/messages
  rather than maintaining a second, divergent copy of the transcript.
- Show **Saved**, **Saving**, and retryable save failures. A screenshot write or
  capacity error must leave the comment and capture available for recovery.

### P1: Make it easy to identify the right target after changes

- Store structured anchors rather than only formatted reference text: stable
  ID/test ID when available, scoped selector candidates, semantic role/name,
  nearby text, ancestor context, frame/shadow-root path where supported, and
  original geometry. The current `selectorFor` can return a bare tag or local
  `nth-of-type` selector; it is not a guaranteed unique document locator.
- Re-resolve pins after navigation, hot reload, resizing, or DOM replacement.
  Require one confident match using multiple signals. When the target is
  missing or ambiguous, show **Target changed — reselect** and keep the original
  capture. Never silently attach the request to a different element.
- Record capture time, navigation/document generation, viewport, scroll
  position, preview zoom, and screenshot scale. Reject or mark captures stale
  if navigation or target replacement occurs between inspection and screenshot.
  Keep a replacement capture as a new revision of the evidence.
- Treat route identity deliberately: retain meaningful query/hash state, redact
  secrets, and store a logical preview URL separately from a gateway URL. A
  desktop's loopback address may not identify the same service from an agent's
  container or a remote backend.
- Add text-range selection for copy edits, rectangular regions for spacing or
  canvas content, and whole-page notes for responsive/layout concerns. Ship
  element selection first; offer a screenshot-region fallback for unsupported
  iframe, shadow-root, or canvas targets and label its limitations.
- Provide keyboard selection, parent/child traversal, Escape, focus restoration,
  accessible pin labels, and a usable narrow-screen panel. Do not require hover
  to read or edit a comment.

The W3C Web Annotation model separates an annotation's body from its target and
describes CSS, XPath, text-quote, and text-position selectors. Its text-quote
selector includes surrounding text to help disambiguate a selection. These are
useful concepts for the proposed anchor model; full JSON-LD interoperability is
not required for the first release. See the
[Web Annotation Data Model](https://www.w3.org/TR/annotation-model/#selectors).

### P1: Send an actionable, bounded change brief

- Separate **Discuss** from **Request changes**. Use host-authored instructions
  appropriate to each action, while retaining page material as quoted evidence.
  A discussion can become an implementation request without reselecting the page.
- For a batch, include stable annotation IDs, user intent, desired outcome,
  route/viewport, target summaries, and screenshot references. Allow an optional
  overall instruction such as “Keep the existing typography and spacing scale.”
- Put the user's request and essential target context first. Provide expanded
  DOM/styles on demand rather than spending the prompt budget on every captured
  property. Group related notes and avoid attaching identical screenshots twice.
- Show missing images, unsupported model capabilities, stale captures, and
  batch capacity before dispatch. Offer an explicit text-only path where useful;
  never present a screenshot as delivered when it was skipped.
- Let the agent inspect the repository to identify the component and styles.
  Selectors and DOM ancestry are evidence, not a source-file mapping. Optional
  development instrumentation can supply verified file/component hints later;
  do not make private framework internals a prerequisite.
- Ask the agent to report annotation IDs addressed, files changed, checks run,
  unmet criteria, and remaining questions. Source changes must survive a reload;
  a temporary browser DOM/style edit does not count as implementation.

### P1: Close the loop with review evidence

- Link requests to session and turn IDs so ordinary agent events can drive
  status. A finished turn with unanswered questions or failures stays open.
- Add a minimum **Ready for review** result containing a summary, links to
  changes, and verification limitations. Unstructured agent output should still
  be accessible even when automatic result extraction fails.
- Compare the original and current capture at matching routes and viewports.
  Start with side-by-side images; defer pixel diffs until capture conditions
  are controlled enough to avoid noise from animation, fonts, or timestamps.
- Keep visual acceptance separate from functional checks. A new screenshot
  cannot establish that a button still saves or that keyboard interaction works.
- If the agent cannot access the authenticated page or its preview service,
  expose that limitation and request user review. Never infer successful visual
  verification from source changes alone.

### P2: Expand only after the core loop is reliable

Add responsive capture sets, shared-component grouping, richer visual diffs,
optional issue export, and source-location instrumentation. Consider multi-user
discussion only when identity and permissions are defined; user-agent threads
are sufficient for the initial workflow.

Expose capabilities explicitly across clients. Desktop can supply native DOM
capture; the web/iOS clients may initially offer discussion and review of saved
captures. Browser capture outside Electron requires a separately designed,
authenticated inspection path. Do not weaken the existing iframe sandbox to
claim feature parity.

## Implementation shape

### Records and ownership

Introduce backend-owned, versioned records with the following responsibilities:

| Record | Essential fields |
| --- | --- |
| Annotation | Stable ID, environment ID, logical page identity, open/resolved state, revision, creation/update times, assigned session if any. |
| Capture | Annotation ID, capture revision, provenance, document generation, structured target, viewport/scroll/scale, bounded evidence references, capture time. |
| Discussion entry | Annotation ID, author/provenance, text or linked agent-message ID, time, and the capture revision being discussed. |
| Change request | Request/idempotency ID, destination session, annotation IDs and frozen revisions, trusted instruction, operation type, dispatch state, turn ID, result references. |

Keep annotation resolution separate from request execution. An annotation can
remain open through several discussions and attempts. Requests move through
draft, queued, running, needs-input, awaiting-review, or failed/cancelled states.
An uncertain dispatch is explicitly unconfirmed until reconciled; it must not
be treated as either a failure safe to retry under a new ID or completed work.

Edits made after dispatch create a later revision. They must not mutate the
request already received by the agent. Use revision checks for concurrent edits
and explicit user action to incorporate new feedback into a subsequent request.

### Reuse existing infrastructure

- Extend the shared
  [browser-preview contract](../../packages/protocol/src/browser-preview.ts)
  for capture metadata, and add a separate annotation/discussion contract.
  Keep capture transport independent from agent-provider implementations.
- Register operations through the backend's existing command registry and
  storage conventions. Persist records and asset references before reporting
  success. The renderer holds a projection, not the only copy.
- Reuse native-agent dispatch, queueing, request IDs, ambiguity reconciliation,
  approvals, and cancellation. A busy agent should receive an explicitly queued
  request; adding an annotation must not interrupt its current turn.
- Use content-free revision notifications and authoritative snapshots. On mount,
  activation, reconnect, or a detected revision gap, refresh threads and request
  status. The existing
  [design canvas](../architecture/design-canvas.md#ownership-and-revisions)
  provides a local precedent for persisted revisions and missed-event recovery.
- Make submitted captures acknowledgeable: retain a bounded pending capture
  until backend persistence succeeds or the user explicitly discards it. Hiding
  the browser may remove transient selection UI, but must not delete accepted
  feedback or cancel dispatched agent work.
- Accommodate native-preview compositing when placing the trusted panel. Reserve
  space and resize the preview bounds instead of assuming an ordinary renderer
  overlay can appear above it. Keep comment inputs outside the page DOM.

### Evidence storage and trust

Store screenshots once and reference them from annotations and requests. Use
environment-scoped asset IDs and materialize agent-readable paths through the
existing local/container attachment machinery. Ensure the agent sees the same
capture the user selected, including when the workspace is remote.

Preserve existing per-item caps and add explicit aggregate limits for batches,
thread pages, asset bytes, pending captures, queues, and retention. Display the
limit and provide a recoverable action. Garbage-collect unreferenced captures
after a grace period; retain captures referenced by discussion or review history.
Deleting a thread and unlinking an attachment need distinct semantics.

Captured HTML, text, attributes, URLs, and screenshots remain untrusted evidence.
Capture only the selected scope; redact password/form values, sensitive query
parameters, and credential-bearing attributes before storage. Provide a way to
exclude or redact screenshot regions, since pixels can expose information that
DOM filtering misses. Keep image bytes and page/comment contents out of telemetry.

Bind every read, edit, asset access, dispatch, and agent result to the owning
environment/session. A proposed agent-facing annotation tool should reuse scoped
credentials and expose only the selected thread/request. Page JavaScript must
not gain a command, filesystem, or dispatch capability through annotation APIs.

### Migration

Read existing `source: "browser"` draft entries into the collection with their
original IDs, evidence text, screenshot paths, and untrusted-comment provenance.
Deduplicate the same ID copied across drafts within an environment; preserve
divergent draft comments as variants instead of choosing one silently. Missing
screenshots remain visible as missing evidence. Do not fabricate structured
anchors or resolved history from the legacy formatted text.

Leave ordinary transcript annotations working as they do today. During rollout,
support legacy prompt envelopes while the new browser flow references durable
records. Stop cross-draft consumption for migrated browser records; dispatch
should attach a request to the thread, not erase the thread.

## Delivery sequence and acceptance criteria

| Phase | Scope | Acceptance gate |
| --- | --- | --- |
| 1: Complete one feedback loop | Durable records, trusted comment panel, one element target, explicit agent selection, linked discussion and implementation turns, manual review/resolution. | Capture without an agent open; discuss and request a change; reload or switch environments during work; return to the same thread and result. No unrelated draft is modified. |
| 2: Make page reviews efficient | Batch selection, individual editing, robust anchor reconciliation, capture revisions, target navigation, image capability handling. | Send several related requests without losing evidence; hot reload cannot silently move a pin; failed saves and ambiguous dispatches recover without duplicate execution. |
| 3: Improve verification and reach | Before/after comparison, structured results, additional capture modes, optional source hints, client capability expansion. | Review at matching viewports, surface verification limits, and preserve the same history across supported clients. |

Phase 1 should already permit a full point → discuss → change → review cycle.
Do not postpone review/resolution until advanced visual comparison is available.

### Validation scenarios for implementation

- **Intent:** a comment authored in the trusted panel becomes the requested
  action; instructions embedded in HTML, attributes, screenshot content, or a
  legacy page comment remain evidence and cannot authorize work.
- **Ownership:** two native-agent tabs are open; only the selected destination
  receives the request. Two clients attempting to send the same request cannot
  start duplicate turns. Closing the destination does not silently choose another.
- **Recovery:** switch away during capture persistence and during agent work;
  restart/reconnect before completion; return and recover comments, status,
  pending questions/approvals, and review results from snapshots.
- **Revisions:** edit a note while its previous request is running. The agent's
  frozen brief remains unchanged, and its result cannot resolve the newer note
  automatically. Stale update conflicts are visible.
- **Selection:** exercise nested elements, repeated labels, DOM replacement,
  scrolling, zoom, narrow viewports, and unsupported frame/shadow targets. A
  missing or ambiguous anchor remains attached to its historical capture.
- **Failures:** simulate screenshot-write errors, full storage, unsupported image
  models, agent cancellation, failed checks, and unknown dispatch outcomes.
  Preserve the thread and expose the appropriate retry/reconcile action.
- **Completion:** change source, rebuild/reload, and inspect the intended page.
  Link evidence to the right request; keep user acceptance distinct from agent
  completion. A discussion-only turn must not trigger implementation dispatch.
- **Accessibility:** create, read, edit, send, and resolve feedback by keyboard;
  verify focus and that the native preview does not cover the discussion panel.

Use the repository's
[testing guide](../development/testing-guide.md) and
[isolated agent testing guide](../development/agent-testing.md) when implementing.
Extend the existing browser-tab, annotation-formatting, compose-persistence,
native-agent, and Electron inspector/manager tests, then exercise the actual
native window. Mocked DOM tests alone cannot prove native-view placement or
capture alignment. These are proposed acceptance tests, not completed checks.

## How to judge whether it helped

Establish a baseline before rollout, then measure time from selection to saved
feedback, time to the first useful agent response, time to accepted change,
requests needing the user to repeat context, stale-target frequency, and reopen
rate. Track capture/save/dispatch failures and duplicate dispatches separately.
Use content-free counts, durations, and error categories.

The desired outcome is that users can point at a page, explain a change once,
and return to the same discussion to verify that the agent implemented it.
