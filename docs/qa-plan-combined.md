# Agent interaction plan

Date: 2026-07-31

Status: consolidated implementation plan

Sources:

- `docs/qa-claude.md`
- `docs/qa-plan-codex.md`

Milestone documents:

- `docs/qa/milestone-1.md` through `docs/qa/milestone-7.md`

## Goal

Make agent questions, approvals, permissions, plan decisions, MCP
elicitations, and related blocking interactions predictable across interactive
and automated Orkestrator surfaces.

Interactive requests must remain recoverable after an environment switch,
renderer remount, reconnect, or provider restart. Automated workflows must
never wait invisibly for a person or approve an unexpected request because no
person is present.

This is an agent question-and-answer plan, not a software test-QA plan.

## Consolidated policy decision

The source documents disagree about unattended questions. `qa-claude.md`
records a decision to decline the question and continue; `qa-plan-codex.md`
proposes denying every interaction and failing the phase. This plan preserves
the explicit recorded decision while retaining the stricter rule for
authorization requests:

| Unattended request class | Action | Workflow result |
| --- | --- | --- |
| Question, MCP form, MCP URL, or other elicitation | Decline/cancel immediately with a structured instruction to make the best safe assumption, state it, and continue | Continue, but durably record the auto-decline and expose its count |
| Unexpected command, file, plan, privilege, or provider permission approval | Deny immediately | Fail the active phase with `interactive-request` |
| Provider response cannot be safely or unambiguously applied | Fail closed and reconcile the authoritative snapshot | Fail the active phase |
| Unknown future interaction kind | Deny/cancel; never infer approval semantics | Fail the active phase |

Configured execution privileges for a trusted automated phase are selected at
session or turn creation. They are never granted by auto-answering an
unexpected mid-turn approval.

An unattended input request is not answered substantively. The provider
receives a refusal explaining that no user is available and that the model must
make and disclose its own assumption. The user-visible session transcript
records the bounded request and offered options so a reviewer can inspect what
was declined. Attempt summaries, logs, and metrics keep only bounded metadata
and counts, never full prompt or answer content.

## Scope

Included:

- Claude Native questions and plan approvals.
- OpenCode Native questions and permission requests.
- Codex Native approvals, user-input questions, MCP forms, and MCP URL
  elicitations.
- Claude tmux hook questions, plans, permissions, approvals, elicitations, and
  detected terminal-selection prompts.
- Ordinary interactive code-review sessions.
- Backend-owned build pipelines and looped reviews.
- Authoritative snapshots, revision-aware reconciliation, deadlines, restart
  recovery, global activity, privacy-safe diagnostics, and test coverage.

Excluded:

- Replacing a provider CLI's own UI inside raw xterm terminal tabs.
- Inventing substantive answers for unattended workflows.
- Auto-approving unexpected authorization requests.
- Flattening provider wire formats into a lossy common response format.
- Persisting plaintext answer drafts or secrets.
- Converting the feature planner's discovery conversation into a bounded
  question wizard; it remains a documented prose-based exception.

## Current problems

1. Codex questions use a second, less capable card and ignore their published
   deadline.
2. Claude tmux has an authoritative timeout that the UI does not show.
3. Interactive cards do not consistently expose stale, withdrawn, retryable,
   accessible, and secret-input behavior.
4. Build and review prompts say “do not ask,” but prompt text is not an
   execution policy.
5. Unattended provider behavior differs: immediate OpenCode rejection versus
   invisible Claude/Codex timeout waits.
6. Workflow status cannot consistently distinguish active computation from a
   request parked on input.
7. Looped-review phase advancement is still React-owned, so application exit
   stops progress even though ordinary tab unmount is tolerated.
8. Automated auto-declines or denials are not consistently visible in durable
   workflow history.

## Target architecture

```text
Provider / MCP server / tmux hook
                |
                | provider-specific request
                v
Bridge or backend provider adapter
  - retains exact upstream payload and response mapper
  - commits authoritative pending state and revision
  - exposes normalized, bounded presentation metadata
                |
                v
Persisted interaction policy evaluator
       |                              |
       | interactive                  | unattended
       v                              v
Authoritative pending snapshot   input: decline + continue + record
+ replayable live event          auth: deny + fail + record
       |
       v
Shared blocking-card shell
+ provider-specific body and exact response adapter
```

The normalized contract coordinates providers; it does not replace their
wire protocols. Exact provider identities, generations, values, and response
mappers remain behind the relevant adapter.

## Non-negotiable invariants

Every milestone preserves these rules:

1. Long-running workflow and pending-interaction authority lives in a backend,
   bridge, persistent store, provider, or external process—not only React.
2. Component unmount and inactive environments do not cancel requests or stop
   work.
3. Live events are incremental updates over authoritative snapshots.
4. Missed events are detectable through revision gaps, generation changes,
   expired cursors, or explicit reconciliation.
5. SSE replay subscribes before calculating and flushing the replay range; a
   connected frame echoes the client's cursor.
6. Every provider request is resolved exactly once.
7. Timeout, disconnect, malformed answer, stale request, abandoned session,
   and generation death deny or cancel; they never approve.
8. Dead-generation Codex requests are withdrawn locally and are never answered
   to a replacement child.
9. The Codex app-server stdout loop never awaits rendering, SSE writes,
   workflow polling, or policy work.
10. Unattended workflows never invent a user's answer and never approve an
    unexpected request.
11. Interaction queues, snapshots, option lists, answer payloads, free-text
    fields, retry state, and persisted records have explicit count and byte
    bounds.
12. Logs and metrics contain no prompt, answer, command, terminal, file,
    credential, token, URL, attachment, or secret content.
13. Secret answers never enter renderer draft stores or app-owned persistence.
14. Queued pipeline messages are follow-up prompts, never implicit answers to
    provider interactions.

## Delivery milestones

Complete milestones in order. A milestone may prepare a passive or
observe-only path used by the next one, but must not leave a partially enforced
policy enabled in production.

| Milestone | Outcome | Status |
| --- | --- | --- |
| [1](qa/milestone-1.md) | Contract, facts, bounds, policy, and failure-injection fixtures | Not started |
| [2](qa/milestone-2.md) | Consistent interactive cards, deadlines, answer fidelity, and secret handling | Not started |
| [3](qa/milestone-3.md) | Provider-neutral backend interaction capability and observe-only monitoring | Not started |
| [4](qa/milestone-4.md) | Uniform build-pipeline enforcement and durable visibility | Not started |
| [5](qa/milestone-5.md) | Backend-owned looped-review control with the same policy | Not started |
| [6](qa/milestone-6.md) | Recovery matrix, global activity, accessibility, diagnostics, and operational hardening | Not started |
| [7](qa/milestone-7.md) | Staged rollout, compatibility removal, and stable-policy declaration | Not started |

### Milestone 1 — Contract, facts, and fixtures

Define the normalized interaction and policy contract, bounds, persistence
versions, resolution journal, and workflow summary shapes. Pin down Claude's
actual `AskUserQuestion` behavior under `bypassPermissions` before choosing the
enforcement hook. Add provider fixtures that deliberately violate “do not ask”
instructions and capture the current invisible-wait baseline.

### Milestone 2 — Interactive consistency

Move Codex questions and MCP branches onto the shared blocking shell, publish
authoritative deadlines for tmux hooks, preserve provider response fidelity,
exclude secrets from shared drafts, and make stale/expired/retry/accessibility
behavior consistent. No automated-workflow behavior changes here.

### Milestone 3 — Provider-neutral capability

Give the backend a bounded, provider-neutral way to list, watch, reconcile, and
resolve pending interactions for Claude, OpenCode, and Codex. Persist session
origin and policy, survive bridge/provider restart, and run unattended
monitoring in observe-only mode before enforcement.

### Milestone 4 — Build-pipeline enforcement

Apply the consolidated policy to backend-owned build sessions. Questions and
elicitations decline immediately, continue, and leave a transcript record plus
attempt count. Unexpected approvals deny and fail the phase. The result is
visible without a mounted renderer and crash-consistent across detection,
provider response, and workflow recording.

### Milestone 5 — Backend-owned looped reviews

Move review phase advancement, provider polling, structured-result waiting,
and policy enforcement from React into a fenced backend service. React becomes
a snapshot-driven viewer/controller. Review work continues with its tab closed,
another environment active, or the renderer exited.

### Milestone 6 — Recovery and hardening

Complete the restart, inactive-environment, stale-response, exact-once,
viewport, and provider contract matrices. Add global “needs you” navigation,
privacy-safe counters, bounded malformed-response handling, operational
diagnostics, and optional platform notifications behind explicit user control.

### Milestone 7 — Rollout and cleanup

Version and migrate policies, remove OpenCode-only and React-owned compatibility
paths after recovery evidence is sufficient, document rollback, and declare
the policy stable only after a full release observes no invisible waits.

## Cross-cutting response rules

- IDs are opaque and never derived only from provider text.
- Option identity and submitted provider value remain distinct.
- `expiresAt` is absolute epoch milliseconds and comes from the timeout
  authority; a client does not invent a deadline when none is published.
- Only the authority declares a request terminal. UI `answering` state is
  optimistic and reversible through reconciliation.
- Stale responses are expected reconciliation outcomes, not generic failures.
- Closing an interactive live session answers or declines every live upstream
  request before releasing local state.
- Duplicate or ambiguous dispatch is reconciled from provider state and is not
  blindly retried.
- Interactive answer content may appear only where required by the provider's
  normal transcript or response contract. App metrics and operational logs
  record metadata only.

## Rollout strategy

1. Land contracts, persistence versions, bounds, fixtures, and passive metrics
   without behavior change.
2. Land interactive presentation changes and verify authoritative rehydration.
3. Enable provider-neutral unattended monitoring in observe-only mode.
4. Compare detections with provider status and timeout behavior.
5. Enable build-pipeline enforcement provider by provider for newly started
   phases; do not change policy mid-request.
6. Introduce the backend looped-review controller behind a persisted workflow
   version gate. Adopt only idle or paused legacy workflows automatically.
7. Complete restart and inactive-environment acceptance tests.
8. Remove compatibility paths after one release with no invisible-wait
   detections and no recovery regressions.

Rollback disables new automated dispatch while leaving denial fail-closed. It
must never convert a denied interaction into an approval or redispatch a prompt
whose acceptance is ambiguous.

## Required validation

Use Bun throughout. Run focused tests during each milestone and the complete
suite before declaring Milestone 7 complete.

```bash
bun test packages/protocol --parallel
bun test bridges --parallel
bun test tests --parallel
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
bun run --cwd apps/desktop typecheck
bun run test
```

Manual acceptance includes desktop web, Electron, iPhone `WKWebView`, and iPad
`WKWebView`. For every background path: start work in environment A, switch to
environment B, allow an interaction or workflow transition to occur, then
return and verify the authoritative status, history, deadline, and controls.

## Success measures

- No unattended input waits longer than one monitor interval plus provider
  response latency.
- No unexpected unattended approval or permission is approved.
- Every unattended auto-decline is visible in the transcript and counted in
  its workflow/attempt summary.
- Authorization prompts fail the phase promptly and visibly.
- No looped review requires a mounted renderer to advance.
- Every app-owned interactive request rehydrates after tab/environment switch,
  renderer remount, reconnect, and supported provider restart.
- Every visible deadline agrees with its authority.
- Every provider passes the same interaction adapter and unattended-policy
  contract suites.
- Metrics demonstrate the absence of invisible waits without collecting user
  content.
- Normal native chat question, approval, plan, permission, and elicitation
  flows do not regress.

## Definition of done

The plan is complete when all seven milestone exit criteria pass, the full Bun
suite and typechecks pass, rollout evidence is recorded, all automated sessions
have a persisted policy, looped reviews are backend-owned, provider-specific
compatibility paths are removed, and the final policy is documented in project
guidance.

## Decision log

| ID | Date | Decision | Source/resolution |
| --- | --- | --- | --- |
| D1 | 2026-07-31 | Unattended questions and elicitations decline immediately; the model states its assumption and continues; the event is durably visible and counted. | Preserves the explicit decision in `qa-claude.md`. |
| D2 | 2026-07-31 | Unexpected unattended approvals and permissions deny and fail the phase. | Preserves the stricter safety policy from `qa-plan-codex.md`; D1 never authorizes side effects. |
| D3 | 2026-07-31 | The common contract coordinates presentation and policy but retains exact provider payloads and response mappers behind adapters. | Shared by both source plans. |
| D4 | 2026-07-31 | Looped-review control moves to a fenced backend service. | Required by background reliability; no mounted React tree may own long-running progress. |
