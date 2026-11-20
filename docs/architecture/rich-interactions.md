# Rich interactions

App-owned interactive cards in agent sessions: an agent presents a precise
decision (choose a design, edit a plan, select rows, review code, accept a
result, retry a stage), the person explores it locally and submits an explicit
decision, and Orkestrator delivers that decision to the session or operation
that owns it, once, with a visible receipt. The person can also compose
requests of their own: comment threads on exact content, a context tray, a
spoken request pointing at a target, and a recorded demonstration.

This document is the living reference for the implementation of the
"Interactive agent sessions" plan (all twenty features). Status of each
feature and its known limits are in [Feature status](#feature-status).

## The four objects

| Object | Where it lives | Role |
| --- | --- | --- |
| Content revision | Existing artifact/media stores, files, runs | What the person examined, named by a `ContentRef` (artifact revision, file at a content hash or explicitly live, run, captured URL, trace). |
| Request (`RichInteractionRequest`) | `rich-interaction-requests` store | The available decision: kind, kind-specific `spec`, registered actions, revision, state, owner. |
| Draft (`RichInteractionDraft`) | `rich-interaction-drafts` store | Non-secret, incomplete edits. Never dispatches. Revision-checked between windows. |
| Receipt (`RichInteractionReceipt`) | `rich-interaction-receipts` store | Validated user intent plus authoritative delivery state. |

A reference identifies content; it never grants authority. Ownership
(environment, tab, logical session key, agent) is assigned by the backend from
the authenticated caller when the request is created, and every decision is
delivered only to that stored destination.

## Code layout

| Area | Files |
| --- | --- |
| Contract, kinds, validators | `packages/protocol/src/rich-interactions/` (`core.ts`, `refs.ts`, `form.ts`, `kinds-*.ts`, `validate.ts`); tool names in `rich-interaction-tools.ts` |
| Contract domain | `packages/protocol/src/contract/domains/rich-interactions/` (10 commands) |
| Backend service | `apps/backend/src/core/rich-interactions/` (`service.ts`, `store.ts`, `layout.ts`, `deliverables.ts`, `product-commands.ts`, `tools.ts`, `index.ts`) |
| Command registration | `apps/backend/src/core/commands-registry-rich-interactions.ts` |
| Web data layer | `apps/web/src/lib/chat/rich-interactions.ts`, `apps/web/src/lib/backend/rich-interactions.ts` |
| Cards | `apps/web/src/components/chat/interactions/` (shell, registry, `kinds/*`) |
| Composer tools | `apps/web/src/components/chat/interactions/composer/` |
| Frame result candidates (feature 12) | `packages/protocol/src/artifact-frame-channel.ts`, `apps/web/src/lib/chat/artifact-result-candidates.ts`, the browser shell (`content-shell.ts`) and the Electron host (`artifact-host-shell.ts`, `artifact-host-session.ts`) |
| Demonstration recorder (feature 20) | `apps/desktop/electron/browser-preview-trace.ts`, IPC `orkestrator:browser-preview:trace-*` |

## Kinds and actions

A kind is a bounded, trusted component (`RichKindModule`): it reads its spec
when a request is created, reads a result when the person submits, projects
the decision into readable text, and may produce a new spec revision (a
user edit, a thread entry). There is no general component language.

Actions are registered per kind. An agent chooses which registered actions to
offer and may relabel them; the route and effect of an action id come from the
registry, never from the request or the client. Kinds that accept custom
intents (collection, chart selection, diagram) map them only to the ordinary
`agent-followup` route.

| Kind | Feature | Registered actions (route) |
| --- | --- | --- |
| `choice` | 1 | `submit` (follow-up) |
| `form` | 2 | `submit` (follow-up) |
| `plan` | 3 | `request-revision`, `accept-scope` (follow-up); `save` (user revision) |
| `collection` | 4 | `discuss-selected` + custom intents (follow-up) |
| `code-review` | 5 | `send-review` (follow-up) |
| `feedback` | 6 | `save-note`, `resolve`, `reopen` (record); `discuss`, `request-change` (follow-up) |
| `result-review` | 7 | `accept`, `accept-selected` (record); `request-changes` (follow-up) |
| `document` | 8 | `save` (user revision); `ask-revise` (follow-up) |
| `diagnostics` | 9 | `explain-selection`, `request-fix` (follow-up); `rerun-selection` (product command `diagnostics.rerun`) |
| `chart-selection` | 10 | `investigate-selection` + custom intents (follow-up) |
| `diagram` | 11 | `explain`, `failure-modes`, `plan-changes` + custom intents (follow-up) |
| `widget-result` | 12 | `send-result` (follow-up) |
| `evidence` | 14 | `explain-relevance`, `challenge-assumption`, `reassess-without` (follow-up) |
| `context-packet` | 15 | `send` (follow-up; user-originated) |
| `criteria` | 16 | `edit`, `review`, `walkthrough` (user revision); `agree`, `request-pass` (follow-up) |
| `alternatives` | 17 | `prefer`, `request-evidence`, `adopt` (follow-up) |
| `workflow-actions` | 18 | `explain-failure` (follow-up); `retry-node` (`workflow.retry`), `stop-node` (`workflow.stop`) |
| `voice-request` | 19 | `send` (follow-up; user-originated) |
| `demonstration` | 20 | `send` (follow-up; user-originated) |

Feature 13 (session deliverables) is a read model over the transcript-artifact
publication ledger plus the person's own metadata, not a kind.

Agents cannot create user-originated kinds (`feedback`, `context-packet`,
`voice-request`, `demonstration`); users cannot create agent kinds. Fields that
claim independently observed provenance (`orkestrator-observed`,
`user-confirmed`, `observed`) are refused in agent specs: Orkestrator assigns
them.

## Routes

- **agent-followup.** The receipt, the readable summary, the exact prompt text
  and the dispatch intent commit in one transaction. Delivery goes through the
  session's persistent prompt queue (`enqueuePromptQueueMessageIfAbsent`) with
  the receipt id as the queue request id and `origin: { kind:
  "rich-interaction" }`, so a retry can never queue the decision twice. The
  text is the readable summary followed by an inert
  `<orkestrator_interaction_result>` envelope naming the interaction, revision,
  receipt and action; the transcript renders it as a receipt
  (`interaction-receipt` part) instead of raw text.
- **product-command.** The action's `commandId` names a registered operation
  (`ProductCommandRegistry`). It rechecks live state before acting (a graph run
  must still be at the snapshot revision and the named attempt) and reports
  `applied`, `failed` or `unknown`; a stop that does not report `cancelled` is
  `unknown`, never "stopped". An operation is claimed before it runs and is
  never re-run automatically. Registered today: `workflow.retry` and
  `workflow.stop` for graph runs. `diagnostics.rerun` is not registered, so the
  card shows it disabled with its reason.
- **record-only.** The decision is committed with no dispatch (a saved note, an
  acceptance, a user revision).
- **provider-resolution.** Reserved for decorating a real provider-native
  question; see [Not done](#not-done).

## Lifecycle and recovery

1. The card reads the authoritative snapshot (`rich_interaction_get`) on mount
   and re-reads on the environment's `rich-interaction` resource hint, on
   resync and on the view safety check. A virtualized row remount restores the
   last snapshot from a bounded display cache, then re-reads.
2. Drafts are local first and synced after a pause with the expected draft
   revision; a conflict keeps the local draft and shows it.
3. Submit validates shape, action, revision, expiry and capacity
   (`readSubmission`), then commits once per `(interactionId, idempotencyKey)`.
   The receipt id is a digest of the two, so an identical retry returns the
   original receipt and a changed payload under the same key is a conflict.
4. The renderer keeps the idempotency key of a deliberate action until its
   outcome is known (lost responses, double clicks and reconnects reuse it);
   a new deliberate action gets a new key.
5. Delivery runs after the commit; a sweep (`RichInteractionService.start`,
   every 5 s and at startup) resumes `pending` and `queued` receipts, so a
   backend restart between commit and dispatch resumes delivery. After five
   failed enqueue attempts a follow-up becomes `unknown` and is never resent
   automatically; the person may retry it explicitly, which re-enqueues the
   identical bytes under the same request id.
6. Delivery states are distinct: `recorded`, `pending`, `queued`, `delivered`
   (the session dispatched the request id), `applied`, `failed`, `unknown`.

A request changed by the agent (`update_interaction`) or by a user revision
bumps its revision; a submission against an older revision is `stale`, and
the draft is kept. Superseded and expired requests refuse submissions.
Deleting an environment removes its requests, receipts, drafts and
deliverable metadata (owner sweep in `environment-delete.ts`).

## Budgets

`RICH_INTERACTION_LIMITS`: result 64 KiB, summary 16 KiB (cut with an omission
notice), inline spec 512 KiB, draft 64 KiB, 100 open requests per conversation,
2,000 per environment, 200 receipts per request. Forms: 64 fields, depth 3,
100 repeat items. Selections: 2,000 explicit ids. A capacity refusal keeps the
person's selection. These are starting budgets, not measured limits.

## Agent tools

`present_interaction`, `update_interaction`, `read_interaction_result` and
`list_interactions` are registered on the common `orkestrator` server for
tab-scoped credentials only, and auto-approved by every bridge
(`RICH_INTERACTION_TOOL_NAMES`). Authoring guidance is in the
[agent tool guide](transcript-artifacts-agent-guide.md#interactive-cards).

## Authored widget results (feature 12)

The frame channel gains one message, `result-candidate` (candidate protocol
2): `{ candidateId, value }` with the frame identity. The runtime exposes
`orkestratorArtifact.proposeResult(candidateId, value)`. Every relay (browser
shell, Electron shell and session, renderer frame session) validates and
rebuilds it. The renderer publishes it to `artifact-result-candidates.ts`
keyed by the exact artifact revision; only a `widget-result` interaction bound
to that revision shows it, checks it against the interaction's declared output
form, lets the person adjust it, freezes what was reviewed and submits on the
person's click. A newer candidate never replaces values under an open review.
The declared output lives on the interaction (bound to the artifact revision),
not inside the artifact's verified source.

## Feature status

| # | Feature | Implemented | Limits |
| --- | --- | --- | --- |
| 1 | Visual decision cards | Previews (artifact revision via its verified card, workspace image, Mermaid, diff, text), expand dialog, recommendation with rationale, "Something else", constraints, subchoices as questions | Native provider questions are not decorated (see Not done) |
| 2 | Rich forms | Shared field vocabulary and validator (text, multiline, number with units/slider, boolean, enum, multiselect, dates with zone semantics, files, lists, groups, repeat groups, conditions), review step | Secret fields refused by design |
| 3 | Editable plans | Stable-id change sets, dependency checks, comments, constraints, criteria, user revisions | Drag-and-drop ordering (buttons only) |
| 4 | Selectable tables | Typed columns, sort/filter, stable-id selection, hidden-selection count, partial collections, proposed edits | Server-held selection references for >2,000 rows |
| 5 | Inline code review | File/hunk/line anchors on either side, keep/revise/explain, trimmed-hunk refusal | Reattaching comments after the file changes |
| 6 | Persistent comments | Anchored threads (whole, quote, image region in the tray), save/discuss/request-change, agent append-only replies, resolve/reopen | Browser web-annotation threads stay in their own service (not unified) |
| 7 | Result review | Before/after comparisons, provenance labels, per-criterion acceptance bound to result revision; acceptance recorded on deliverables | No automatic image diff in this card |
| 8 | Document canvas | Side sheet, block edits with hash checks, preserved blocks, Markdown export, ask-revise | No live multi-cursor collaboration (out of scope by the plan) |
| 9 | Test/build cards | Baseline, counts, filters, excerpts, evidence, explain/fix | Exact rerun has no registered runner |
| 10 | Chart selection | Existing chart viewer plus semantic table/range selection by stable ids | No drag brushing on the SVG |
| 11 | Diagram actions | Read-only Mermaid render plus accessible manifest selection | No click-to-select on the SVG itself |
| 12 | Widget results | Versioned candidate message through all hosts, host-owned review and submit | Declaration on the interaction, not in the artifact source hash |
| 13 | Deliverables panel | Ledger-backed list, versions, pins, labels, accepted revision, discuss/comment, open interactions | No drag grouping UI (group field only) |
| 14 | Evidence cards | Claims, evidence with provenance, asserted relevance, challenges | — |
| 15 | Context tray | Files (live or excerpt), excerpts, artifact revisions, image regions, notes, order, budgets, send | Tray is per window session, not persisted across reloads |
| 16 | Acceptance criteria | Agree/edit, evidence, human decisions bound to criterion hash, historical decisions, guided walkthrough with saved progress | — |
| 17 | Alternatives | Criterion-aligned comparison, unknown measurements, prefer/request evidence/prepare adoption at exact commit | No product command adopts code; adoption asks the agent for a reviewable change |
| 18 | Workflow controls | Graph-run retry/stop with live revision and attempt checks | Only graph runs have registered commands |
| 19 | Point and talk | Web Speech engine where available, frozen targets, editable text, typed fallback | No spoken replies; engine availability depends on the client |
| 20 | Demonstrations | Desktop recorder (semantic steps, never values, path-only routes, origin scope, bounds), review/trim, expected outcome | No keyframe screenshots; desktop only |

## Not done

- **Provider-resolution decoration.** Rich previews are not yet attached to
  real provider-native pending questions; those keep the existing question
  card. The route name is reserved.
- **Keyframes in demonstrations** and image diffs in result review.
- Measured performance budgets; the budgets above are starting values.
