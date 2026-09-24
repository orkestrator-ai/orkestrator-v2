# 11 — Agent context and implementation handoff

Status: Planned.  
Dependencies: [02](02-operation-contracts-and-durability.md),
[07](07-history-and-document-lifecycle.md),
[08](08-entry-readiness-and-library.md),
[09](09-selection-and-inspector.md).  
Findings: U4.

## Outcome

A reopened canvas can resume its correct conversation. Asking about a selected
element carries a precise, revisioned reference. Users can compare a checkpoint
and hand a chosen design to an ordinary implementation conversation without
automatically submitting a prompt or treating mockup HTML as production code.

## Reuse existing ownership

Review `design-launch.ts`, `TerminalContext.tsx`, `TerminalContainer.view.tsx`,
`AgentNativeTab.tsx`, `nativeComposeStore.ts`, `nativeAgentProjectionStore.ts`,
`storage-native.ts`, and the native-agent service session/discovery APIs.
Codex-specific chat may use its own adapter; expose a shared composer/session
action rather than adding design behavior to each provider's bridge runtime.

Store design associations in backend workspace metadata with the existing
native-agent session identity. Do not store transcripts, credentials, or a
parallel copy of native-agent status in the design document.

## Session association model

- [ ] Add bounded associations containing backend/environment/canvas identity,
  native session identity, platform, role (design or implementation), creation
  time, and optional originating checkpoint. Keep at most eight retained links
  per canvas initially, with an explicit choose/replace UI when full.
- [ ] Link only after the native session has a durable identity. A temporary
  tab ID may represent pending launch but cannot become the only persisted link.
- [ ] Validate environment ownership and session existence on attach/resume.
  Distinguish temporarily unavailable, detached, archived/closed, and definitively
  missing using existing authoritative APIs.
- [ ] Opening an existing session focuses its tab or reopens it through ordinary
  native-agent behavior. It must not resend the design's initial prompt.
- [ ] Do not poll tab-facing liveness routes for link maintenance. Use existing
  background activity/discovery projections, respecting bridge detach behavior.
- [ ] Deleting a canvas removes/fences the link but does not delete the session
  transcript. Closing a design tab likewise does not stop the agent.
- [ ] Import/duplicate creates no active session link by default. A user can
  explicitly attach a conversation after reviewing its scope.

## Ask agent about selection

Define a versioned, bounded `DesignContextReference` containing:

- Canvas/frame IDs and human labels.
- Observed canvas/frame revision and structure identity.
- Optional element reference from step 09, bounded description, and intended
  action scope (discuss, revise, or implement).
- Optional checkpoint/capture reference with the exact captured revision.

- [ ] Add an Ask agent action in selection/frame menus. Focus the associated
  composer and add a visible context chip with a draft request; do not submit
  immediately or overwrite an existing unsent prompt.
- [ ] Reuse existing composer draft persistence and submission idempotency.
  The context survives switching tabs/reload and can be removed before Send.
- [ ] At dispatch, resolve/validate ownership and identify stale context. Supply
  the observed version and require a current `get_canvas`/frame read before
  editing, rather than pretending the old context is current.
- [ ] The backend still enforces revision checks for every eventual mutation.
  Prompt instructions are guidance, not the concurrency enforcement boundary.
- [ ] Do not embed full frame HTML or a screenshot by default. Resolve metadata
  through tools; capture only when requested/useful and within existing bounds.
- [ ] An attachment must say which revision it depicts. A late screenshot of
  revision N cannot be labeled as a view of N+1.
- [ ] Treat design text/HTML as user content, never as trusted tool instructions.

## Compare versions and implementation handoff

- [ ] Expose a checkpoint/current comparison with clear revision labels and
  read-only previews. Use the same isolation/capture limits; comparison cannot
  accidentally edit an old checkpoint in place.
- [ ] Offer Restore, Duplicate as variant, and Use as implementation reference
  as explicit choices. Restoration uses step-07 conflict checks.
- [ ] Handoff lets the user select frame(s), checkpoint/current revision,
  destination conversation, brief, and relevant repository files using existing
  file-reference controls. Bound selected frames and total context bytes.
- [ ] Create/focus an ordinary conversation and populate a reviewable draft.
  Explain in the draft that this is a static visual reference and ask the agent
  to inspect the application's existing architecture/components before coding.
- [ ] Keep design modification and repository implementation scopes explicit.
  Handoff does not auto-approve commands, commit changes, publish, or deploy.
- [ ] Record the resulting implementation association after successful session
  creation; a failed creation leaves the original design and draft recoverable.

## MCP alignment

- [ ] Extend tool descriptions to prefer exact frame reads, revisions, scoped
  selector identities, and recoverable operations. Keep the existing design
  server inventory distinct from control/workflow-result credentials.
- [ ] Discover capability support before proposing unavailable history or save
  actions. Tool errors use typed safe outcomes alongside legacy text as needed.
- [ ] Do not dynamically inject credentials into HTML, exported documents,
  composer text, or context chips.
- [ ] Preserve normal approvals/questions/cancellation/transcript behavior;
  no special auto-approval rule exists for a “design agent.”

## Required verification

- [ ] Create, close, reopen, and Resume: same session, no duplicate initial prompt.
- [ ] Existing unsent composer text survives adding/removing design context.
- [ ] Select element, let agent replace HTML, then submit context: stale reference
  is explicit and subsequent editing still requires current CAS.
- [ ] Switch environments while agent runs/asks a question; return with correct
  design, transcript, pending prompt, and response controls.
- [ ] Missing/detached session versus disconnected backend produces correct
  recovery rather than silently starting a replacement session.
- [ ] Duplicate/import/export contains no active foreign session association.
- [ ] Two clients request Resume concurrently: reuse association/focus behavior,
  no duplicate generation dispatch.
- [ ] Run one fixture-scoped real design-tool cycle with each supported launcher
  (Claude and Codex), plus handoff to a reviewable unsent implementation draft.

Review slices: persistent associations; resume UI; structured composer context;
checkpoint comparison; handoff; real-agent qualification. Do not expand provider
support as incidental work in this step.
