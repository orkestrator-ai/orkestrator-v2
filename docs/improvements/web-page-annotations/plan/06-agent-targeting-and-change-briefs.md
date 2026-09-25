# 06 — Agent targeting and change briefs

Status: Implemented (2026-09-24); review gaps closed (2026-09-25); gate evidence partial. Depends on: 01–03, 05. Milestone: A.

## Deliverable

Build a reviewable, immutable request for one explicitly selected native-agent
session. Clearly distinguish discussion from implementation, and never modify
an unrelated chat draft to deliver browser feedback.

## Ownership and integration

Add proposed backend modules `web-annotation-brief.ts` and
`web-annotation-request-preparation.ts`; add small destination/brief controls to
the annotation panel. Reuse shared native session/model capabilities, session
creation and attachment normalization. The existing
`apps/web/src/lib/chat/browser-annotations.ts` distribution helper becomes a
legacy-only path until migration in step 09.

Prompt compilation belongs in the backend so a hidden panel, reconnect, or
different client cannot change the request that is actually sent. The renderer
receives a bounded preview and validation result, not permission to supply a
provider-specific executable prompt envelope.

## Destination selection

- [ ] List existing native-agent sessions in this environment using persisted
  session identities. Distinguish backend tab identity from provider session ID,
  which may not exist until first attachment/dispatch.
- [ ] Show session title, model, current activity, image support, and whether an
  unsent native composer draft or parked dispatch will hold the queue.
- [ ] Remember the last destination per environment as a default preference.
  Display it on the action button; never send merely because a preference exists.
- [ ] Support **New agent session** through the existing create/launch workflow.
  Creating/selecting a session does not dispatch the annotation automatically.
- [ ] Validate destination ownership, environment readiness, capability version,
  and model compatibility again on send and before queue dispatch.
- [ ] If the selected session was deleted/reassigned, invalidate preparation and
  ask for a new destination. Do not create a replacement session silently.

## Two operations

| Operation | Trusted instruction | Result expectation |
| --- | --- | --- |
| Discuss | Answer the user's question about the selected evidence; suggest approaches; do not implement changes. | Response or clarification linked to the thread; annotation remains open. |
| Request changes | Implement the user's stated outcome in the environment's repository; explain the change and verification. | Source changes plus a reviewable report; no automatic annotation resolution. |

Discussion is an intent boundary, not a universal enforcement guarantee. If
the provider advertises a safe per-turn read-only execution mode, use it. If
read-only requires changing a live session's policy, offer a separate compatible
discussion session instead. If unavailable, label the operation as an analysis
request under the session's existing permissions; never claim writes are
technically impossible. Do not relax any approval or permission settings.

## Canonical brief construction

1. Load the selected annotation, exact content/capture revisions, published
   human entries, and destination capabilities.
2. Require a host-authored action instruction. The user can use an existing
   host-authored note as the instruction without retyping it; legacy page notes
   remain quoted until a new host instruction explicitly refers to them.
3. Assemble the operation, stable annotation IDs, requested outcomes, optional
   overall constraint, page/viewport summary, and evidence manifest.
4. Append bounded page evidence in an inert reference envelope, escaping fence
   delimiters. Page text, attributes, HTML, screenshot text, and imported comments
   never become instructions or simulated system/developer messages.
5. Include an output request for per-annotation response, changed files, checks,
   unresolved questions, and limitations. In A this is readable text; structured
   tools are optional later and cannot be required for completion.
6. Freeze canonical serialized bytes and a body hash with all selected revision
   references. Return a preparation ID and the exact evidence/intent preview.

- [ ] Include only published relevant entries in the initial brief. For follow-up
  requests in the same session, carry new entries plus essential target context;
  record entry IDs so the compiler can avoid replaying the entire discussion.
- [ ] In a different session, include a bounded thread summary with links to full
  history. A generated summary is attributed context and cannot replace the
  latest explicit human instruction or hide unresolved requirements.
- [ ] Never derive commands or file mutations from selectors. Explain that the
  agent should locate the repository component and preserve surrounding behavior.
- [ ] Do not accidentally interpret a user comment starting with a slash as a
  native-agent slash command or `/steer`. The operation is a normal prompt.

## Evidence planning and limits

- [ ] Prefer intent, target identity, visible text, geometry, and relevant styles;
  place optional HTML/ancestor detail after them. Mark any omitted section.
- [ ] Deduplicate referenced assets and materialize them through step 02. Resolve
  URLs for the destination's host/container/service context without exposing
  gateway credentials or assuming desktop localhost is reachable by the agent.
- [ ] Reuse existing attachment capability validation for both session and model.
  Missing or unsupported image input blocks send until the user selects a
  compatible destination or explicitly chooses text-only context.
- [ ] Text-only mode removes unavailable image attachments and states that no
  image was provided; a filesystem image path does not prove the model viewed it.
- [ ] Enforce step 01 combined text/image bounds before dispatch. Never silently
  omit selected annotations. Milestone A accepts exactly one annotation.
- [ ] Display stale/legacy-unresolved capture state in the brief. Let the user
  intentionally discuss historical evidence, but do not present it as current.

## Preparation invalidation

Preparation candidates expire after 15 minutes if never sent. A candidate is an
unsent draft, not the committed `prepared` request state in step 01; it holds no
active implementation reservation. Send atomically creates that request and its
reservation through step 07. A committed request never expires by this rule.
Changes to selected content/capture, action, destination, model, permissions,
or included evidence invalidate the preview and require regeneration. Progress
events and unrelated thread activity do not change frozen request bytes.

Send is the user's authorized action; do not add a second generic confirmation
dialog. If new evidence or capabilities changed after preview, surface the
specific mismatch and keep the original request draft intact.

## Verification and completion

- [ ] Snapshot meaningful brief examples: discussion, implementation, legacy
  evidence, image exclusion, multiline criteria, and escaping malicious tags.
- [ ] Test selector/path/HTML prompt injection remains inert and that a host note
  produces a clear actionable instruction without elevating captured comments.
- [ ] Test closed/wrong-environment destinations, changed models, unsupported
  images, stale revisions, expired preparation, and oversized combined payloads.
- [ ] Verify no native draft text, attachments, metadata, or annotations are
  changed by prepare/send-preview operations.

Done when the UI can show exactly which agent will receive which trusted request
and evidence, with frozen backend bytes ready for step 07's durable handoff.
