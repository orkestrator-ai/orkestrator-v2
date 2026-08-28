# Agent messaging proposal comparison

This document compares:

- `agent-messaging-grok.md`
- `agent-messaging-sol.md`
- `agent-messaging-opus.md`

The three documents are not merely alternate descriptions of the same design.
They specify materially different products and cannot be combined without first
resolving several architectural and product decisions.

## Overall character

- **Grok** proposes a conservative mailbox-first system. Pull is the default,
  automatic injection is exceptional and opt-in, workflow sessions are excluded,
  and the design is closely tied to current backend dispatch details.
- **Sol** proposes immutable endpoint identities, a richer delivery state machine,
  and one coordinated scheduling path for user prompts and agent messages.
- **Opus** proposes the broadest collaboration system: named handles, user and
  environment mailboxes, multiple recipients, approvals, request/reply workflows,
  long polling, and deadlock detection.

## Direct disagreements

| Area | Grok | Sol | Opus |
| --- | --- | --- | --- |
| Mailbox identity | `(environmentId, tabId)`; reinserting the same tab ID resurrects its mailbox and history. | A new immutable `agentEndpointId`; recreating a tab always creates a different endpoint. | A backend-minted mailbox ID plus a human-readable handle, but reopening the same `tabId` resumes delivery, leaving incarnation semantics unclear. |
| Addressable tabs | Native, tmux, terminal, browser, and file tabs; terminal/UI tabs are inbox-only. Workflow and review tabs are excluded. | Managed native and tmux agents only. Plain terminals, browser, and file tabs are excluded, but backend-created workflow job tabs may be addressable. | Native and tmux agents plus global user, environment, and external mailboxes. Workflow exclusions are not defined. |
| Aliases and fan-out | Exact tab destinations only. No environment/project mailbox or broadcast. Self-notes are allowed. | Exactly one immutable destination. Self-send is forbidden. | Handles, `@user`, `@env/...`, and multiple recipients. Environment aliases can choose the focused agent tab. |
| Cross-project consent | Same-project by default; one global setting enables cross-project messaging. No per-message approval. | Cross-project exchange is part of the base contract. Automatic wake is separately opt-in, but cross-project consent is not fully specified. | Requires an `all-projects` policy tier and per-project-pair human approval by default. External messages are also approval-gated. |
| Automatic delivery | A separate pending-inject index and new `dispatchMailInject`; mail is deliberately kept out of the user prompt queue. | Extends a shared dispatch coordinator and prompt queue with origins, batching, and fairness. | The existing prompt queue is the only delivery mechanism. |
| Ordering against user work | Mail waits until the user queue and compose draft are empty. A small enqueue race is explicitly accepted. | Interleaves at most one bounded message batch between user prompts to prevent starvation. | Shares the FIFO queue; high-priority mail may reorder, but fairness against user work is unspecified. |
| Closed tabs | Continue storing into a tombstoned mailbox; the same tab ID can resurrect it. | Queued mail becomes undeliverable; a recreated tab has a new endpoint. | Park for 24 hours, then retire and notify the sender; reopening the same tab ID resumes delivery. |
| Receipts | `stored`/`injected` state plus explicit read acknowledgement. Opening a tab does not acknowledge. | Separates provider submission, agent acknowledgement, and human-seen state. | `read` means either the agent read the message or the user opened it, conflating two principals. |
| Replies and loop control | Replies are ordinary sends with a `conversationId`. Only depth-zero messages auto-inject, and the carrier says not to reply automatically. | A dedicated reply operation derives the other participant. The carrier encourages explicit reply; rate limits are the main loop control. | Dedicated reply, `requiresReply`, bounded waiting, deadlock detection, hop cap 8, and thread cap 40. The carrier explicitly asks for a reply. |
| Payloads | Text only; 20,000 characters. | Text only; 32 KiB UTF-8. | Text plus up to five workspace-relative attachments except across projects; 16 KiB body. |
| Carrier format | Raw body between XML-like tags; embedded closing tags are treated as an accepted advisory-frame weakness. | Escaped JSON data with version validation, following the existing handoff implementation. | Shows a raw XML-like body but does not specify robust escaping or parsing. |
| Persistence | One 32 MB file, 200 messages per mailbox, and eviction may drop unread messages while recording a truncation count. | Up to 64 MB/10,000 records. Accepted unsettled or unread records are not silently evicted; new sends are refused. | Small active JSON files plus an append-only JSONL history. New sends are refused if unsettled state fills the active set. |
| Resource reconciliation | One record-scoped `agent-mail` kind, deliberately excluded from the convergence manifest. | A manifest-backed `agent-mailbox` summary. | Both `agent-mailbox` and `agent-message` are manifest-backed. |
| Unread UI | Per-tab and global inbox, separate from `hasUnreadWork`. | Tab, environment, and project aggregates, also separate from `hasUnreadWork`. | Delivered mail sets `hasUnreadWork`; parked mail receives a separate indicator. |
| Control MCP | Adds list/send in v1 without another approval layer. | Defers Control MCP messaging beyond the first release. | Adds list/send and approval-gates every external delivery. |

## Concrete gaps and internal contradictions

### Grok

- The raw carrier is weaker than the existing handoff carrier, which escapes
  markup characters so untrusted content cannot synthesize structural tags.
- `injectDepth` partly depends on the sender mailbox's latest inbound message.
  This is not a causal relationship: an unrelated later inbound message can
  change whether an outbound reply is eligible for automatic injection.
- The proposed existing-install migration is unsafe for users who skip the
  intermediate release. An old installation that never ran the persist-false
  migration could later be mistaken for a new installation because both lack
  the settings object.
- Environment deletion removes mailboxes owned by that environment, but sent
  messages live in their recipients' mailboxes. The proposal does not clearly
  purge those remaining bodies.
- A full pending-inject index can leave stored messages outside the index. The
  rebuild and fairness rules need to show that these messages cannot starve
  indefinitely.
- The discovery surface excludes closed tabs, while cached addresses may still
  store mail into tombstoned mailboxes. That behavior should be stated as an
  explicit routing rule rather than inferred from separate sections.

### Sol

- The product contract says a detached recipient retains mail until a safe
  boundary, while the automatic-delivery section says a detached native session
  may be attached and dispatched. `detached` needs one authoritative meaning.
- Cross-project messaging is a core requirement, but its user-consent rule is
  not explicit. Disabling automatic wake is not the same as consenting to
  cross-project discovery and mailbox delivery.
- Reusing the prompt queue does not address the current origin-derived
  `allowProviderCommands` behavior. Peer mail needs an explicit false override.
- Immutable endpoint IDs would add backend-owned identity to renderer-written,
  CAS-merged pane layouts. The migration and merge authority need a concrete
  proof before this can be considered low risk.
- The completion criteria require all six native providers, even though not all
  providers currently expose the Orkestrator Agent MCP to the model.

### Opus

- `check_inbox` and `read_message` take no caller tab ID even though the proposal
  correctly says the credential authenticates only an environment. With several
  tabs, the backend cannot know which mailbox "this mailbox" means.
- A backend-minted mailbox identity is undermined by reopening the same `tabId`
  and resuming parked delivery. A late message may reach a different tab
  incarnation.
- The `@env/...` alias chooses a focused agent tab. Focus may be client-specific
  or stale while the environment is inactive, so it is not a reliable routing
  authority.
- Prompt-queue metadata is proposed as the source for transcript cards, while
  the renderer is told never to parse the provider envelope. Once the queue row
  is acknowledged, that metadata is not naturally available when rehydrating a
  provider transcript.
- The append-only message-history log conflicts with secure deletion, backup
  scrubbing, and the rule that operational logs must not contain prompt content.
- Prompt queue reuse also lacks an explicit `allowProviderCommands: false`
  override.
- The default `wakePolicy` is not frozen, even though it determines whether a
  message can start billable work in an unstarted tab.
- It claims every platform already receives the Agent MCP. Pi has no MCP client,
  while Cursor and Grok wiring still needs confirmation.

## Repository facts that constrain the decision

- Current `TabInfo` has no immutable endpoint incarnation ID. Adding one is a
  pane-layout schema, migration, restore, and merge change.
- The Agent MCP bearer credential resolves to `{ environmentId, projectId }`, not
  an exact tab. All three proposals must accept sibling-tab impersonation in v1
  or introduce per-tab credentials.
- Current native dispatch sets `allowProviderCommands` from the durable session
  origin. An ordinary interactive session therefore enables provider commands
  unless the dispatch API gains an explicit override.
- The current handoff carrier JSON-escapes `<`, `>`, `&`, and Unicode separators
  to stop message data from manufacturing carrier structure.
- Prompt queue entries are deliberately provider-specific opaque JSON and the
  current drainer treats them as interactive prompts. Adding a system origin is
  possible, but it is not metadata-only: dispatch, UI editing/reordering,
  failure latches, mode selection, and transcript presentation all need changes.
- The resource manifest is currently intended for collection snapshots used by
  the broad renderer safety sweep. Record-scoped resources normally reconcile
  through their own revision-aware APIs.
- Pi cannot call Agent MCP tools in v1. Cursor and Grok require a wiring audit.
  Receive/injection support and agent-originated send/reply support therefore
  need separate capability flags.

## Further investigation

### 1. Tab incarnation and addressing

Trace the real lifecycle of ordinary tabs and `startup-agent` through close,
reopen, environment restart, pane restore, and concurrent-client merge. Decide
whether a reused `tabId` represents the same logical recipient or a new
incarnation. This determines whether `(environmentId, tabId)` is sufficient or
an immutable endpoint ID is required.

### 2. Dispatch integration prototype

Prototype both competing approaches:

1. a mail-specific injector using the native session dispatch lock; and
2. origin-tagged entries in the shared prompt queue.

Exercise user enqueue versus mail delivery, compose-draft creation, parked
dispatch, cold attach, busy sessions, and crashes before and after provider
acceptance. Verify user ordering, `allowProviderCommands: false`, and ambiguous
reconciliation.

### 3. Provider capability matrix

For Claude, Codex, OpenCode, Cursor, Grok, Pi, and Claude tmux, test:

- Agent MCP availability;
- authoritative per-session activity;
- safe provider-aware submission;
- request-ID reconciliation;
- provider-command suppression;
- transcript and inbox rehydration.

Model separate capabilities for receiving injected mail, reading mail through
MCP, sending mail, and replying.

### 4. Consent and authority review

Freeze the policy for:

- cross-project discovery and storage;
- cross-project automatic injection;
- Control MCP senders;
- workflow and review sessions;
- human and environment aliases;
- waking an unstarted, billable agent session.

These are product authority decisions rather than implementation details.

### 5. Carrier security

Fuzz the carrier with nested closing tags, malformed JSON, ANSI/control
characters, Unicode separators, fake metadata, huge bodies, and slash-command
text. Prefer the existing escaped JSON handoff convention unless tests establish
a stronger alternative.

### 6. Durable state machine

Define separate authoritative dimensions for:

- durable acceptance;
- pending placement;
- provider submission;
- ambiguous reconciliation;
- agent acknowledgement;
- human seen;
- failure, expiry, and discard.

Avoid one state such as `read` representing actions by different principals.

### 7. Storage and deletion

Benchmark the proposed limits with whole-file rewrites and concurrent backend
processes. Test retention, store-full behavior, idempotency-map saturation,
pending-index fairness, environment/project deletion, counterpart records, and
backup scrubbing. Decide explicitly whether accepted unread mail may be evicted.

### 8. UI and rehydration

Prototype a message that is stored, automatically injected, acknowledged, and
then rehydrated after a backend and renderer restart. Verify that it appears once,
that provenance remains visible, that the raw carrier does not become confusing
UI, and that multiple connected clients converge after missed events.

## Decisions to freeze before implementation

The first architecture decision record should settle:

1. mailbox identity lifetime;
2. addressable tab and workflow classes;
3. cross-project and external-sender consent;
4. prompt-queue integration versus a dedicated injection path;
5. delivery, agent-acknowledgement, and human-seen semantics;
6. reply and loop-prevention behavior;
7. text-only versus attachment support;
8. closed-tab and deletion behavior.

Nearly every later schema, migration, security rule, and UI choice depends on
these decisions.
