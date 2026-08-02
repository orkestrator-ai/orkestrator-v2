# Milestone 4 — Uniform build-pipeline enforcement

Status: Implemented; manual verification pending

Depends on: Milestones 1 and 3

Unblocks: Milestone 5

## Outcome

Enforce one crash-consistent unattended policy for Claude, OpenCode, and Codex
build sessions. Input requests decline promptly and remain visible while the
run continues. Unexpected authorization requests deny and fail the phase.

## Scope

Primary files:

- `apps/backend/src/core/build-pipeline-provider.ts`
- `apps/backend/src/core/build-pipeline-service.ts`
- `apps/backend/src/core/native-agent-service.ts`
- `apps/backend/src/core/storage.ts`
- `packages/protocol/src/build-pipeline.ts`
- `apps/web/src/components/build-pipeline/BuildChatTab.tsx`
- `apps/web/src/components/build-pipeline/BuildCompletionStatus.tsx`
- Claude and Codex enforcement points in their bridges

## Session-policy checklist

- [x] Mark every newly created or adopted pipeline session `unattended` with
      workflow ID, phase, provider, and current pipeline generation/fence.
- [x] Do not change policy in the middle of a live provider request.
- [x] Keep “do not ask questions” prompt language as defense in depth.
- [x] Configure trusted phase privileges before dispatch rather than
      auto-approving mid-turn requests.
- [x] Prove ordinary native/review sessions still default to `interactive`.

## Input-request enforcement

For questions, MCP forms, MCP URLs, and other elicitations:

- [x] Claim the request in the persisted resolution journal before responding.
- [x] Decline/cancel immediately at the provider-safe enforcement point.
- [x] Tell the model that the session is non-interactive, no user can answer,
      and it must choose the safest likely assumption, state it, and continue.
- [x] For Claude, use the enforcement hook proven by Milestone 1; if
      `canUseTool` is bypassed, enforce through tool configuration and system
      guidance instead of assuming the callback runs.
- [x] For Codex, answer each live server request exactly once and keep policy
      work off the stdout loop.
- [x] For OpenCode, reject the question but stop treating successful rejection
      itself as a blocked/error session.
- [x] Record `auto-declined-headless` only after the provider response applies
      or authoritative reconciliation proves the request stale/resolved.
- [x] Continue the workflow without fabricating an answer.
- [x] If decline cannot be applied safely, fail the phase and reconcile rather
      than leave the provider parked.

## Authorization enforcement

For command, file, plan, privilege, and provider permission approvals:

- [x] Claim the request under the current pipeline fence.
- [x] Deny immediately using the provider's exact fail-closed response.
- [x] Never translate “no person is present” into approval-once or approval for
      the session.
- [x] Persist `interactive-request` failure after provider resolution or a
      proven stale outcome.
- [x] Stop the active phase and expose a safe retry path.
- [x] Remove OpenCode's current grant-once behavior for unexpected permissions;
      configure expected privileges up front instead.

## Crash-consistency checklist

- [x] Recover `claimed` records by reconciling provider state and responding
      only if the request is still live.
- [x] Recover `provider-resolved` input records by writing the durable
      auto-decline transcript/summary before continuing.
- [x] Recover `provider-resolved` authorization records by writing the durable
      workflow failure.
- [x] Clear terminal journal records only after the workflow/attempt snapshot
      containing the outcome is durable.
- [x] Fence adoption by pipeline generation/revision.
- [x] Do not redispatch a workflow prompt when its prior acceptance is
      ambiguous.
- [x] Converge concurrent monitors to one upstream response and one recorded
      workflow outcome.

## Visibility checklist

- [x] Add a distinct muted transcript entry for every auto-declined input; it
      is history, not an answerable blocking card.
- [x] Include provider, kind, bounded request text and offered options, phase,
      timestamp, and outcome in the user-visible transcript record so a
      reviewer can see exactly what was declined.
- [x] Never include secret form values or answers.
- [x] Add an auto-decline count to the attempt, ticket, and completion summary.
- [x] Surface authorization failures in the transcript header and
      `BuildCompletionStatus` with a retry action.
- [x] Ensure a queued user message remains a normal follow-up and cannot answer
      or rescue a provider request.
- [x] Add a warning-only stall watchdog when a running session has no
      transcript growth for twice the normal blocking timeout; do not
      automatically abort a legitimately long turn.

## Privacy and telemetry checklist

- [x] The session transcript may show the request content needed for review.
- [x] Attempt summaries persist only bounded metadata, safe headers, and counts.
- [x] Logs and metrics record provider, kind, phase, outcome, latency, and count
      only.
- [x] Do not record full questions, options, form fields, URLs, commands, file
      paths, or answers in metrics or operational logs.

## Required tests

For every provider:

- [x] Forced question declines within one monitor interval and the phase
      continues.
- [x] Transcript entry and attempt count are exactly one.
- [x] Three questions produce count three; no question produces zero.
- [x] Unexpected approval/permission denies and fails the phase.
- [x] Provider response failure fails safely without an invisible wait.
- [x] Interactive sessions still park and accept a human response.
- [x] Queued messages are never consumed as answers.
- [x] Backend restart at `claimed`, `provider-resolved`, and workflow-recording
      boundaries converges correctly.
- [x] Bridge/provider restart during resolution remains exact-once.
- [x] Retry does not blindly redispatch an ambiguously accepted prompt.
- [x] Renderer absence and inactive environment do not affect enforcement.

## Manual verification

- [ ] Start a pipeline in environment A and switch to B.
- [ ] Force an input request; verify A does not wait five/ten minutes, the run
      continues, and its summary records the auto-decline.
- [ ] Force an authorization request; verify the phase fails without returning
      to A.
- [ ] Close and reopen the renderer; verify both outcomes remain visible.
- [ ] Retry an authorization failure and verify a fresh/reconciled attempt.

## Commands

```bash
bun test apps/backend/src/core/build-pipeline-provider.test.ts --parallel
bun test apps/backend/src/core/build-pipeline-service.test.ts --parallel
bun test apps/backend/src/core/build-pipeline-service-recovery.test.ts --parallel
bun test apps/web/src/components/build-pipeline --parallel
bun test bridges --parallel
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
```

## Exit criteria

- [x] No provider input request stalls a pipeline until its ordinary timeout.
- [x] Input requests decline, continue, and are durably visible/countable.
- [x] Unexpected authorization requests deny and fail promptly.
- [x] Crash/restart tests converge to one provider response and one workflow
      outcome.
- [x] No pipeline result depends on a mounted renderer or queued-message hack.
- [x] Provider-specific paths have equivalent product behavior.

## Evidence and decisions

Record:

- per-provider enforcement point and exact response mapping;
- detection-to-resolution latency;
- crash-injection state transition results;
- transcript and summary screenshots;
- confirmation that metrics contain metadata only;
- focused test and typecheck output.

### Evidence recorded 2026-08-02

- Enforcement is backend-owned and provider-neutral. A stage session is
  registered once with `origin: build-pipeline`, the unattended policy,
  workflow ID, phase, provider, and a stable per-stage session-key fence.
  Initial, resumed, and redispatched prompts all include the non-interactive
  assumption-and-continue instruction. Existing interactive registrations are
  not overwritten while a provider request is live.
- Exact response mapping remains provider-specific behind the shared resolver:
  Claude questions use the bridge question DELETE and plan authorization uses
  `{ approved: false }`; OpenCode questions use `question.reject` and
  permissions use `permission.reply({ reply: "reject" })`; Codex inputs map to
  `decline`, approvals map to `deny`, and the app-server router answers each
  parked server request exactly once without awaiting workflow work on stdout.
  The old OpenCode event-loop grant-once path is disabled for build pipelines.
- The persisted resolution journal transitions `claimed` →
  `provider-resolved` → `workflow-recorded`. A stage session key fences every
  claim. Provider absence reconciles an ambiguous response without a second
  dispatch. The workflow snapshot is saved before the final journal transition,
  and startup closes that last crash window from the durable transcript or
  `interactive-request` failure.
- Crash-injection tests cover a restored `claimed` input, provider-resolved
  input and authorization records, and a crash after workflow persistence but
  before the final journal write. They converge to one upstream response, one
  record per interaction, a continuing input phase, and a terminal
  authorization phase. The existing adapter/bridge suites cover concurrent
  resolution, stale generations, ambiguous writes, and provider restart.
- Input transcript records retain only bounded review presentation: title,
  body, question text, and option labels. Provider values and answers are never
  copied. Authorization presentation is replaced by a safe generic header, so
  commands and paths do not enter pipeline persistence. Operational logs contain
  only provider, kind, phase, outcome, latency, and count.
- The build UI rehydrates these records from backend snapshots, renders a muted
  history entry with provider/kind/phase/timestamp/outcome, shows stage and
  completion counts, warns after ten minutes of transcript silence without
  aborting, and presents authorization/provider-resolution failures with a
  retry that starts a fresh stage session. Queued user messages remain ordinary
  durable follow-ups and are never consumed as interaction answers.
- Focused validation passed: provider adapters 153; build pipeline service and
  recovery 79; build UI 100; protocol build-pipeline 36; bridges 2,096 with 11
  live tests skipped. Backend and web TypeScript checks passed. Live
  cross-environment and renderer-restart verification remains pending below.
