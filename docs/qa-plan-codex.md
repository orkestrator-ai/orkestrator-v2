# Agent question and answer plan

Date: 2026-07-31

Status: proposed implementation plan

## Goal

Make agent questions, approvals, permissions, plan decisions, and MCP
elicitations behave predictably across every Orkestrator surface.

The end state must preserve the strong interactive experience that already
exists while giving unattended workflows an explicit, provider-neutral policy.
An automated build or looped review must never depend on a mounted React tree,
wait invisibly for a person, invent an answer, or approve an unexpected request
because nobody is present.

This document uses **question and answer** as the product-level term for all
blocking agent interactions. It is not a test-quality-assurance plan.

## Executive summary

The native interactive surfaces already solve most of the difficult UI and
recovery problems:

- Claude Native, OpenCode Native, Codex Native, and Claude tmux present
  blocking cards above the composer.
- Native sessions reconcile pending requests from an authoritative bridge or
  provider snapshot instead of relying only on SSE events.
- The global activity indicator can show an inactive environment as waiting.
- Claude and Codex fail closed when an interactive request expires or its
  process generation dies.

The missing layer is an explicit workflow policy. Build pipelines and looped
reviews tell the model not to ask questions, but prompt text is not enforcement.
OpenCode build pipelines currently reject questions and grant permissions once;
Claude and Codex instead park invisible requests until their five-minute
timeouts. Looped reviews have no provider request monitor at all, so OpenCode
can remain busy indefinitely while waiting for an answer.

The implementation should therefore proceed on two parallel tracks that meet
at one normalized contract:

1. Normalize presentation, state, deadlines, and resolution semantics for
   interactive sessions without discarding provider-specific payloads.
2. Enforce a backend-owned unattended policy for build pipelines and looped
   reviews, with immediate denial/cancellation and an explicit workflow failure.

## Scope

### Included

- Claude Native questions and plan approvals.
- OpenCode Native questions and permission requests.
- Codex Native approvals, user-input questions, MCP forms, and MCP URL
  elicitations.
- Claude tmux questions, plans, permissions, approvals, elicitations, and
  detected terminal selection prompts.
- Ordinary one-pass code-review tabs.
- Backend-owned build pipelines.
- Looped-review workflows, including their controller lifetime.
- Inactive-environment indicators, snapshot reconciliation, expiry, and
  restart recovery.
- Provider-neutral protocol types, policy enforcement, metrics, and tests.

### Not included

- Replacing provider CLIs' own question UI inside raw xterm terminal tabs.
- Inventing answers to substantive questions in unattended workflows.
- Automatically approving an app-server request that would otherwise require
  human approval.
- Flattening all provider wire formats into one lossy payload.
- Persisting plaintext draft answers, secrets, or full prompt content solely
  for telemetry.
- Changing the existing structured review result schema except where a new
  workflow failure kind is required.

## Terminology

- **Interaction:** Any provider request that blocks or materially gates an
  agent turn until the client responds.
- **Question:** Choice, multi-choice, free-text, or secret input requested from
  a person.
- **Approval:** A request to authorize a command, file change, plan transition,
  privilege, or other side effect.
- **Permission:** A provider-specific authorization request, such as OpenCode's
  permission request.
- **Elicitation:** An MCP form or URL completion request.
- **Interactive session:** A normal user-facing native or tmux chat in which a
  blocking card can be answered by a person.
- **Unattended session:** A build-pipeline or looped-review session expected to
  advance without a person.
- **Authoritative snapshot:** The complete current pending-interaction state
  returned by the bridge, provider, backend, or external process.
- **Live event:** An incremental notification. It improves latency but is never
  the only source of truth.

## Current surface inventory

| Surface | Current presentation | Current authority | Current timeout or unattended behavior |
| --- | --- | --- | --- |
| Claude Native | Shared question card plus plan-approval card | Claude bridge pending-question and pending-plan snapshots | Five minutes; timeout denies |
| OpenCode Native | Shared question card plus permission card | OpenCode `question.list()` and `permission.list()` | Provider-owned lifetime |
| Codex Native | Approval card plus specialized interaction/MCP card | Codex bridge approval and interaction snapshots | Five minutes by default; a shorter question deadline may apply |
| Claude tmux | Questions, plans, permissions, approvals, elicitations, and detected TUI prompts | Backend pending-hook files and tmux state | Ten minutes, but the UI does not show the deadline |
| Raw terminal tabs | Provider CLI/TUI inside xterm | PTY/provider process | Provider-owned; no React blocking card |
| Ordinary code review | The selected provider's normal native chat | Same as the normal native surface | Clarifying questions are allowed |
| Build pipeline | Transcript and queued user-message composer only | Backend `BuildPipelineService` | OpenCode rejects questions; Claude/Codex wait invisibly and later fail closed |
| Looped review | No blocking interaction surface | React supervisor plus provider session | No normalized monitor; OpenCode may wait without a bound |

## Problems to solve

### 1. Prompt guidance is mistaken for an execution policy

The build and looped-review prompts say not to ask questions. A model, tool, MCP
server, or provider can still issue an interaction request. The supervisor must
decide what happens independently of the prompt.

### 2. Unattended behavior differs by provider

OpenCode build sessions have a request monitor. Claude and Codex build sessions
use their ordinary interactive bridge behavior. Looped-review adapters expose
only prompt, result, status, and abort operations. These differences create
silent five-minute delays for Claude/Codex and potentially unbounded waiting for
OpenCode.

### 3. A provider can be waiting while the workflow says running

The workflow status types do not distinguish active computation from a blocked
interaction. A poller therefore cannot report why progress stopped or enforce a
workflow-specific deadline.

### 4. Looped-review control is not fully backend-owned

The looped-review snapshot and controller lease are persisted, but phase
advancement is driven by React. Navigating away is safe because the supervisor
is mounted at application scope; quitting the application still stops workflow
advancement.

### 5. Shared presentation is incomplete

`QuestionCard` provides the common question wizard and countdown behavior, but
Codex MCP/user interactions and Claude tmux prompts do not consistently use the
same blocking container and deadline conventions.

### 6. Draft and request durability are easy to conflate

Pending requests rehydrate from providers or bridges. Answer drafts are a
bounded in-memory renderer convenience and do not survive an application
restart. The product should preserve this distinction unless encrypted draft
persistence is deliberately designed later.

## Non-negotiable invariants

Every milestone must preserve these rules:

1. Long-running and pending-interaction authority lives in a backend, bridge,
   persistent store, provider, or external process—not only mounted React state.
2. Unmounting a component or changing the active environment does not cancel a
   request or stop background work.
3. Live events are incremental updates over authoritative snapshots.
4. A missed event is detectable through a revision gap, generation change,
   expired cursor, or explicit reconciliation response.
5. A connected SSE frame must not advance a client past events it requested for
   replay.
6. Every provider request is resolved exactly once.
7. Timeout, disconnect, malformed answers, dead generation, stale request, and
   abandoned session deny or cancel; they never approve.
8. An unattended workflow never guesses a substantive answer.
9. An unattended workflow never converts an unexpected approval prompt into an
   approval. Required execution privileges are configured before dispatch.
10. A request from a dead Codex app-server generation is never answered.
11. An OpenCode or Claude request that is no longer in the authoritative
    snapshot cannot remain visible or be answered through stale UI state.
12. User-visible request content, answer content, terminal content, file
    content, credentials, tokens, and attachment data never enter logs or
    metrics.
13. Pending-request collections, answer payloads, free-text fields, option
    lists, and stored failure summaries have explicit count and byte limits.
14. The Codex app-server stdout loop never awaits UI rendering, SSE writes,
    workflow polling, or policy evaluation.
15. Queued pipeline user messages are ordinary follow-up prompts, not implicit
    answers to a pending provider question.

## Target architecture

```text
Provider / MCP server / tmux hook
                |
                | provider-specific request
                v
Bridge or backend provider adapter
                |
                +-- retain exact provider payload and response mapper
                +-- normalize request metadata and presentation payload
                +-- publish authoritative pending snapshot + revisions
                |
                v
Interaction policy evaluator
       |                          |
       | interactive              | unattended
       v                          v
Pending request snapshot     deny/cancel immediately
+ replayable live event      + record bounded failure reason
       |                     + fail the workflow phase
       v
Shared blocking-card shell
+ provider-specific body/response adapter
```

The normalized contract is a coordination layer, not a replacement for each
provider's protocol. The bridge/provider adapter must retain the exact payload
and the exact response mapping needed to answer the upstream request.

## Normalized interaction contract

Add a shared contract in
`packages/protocol/src/agent-interactions.ts`. Export it from the protocol
package's public entry point and test its guards independently.

The following shape is illustrative; implementation may refine field names but
must preserve the distinctions:

```ts
export type AgentProvider = "claude" | "opencode" | "codex";

export type AgentInteractionKind =
  | "question"
  | "plan-approval"
  | "command-approval"
  | "file-approval"
  | "permission"
  | "mcp-form"
  | "mcp-url"
  | "elicitation"
  | "terminal-selection";

export type AgentInteractionOrigin =
  | { surface: "native-chat"; tabId?: string }
  | { surface: "claude-tmux"; tabId: string }
  | { surface: "build-pipeline"; workflowId: string; phase: string }
  | { surface: "looped-review"; workflowId: string; phase: string };

export type AgentInteractionState =
  | "pending"
  | "answering"
  | "answered"
  | "denied"
  | "cancelled"
  | "expired"
  | "abandoned";

export interface AgentInteractionRequest {
  id: string;
  provider: AgentProvider;
  providerSessionId: string;
  environmentId: string;
  kind: AgentInteractionKind;
  origin: AgentInteractionOrigin;
  requestedAt: number;
  expiresAt?: number;
  revision: number;
  state: "pending" | "answering";
  title?: string;
  description?: string;
  questions?: AgentInteractionQuestion[];
  approval?: AgentApprovalPresentation;
  elicitation?: AgentElicitationPresentation;
  providerGeneration?: string;
}

export interface AgentInteractionQuestion {
  id: string;
  prompt: string;
  header?: string;
  multiple: boolean;
  customAnswer: "disabled" | "plain" | "secret";
  options: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
}

export type AgentInteractionResolution =
  | { outcome: "answered"; answers: Record<string, string[]> }
  | { outcome: "approved"; scope: "once" | "session" | "always" }
  | { outcome: "denied"; reason?: string }
  | { outcome: "cancelled"; reason?: string };

export type AgentInteractionApplyResult =
  | { status: "applied" }
  | { status: "stale"; finalState?: AgentInteractionState }
  | { status: "invalid"; message: string }
  | { status: "failed"; retryable: boolean; message: string };
```

### Contract requirements

- IDs are opaque, stable within the request lifetime, and never derived only
  from question text. Provider text may be duplicated.
- Option IDs and submitted provider values are kept distinct where a provider
  requires it.
- The public payload includes only what the UI or workflow needs. Raw provider
  objects stay behind the adapter.
- Secret inputs are never copied into drafts, telemetry, errors, transcripts,
  or persisted workflow state unless the upstream provider itself makes them
  part of its authoritative transcript.
- `revision` changes on every authoritative pending-state transition.
- `expiresAt` is absolute epoch milliseconds and comes from the authority that
  owns the timeout.
- Stale responses are normal reconciliation outcomes, not generic server
  errors.
- Validation rejects unknown interaction kinds, oversized payloads, invalid
  option references, missing required questions, and answers for a different
  session.

## Interaction policies

Add a policy to every backend-created native session. Persist the policy with
the logical session identity so a bridge restart or backend reconciliation
cannot silently change it.

```ts
export type AgentInteractionPolicy =
  | { mode: "interactive" }
  | {
      mode: "unattended";
      workflow: "build-pipeline" | "looped-review";
      unexpectedRequest: "deny-and-fail";
    };
```

Keep the first implementation deliberately small. Do not introduce a general
rule language until a real product case requires it.

### Interactive policy

- Publish the request in the authoritative pending snapshot.
- Emit an incremental event after the snapshot state is committed.
- Mark the environment as waiting.
- Render the appropriate blocking card above the composer.
- Preserve the user's draft while the request remains pending.
- Apply a response exactly once and reconcile after ambiguous transport errors.
- On timeout or process death, remove the card and append or surface a concise
  provider-neutral explanation.

### Unattended policy

- Questions and MCP elicitations are cancelled/rejected immediately.
- Unexpected approvals and permissions are denied immediately.
- The workflow phase fails with failure kind `interactive-request`.
- The failure records provider, interaction kind, workflow phase, session ID,
  and timestamps, but not the full prompt or answer payload.
- The user-facing failure explains that the agent requested interactive input
  during an automated run.
- The backend persists a resolution intent before sending the provider response,
  then marks the workflow failed after the provider accepts or the request is
  proven stale. This prevents either a parked provider or a lost workflow
  failure across a crash.
- A transport failure while denying is retried only when the provider contract
  proves the request is still live and the retry is idempotent. Otherwise the
  workflow fails and reconciles the authoritative request snapshot.

Execution permissions required for a trusted automated phase must be selected
when the provider session or turn starts—for example Claude permission mode or
Codex sandbox policy. They must not be granted by clicking an unexpected
mid-turn approval on the user's behalf. OpenCode's existing pipeline behavior
that replies `once` to every permission request should migrate to this rule:
configure the intended phase policy up front, and deny/fail if the provider
still asks unexpectedly.

The existing “do not ask questions” prompt language remains as defense in
depth, but tests must prove that policy enforcement works even when a provider
does ask.

### Crash consistency for unattended requests

Persist a small workflow-owned interaction-resolution record before responding
upstream:

```ts
interface UnattendedInteractionResolution {
  workflowId: string;
  workflowRevision: number;
  provider: AgentProvider;
  providerSessionId: string;
  interactionId: string;
  interactionKind: AgentInteractionKind;
  phase: string;
  action: "deny-and-fail";
  state: "claimed" | "provider-resolved" | "workflow-failed";
  claimedAt: string;
  updatedAt: string;
}
```

Recovery rules:

1. `claimed`: reconcile the provider snapshot. If the request is still live,
   deny/cancel it; if absent, treat the provider side as stale/resolved. Do not
   approve and do not resend the workflow prompt.
2. `provider-resolved`: persist the workflow failure.
3. `workflow-failed`: clear the resolution record after the terminal workflow
   snapshot is durable.
4. A different controller generation may adopt the record only through the
   existing pipeline revision or looped-review controller fence.
5. Bound retained records and clean terminal records during normal storage
   maintenance.

## State machine and resolution rules

```text
                     answer starts
pending --------------------------------> answering
   |                                          |
   | authority timeout                        | provider accepts
   v                                          v
expired                                    answered
   |
   +-- disconnect / close / generation death -> denied or abandoned

pending -- explicit reject -----------------> denied
pending -- provider withdraws --------------> cancelled
answering -- stale authoritative snapshot --> stale result + reconcile
```

Requirements:

- Only the authority moves a request into a terminal state.
- UI optimistic state may show `answering`, but it cannot declare `answered`
  before the authority acknowledges it.
- Submit and dismiss controls are disabled while a response is in flight.
- A retry reuses an idempotency token when the provider adapter supports one.
- Closing an interactive live session responds to every live provider request
  before releasing local state.
- Closing or timing out a dead-generation Codex request withdraws the UI card
  without sending a response to the dead child.
- Reconciliation removes requests absent from an authoritative snapshot, even
  if a matching live event was missed.

## Surface behavior

### Native chat

- Continue pinning blocking cards directly above the composer through
  `NativeChatShell`.
- Keep questions out of the scrollback message list while pending. Once
  resolved, provider transcript/history remains the authority for any durable
  record.
- Reconcile on mount, activation, reconnect, revision gap, and provider
  generation change.
- Preserve amber `waiting` precedence over blue `working` in the global
  activity indicator.
- Make every card show the same deadline, expired, submitting, retry, stale,
  and withdrawn states.

### Claude tmux

- Add `requestedAt` and `expiresAt` to normalized pending-hook records returned
  by `claude_tmux_pending_hooks`.
- Use the shared blocking-card shell and deadline hook for all hook-card types.
- Keep the backend pending-hook files authoritative; do not move authority into
  `ClaudeTmuxChatTab`.
- When a detected terminal selection prompt cannot be assigned a reliable
  backend deadline, omit the countdown instead of inventing one.

### Raw terminal tabs

- Leave provider TUI interaction in xterm.
- Continue exposing terminal activity through the terminal/session indicator
  where detectable.
- Do not create a second React request for terminal text that is already owned
  by the provider TUI.

### Ordinary one-pass reviews

- Continue treating these as interactive native sessions.
- Clarifying questions remain allowed.
- Review-specific controls such as Address All must not hide or replace an
  active blocking interaction.

### Build pipelines

- The backend remains the only workflow controller.
- `BuildChatTab` stays a transcript/controller view, not the owner of pending
  interaction state.
- An unexpected interaction fails the active phase immediately and visibly.
- Queued user messages remain follow-up prompts delivered when idle; they do
  not rescue or answer the failed interaction.
- Resume/retry starts from the existing pipeline failure context and a fresh or
  reconciled provider state. It must not blindly redispatch a prompt whose
  acceptance was ambiguous.

### Looped reviews

- Move phase advancement and provider polling from the React supervisor into a
  backend `LoopedReviewService`, using `NativeAgentService` for durable logical
  sessions and dispatch.
- Persist workflow state, controller generation/fence, provider session IDs,
  request IDs, structured-result wait state, and failure context.
- React becomes a snapshot-driven viewer/controller. It may request start,
  pause, resume, retry, or cancel; it does not need to remain mounted for work
  to progress.
- Apply the same unattended interaction policy as build pipelines.
- Preserve the existing structured-result validation and target-branch-aware
  review semantics.

## Provider mappings

### Claude Native

- Map `AskUserQuestion` to normalized `question`.
- Map `ExitPlanMode` to `plan-approval`.
- Preserve the SDK callback/promise as the exact-once response authority.
- Retain the existing five-minute fail-closed timeout for interactive sessions.
- Add session origin and policy when `NativeAgentService` creates or resumes a
  backend-owned session.
- Replace question-text answer keys internally where possible with stable
  normalized question IDs, translating back only at the SDK boundary.
- Continue rejecting duplicate-text payloads if the pinned SDK makes unique
  text unavoidable, but surface the rejection as a provider limitation.

Primary files:

- `bridges/claude-bridge/src/services/session-manager.ts`
- `bridges/claude-bridge/src/routes/session.ts`
- `bridges/claude-bridge/src/types/index.ts`
- `apps/web/src/lib/claude-client.ts`
- `apps/web/src/components/claude/ClaudeQuestionCard.tsx`
- `apps/web/src/components/claude/ClaudePlanApprovalCard.tsx`

### OpenCode Native

- Map `question.list()` entries to normalized `question`.
- Map `permission.list()` entries to normalized `permission`.
- Preserve OpenCode's multiple-choice, custom-answer, and permission response
  semantics at the SDK boundary.
- Add policy-aware monitoring to the backend provider adapter rather than only
  the build-specific OpenCode class.
- Reconcile both lists when adopting or restarting a provider session.
- In unattended mode, reject questions and deny permissions immediately, then
  fail the workflow. Do not leave a busy session waiting indefinitely.

Primary files:

- `apps/backend/src/core/build-pipeline-provider.ts`
- `apps/backend/src/core/native-agent-service.ts`
- `apps/web/src/lib/opencode-client.ts`
- `apps/web/src/components/opencode/OpenCodeQuestionCard.tsx`
- `apps/web/src/components/opencode/OpenCodePermissionCard.tsx`

### Codex Native

- Map command, file-change, and permission requests to normalized approvals.
- Map `item/tool/requestUserInput` to normalized questions.
- Map MCP form and URL elicitation without losing typed field or completion
  semantics.
- Keep the app-server generation, thread, turn, and item identity behind the
  bridge boundary.
- Preserve the five-minute maximum and any shorter `autoResolutionMs` deadline.
- Never answer a request belonging to a dead generation.
- Keep policy evaluation off the app-server stdout loop. Enqueue a bounded
  routing task and let the read loop continue.

Primary files:

- `bridges/codex-bridge/src/app-server/server-request-router.ts`
- `bridges/codex-bridge/src/app-server/approvals.ts`
- `bridges/codex-bridge/src/app-server/interactions.ts`
- `bridges/codex-bridge/src/app-server-runtime.ts`
- `bridges/codex-bridge/src/index.ts`
- `apps/web/src/lib/codex-client.ts`
- `apps/web/src/components/codex/CodexApprovalCard.tsx`
- `apps/web/src/components/codex/CodexInteractionCard.tsx`

## Delivery plan

### Milestone 0 — Contract, baseline, and failure injection

#### Work

- Add `packages/protocol/src/agent-interactions.ts` with types, validators,
  bounds, and exhaustive kind/state guards.
- Add `interactionPolicy` and session origin to backend-created native-agent
  session metadata. Default existing user-created sessions to `interactive`.
- Add `interactive-request` to build-pipeline and looped-review failure kinds.
- Define a privacy-safe failure summary and serialization version.
- Add provider test fixtures that deliberately ask one question and issue one
  unexpected permission/approval.
- Record baseline behavior for all provider/surface combinations, including
  time spent invisibly blocked.

#### Primary files

- `packages/protocol/src/agent-interactions.ts` (new)
- `packages/protocol/src/agent-interactions.test.ts` (new)
- `packages/protocol/src/build-pipeline.ts`
- `apps/backend/src/core/models.ts`
- `apps/backend/src/core/storage.ts`
- `apps/backend/src/core/native-agent-service.ts`
- provider bridge and adapter test fixtures

#### Exit criteria

- The protocol rejects malformed, cross-session, oversized, and unknown-kind
  interactions.
- Existing persisted native sessions migrate to `interactive` without data
  loss.
- A workflow failure can identify provider, kind, phase, and session without
  storing question content.
- Tests can force every provider to ask despite prompt instructions.

### Milestone 1 — Consistent interactive presentation

#### Work

- Extract or extend a common `BlockingInteractionCard` shell for title,
  description, deadline, expired state, error/retry state, and actions.
- Keep `QuestionCard` as the question wizard inside that shell.
- Move `CodexInteractionCard` onto the shared shell and wire
  `interaction.expiresAt` through `usePromptDeadline`.
- Add authoritative deadline fields to Claude tmux hook snapshots and pass them
  into the UI.
- Standardize applied, stale, invalid, retryable failure, and withdrawn UI
  behavior.
- Keep prompt drafts keyed by provider/session/request/question and clear them
  only after applied/stale terminal resolution.
- Explicitly exclude secret fields from the draft store.

#### Primary files

- `apps/web/src/components/chat/BlockingPromptCard.tsx`
- `apps/web/src/components/chat/QuestionCard.tsx`
- `apps/web/src/hooks/usePromptDeadline.ts`
- `apps/web/src/stores/promptDraftStore.ts`
- `apps/web/src/components/codex/CodexInteractionCard.tsx`
- `apps/web/src/components/claude/ClaudeTmuxChatTab.tsx`
- `apps/backend/src/core/tmux.ts`

#### Exit criteria

- Every app-owned interactive card has consistent waiting, submitting, expired,
  stale, and error presentation.
- Codex short auto-resolution deadlines visibly count down.
- Claude tmux's ten-minute timeout is visible and agrees with backend time.
- Switching environments while typing preserves non-secret drafts and returns
  to the authoritative pending request.
- Restarting the renderer restores the request but not plaintext draft content.

### Milestone 2 — Provider-neutral pending-request capability

#### Work

- Extend `BuildPipelineProvider` or introduce a sibling
  `NativeAgentInteractionProvider` with:

  ```ts
  listPendingInteractions(sessionId): Promise<AgentInteractionRequest[]>;
  resolveInteraction(sessionId, interactionId, resolution): Promise<AgentInteractionApplyResult>;
  watchInteractions?(sessionId, onRevision): Unsubscribe;
  ```

- Implement Claude, OpenCode, and Codex adapters using their authoritative
  snapshots.
- Register session origin and policy at session creation/adoption.
- Reconcile pending requests during backend startup, bridge restart, provider
  reconnect, session adoption, and workflow resume.
- Make request monitoring backend-owned and independent of any visible tab.
- Bound monitor concurrency, retries, response bytes, and per-session pending
  request counts.

#### Primary files

- `apps/backend/src/core/build-pipeline-provider.ts`
- `apps/backend/src/core/native-agent-service.ts`
- `apps/backend/src/core/commands.ts`
- `bridges/claude-bridge/src/routes/session.ts`
- `bridges/codex-bridge/src/index.ts`
- provider client wrappers

#### Exit criteria

- The backend can enumerate a session's pending interactions identically for
  all three providers.
- An absent or restarted renderer has no effect on monitoring.
- A bridge/provider restart either rehydrates the request or produces an
  explicit abandoned/stale outcome.
- No monitor callback can stall the Codex stdout loop.

### Milestone 3 — Uniform build-pipeline enforcement

#### Work

- Remove the OpenCode-only request policy from its private monitor and apply the
  shared unattended policy through `NativeAgentService`.
- On the first pending request, claim the request under the current pipeline
  generation/fence, deny or cancel it, and record `interactive-request` failure.
- Preserve the provider's exact fail-closed response semantics.
- Surface the failure in `BuildCompletionStatus` and the pipeline transcript
  header without rendering an answer card.
- Include a retry action that creates/reconciles the next attempt safely.
- Keep “do not ask questions” in pipeline prompts as defense in depth.
- Ensure pipeline status never remains `running` after an unattended request is
  detected and resolved.

#### Primary files

- `apps/backend/src/core/build-pipeline-provider.ts`
- `apps/backend/src/core/build-pipeline-service.ts`
- `packages/protocol/src/build-pipeline.ts`
- `apps/web/src/components/build-pipeline/BuildChatTab.tsx`
- `apps/web/src/components/build-pipeline/BuildCompletionStatus.tsx`

#### Exit criteria

- Claude, OpenCode, and Codex questions fail a pipeline within one monitor
  interval rather than after a provider timeout.
- Unexpected approvals and permissions are denied, never approved.
- No pipeline question can be answered accidentally through the queued-message
  composer.
- Restarting the backend during detection converges to one provider response
  and one workflow failure.
- Provider-specific tests demonstrate equivalent product behavior.

### Milestone 4 — Backend-owned looped-review controller

#### Work

- Introduce `apps/backend/src/core/looped-review-service.ts` using the established
  storage, command-registry, and `NativeAgentService` patterns.
- Port phase selection, prompt construction, provider-session reuse, structured
  result polling, missing-result bounds, iteration transitions, pause/resume,
  cancellation, and PR completion from `LoopedReviewTab`/supervisor.
- Keep the controller lease/fence or replace it with an equivalent backend
  generation guard. There must be exactly one active controller generation.
- Persist every transition before dispatching downstream work that assumes the
  transition occurred.
- Subscribe/monitor before calculating replay/recovery work so no provider
  interaction can arrive in the gap.
- Apply the shared unattended interaction policy to every review phase,
  including preparation, review, fix, verification, and PR creation.
- Convert `LoopedReviewSupervisor` into hydration and command wiring, then
  remove it once the backend service is authoritative.
- Keep `LoopedReviewTab` as a snapshot-driven viewer with pause, resume, retry,
  cancel, and open-session actions.

#### Primary files

- `apps/backend/src/core/looped-review-service.ts` (new)
- `apps/backend/src/core/looped-review-service.test.ts` (new)
- `apps/backend/src/core/native-agent-service.ts`
- `apps/backend/src/core/commands.ts`
- `apps/backend/src/core/storage.ts`
- `apps/web/src/components/review/LoopedReviewSupervisor.tsx`
- `apps/web/src/components/review/LoopedReviewTab.tsx`
- `apps/web/src/lib/structured-review-agent.ts`
- `apps/web/src/lib/looped-review-persistence.ts`
- `apps/web/src/stores/loopedReviewStore.ts`

#### Exit criteria

- A looped review advances while its tab is closed, another environment is
  active, and no corresponding React tree is mounted.
- After the desktop renderer exits and returns, the backend workflow has either
  progressed or reached an explicit terminal/paused state.
- Every provider question or unexpected permission/approval fails the active
  phase promptly and visibly.
- OpenCode cannot remain indefinitely busy on a pending question.
- Controller takeover, backend restart, and duplicate-renderer tests prove
  exactly one phase transition and no duplicate prompt dispatch.

### Milestone 5 — Activity, diagnostics, and operational hardening

#### Work

- Extend global activity snapshots with a provider-neutral waiting reason for
  interactive sessions and a bounded failure reason for unattended sessions.
- Add privacy-safe counters:
  - interactions presented by provider/kind/surface;
  - interactions answered, denied, expired, abandoned, or stale;
  - unattended requests detected and time-to-failure;
  - reconciliation and revision-gap counts;
  - requests recovered after renderer, bridge, or backend restart.
- Do not log titles, descriptions, questions, options, answers, commands, file
  paths, URLs, MCP form fields, or terminal content.
- Add bounded rate limiting for malformed response attempts.
- Add operational documentation for diagnosing a workflow that reports an
  unexpected interactive request.

#### Primary files

- `apps/web/src/hooks/useGlobalActivityMonitor.ts`
- `packages/protocol/src/agent-activity.ts`
- bridge metrics modules
- backend pipeline and looped-review service metrics
- relevant operational documentation

#### Exit criteria

- Interactive waiting remains visible globally even when the tab is inactive.
- Unattended workflows expose an actionable failure rather than an amber state
  that nobody can answer.
- Metrics can demonstrate zero invisible request waits without exposing user
  content.
- Malformed or repeated submissions cannot grow memory or logs without bound.

### Milestone 6 — Remove compatibility paths and declare policy stable

#### Work

- Remove the OpenCode build-only `autoAnswerRequests` switch after all callers
  use the shared policy.
- Remove React-owned looped-review advancement after backend parity and recovery
  tests pass.
- Remove duplicate provider-specific presentation state where the normalized
  contract is authoritative, while retaining exact provider response mappers.
- Version and document the final contract and persisted migrations.
- Update project documentation and AGENTS guidance with the unattended-session
  rules.

#### Exit criteria

- There is one documented policy path for build pipelines and looped reviews.
- No production path depends only on “do not ask” prompt language.
- No automated workflow requires a hidden terminal or mounted chat tab.
- All compatibility flags have an owner, removal condition, and final state.

## Test plan

### Protocol tests

- Accept each supported interaction kind.
- Reject missing IDs, invalid state, invalid timestamps, duplicate question IDs,
  unknown option IDs, and cross-session responses.
- Enforce limits for question count, option count, string length, answer count,
  and serialized bytes.
- Prove secret fields are excluded from draft/persistence serializers.
- Round-trip every persisted policy and failure version.

### Provider adapter contract suite

Run the same behavioral suite against Claude, OpenCode, and Codex adapters:

1. List no pending requests.
2. List one question.
3. Resolve a valid answer.
4. Deny or cancel.
5. Receive a stale response after provider withdrawal.
6. Reconcile a request missed by live events.
7. Reject a response for another session.
8. Handle provider restart/generation death.
9. Handle timeout.
10. Handle malformed provider payload.
11. Bound multiple simultaneous requests.
12. Prove resolution occurs exactly once under concurrent attempts.

### Interactive UI matrix

For each native provider, test:

- single-choice, multi-choice, custom, and free-text where supported;
- required-field validation;
- submit, dismiss/deny, retryable error, stale response, and expiry;
- countdown agreement with the authoritative deadline;
- environment switch while pending;
- tab unmount/remount while pending;
- SSE disconnect followed by snapshot reconciliation;
- bridge/provider restart;
- non-secret draft preservation across unmount;
- draft removal after resolution;
- no secret draft retention;
- global amber waiting precedence;
- mobile/narrow layout and keyboard navigation.

Add Claude tmux cases for each hook type plus the ten-minute deadline.

### Build-pipeline matrix

For every provider and representative phase:

- force a question despite prompt instructions;
- force an unexpected permission/approval;
- verify immediate deny/cancel and `interactive-request` failure;
- verify no five- or ten-minute invisible wait;
- restart the renderer while the request arrives;
- restart the backend between request detection and workflow failure;
- restart the provider/bridge during resolution;
- retry the failed phase;
- verify a queued user message is not consumed as an answer;
- verify configured phase privileges do not produce unexpected approvals in the
  normal success path.

### Looped-review matrix

Repeat the build-pipeline cases for preparation, review, fix, verification, and
PR phases. Additionally test:

- no visible looped-review tab;
- another environment selected;
- renderer process closed;
- backend restart and controller recovery;
- two renderer clients attempting control;
- expired controller lease takeover;
- provider idle without a structured result;
- OpenCode busy with a pending question;
- ambiguous prompt dispatch and session adoption;
- max-iteration and cancellation boundaries.

### Inactive-environment acceptance test

For every interactive provider:

1. Start a turn in environment A.
2. Switch to environment B before the request arrives.
3. Let the provider issue a question or approval.
4. Verify environment A becomes globally amber/waiting.
5. Return to environment A.
6. Verify the authoritative card, deadline, and controls are correct.
7. Answer once.
8. Verify the turn resumes and the card cannot be answered again.

For automated workflows, repeat steps 1–3 but verify the workflow fails without
returning to environment A.

### Required validation commands

Use Bun throughout:

```bash
bun test packages/protocol --parallel
bun test bridges --parallel
bun test tests --parallel
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
bun run --cwd apps/desktop typecheck
bun run test
```

During development, run focused files first, always adding `--parallel` when a
suite contains multiple files. A final tranche must run the full suite.

## Rollout strategy

1. Land protocol types and passive instrumentation with no behavior change.
2. Land interactive UI consistency changes and verify provider snapshots.
3. Enable provider-neutral request monitoring in observe-only mode for
   unattended sessions. Record only metadata counts, never content.
4. Compare observe-only detections with current provider status and timeout
   behavior.
5. Enable `deny-and-fail` for new build pipelines, provider by provider.
6. Migrate existing resumable build pipelines when their next phase starts; do
   not change policy in the middle of a live provider request.
7. Ship the backend looped-review controller behind a persisted workflow
   version gate.
8. Migrate only idle or paused looped reviews automatically. Require an
   explicit resume for an old workflow that was running during upgrade.
9. Remove compatibility paths after one release with no invisible-wait
   detections and after restart/recovery tests pass in CI.

Rollback must disable new workflow dispatch while leaving provider request
denial fail-closed. A rollback must never turn a denied unattended interaction
into an approval or redispatch a prompt with ambiguous acceptance.

## Migration and compatibility

- Add a version to persisted interaction policy and failure records.
- Existing ordinary native sessions default to `interactive`.
- Existing build-pipeline sessions receive `unattended` when the backend next
  reconciles the owning pipeline.
- Existing looped reviews retain their current version until idle or paused;
  the backend service adopts them through an explicit version migration.
- Unknown future interaction kinds fail closed. Interactive UI may show an
  unsupported-request notice, but the adapter must still deny/cancel upstream.
- Older renderer clients can ignore the new bounded failure metadata and still
  see the workflow as failed.
- Provider-generated transcripts remain provider-owned; no migration rewrites
  them.

## Success measures

- Zero unattended questions remain pending longer than one monitor interval
  plus provider response latency.
- Zero unexpected unattended approvals or permissions are approved.
- Zero looped-review runs require a mounted renderer to advance.
- Every app-owned interactive request is recoverable from an authoritative
  snapshot after tab/environment switching.
- Every visible deadline agrees with the authority within normal clock/timer
  granularity.
- Every provider passes the same unattended request contract suite.
- No interaction content appears in logs or metrics.
- No regression in normal native chat answer, approval, plan, or permission
  flows.

## Suggested pull-request sequence

1. **Protocol and fixtures:** normalized contract, policy, bounds, failure kind,
   provider failure-injection fixtures.
2. **Interactive UI parity:** shared shell, Codex deadline, tmux deadlines,
   secret-draft exclusions.
3. **Provider capability:** common pending-request adapter and backend monitor
   for Claude, OpenCode, and Codex.
4. **Build enforcement:** shared deny-and-fail policy and pipeline failure UI.
5. **Looped-review backend service:** backend controller, persistence migration,
   renderer conversion.
6. **Recovery and observability:** restart matrix, global activity, privacy-safe
   metrics.
7. **Cleanup:** remove provider-specific automation and React controller
   compatibility paths.

Each pull request should be independently reversible, preserve fail-closed
behavior, and include its provider/surface slice of the test matrix.

## Definition of done

This plan is complete when:

- all interactive surfaces use authoritative pending snapshots and consistent
  blocking-card semantics;
- every automated session has a persisted unattended policy;
- build pipelines and looped reviews reject/cancel unexpected interactions and
  fail immediately with a clear reason;
- looped reviews advance under backend authority without a mounted renderer;
- inactive environment, reconnect, bridge restart, backend restart, and stale
  response paths are covered for all providers;
- timeout and generation-death paths remain fail-closed;
- metrics demonstrate the absence of invisible waits without collecting user
  content; and
- the full Bun test and typecheck suite passes.
