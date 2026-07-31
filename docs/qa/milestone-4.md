# Milestone 4 — Uniform build-pipeline enforcement

Status: Not started

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

- [ ] Mark every newly created or adopted pipeline session `unattended` with
      workflow ID, phase, provider, and current pipeline generation/fence.
- [ ] Do not change policy in the middle of a live provider request.
- [ ] Keep “do not ask questions” prompt language as defense in depth.
- [ ] Configure trusted phase privileges before dispatch rather than
      auto-approving mid-turn requests.
- [ ] Prove ordinary native/review sessions still default to `interactive`.

## Input-request enforcement

For questions, MCP forms, MCP URLs, and other elicitations:

- [ ] Claim the request in the persisted resolution journal before responding.
- [ ] Decline/cancel immediately at the provider-safe enforcement point.
- [ ] Tell the model that the session is non-interactive, no user can answer,
      and it must choose the safest likely assumption, state it, and continue.
- [ ] For Claude, use the enforcement hook proven by Milestone 1; if
      `canUseTool` is bypassed, enforce through tool configuration and system
      guidance instead of assuming the callback runs.
- [ ] For Codex, answer each live server request exactly once and keep policy
      work off the stdout loop.
- [ ] For OpenCode, reject the question but stop treating successful rejection
      itself as a blocked/error session.
- [ ] Record `auto-declined-headless` only after the provider response applies
      or authoritative reconciliation proves the request stale/resolved.
- [ ] Continue the workflow without fabricating an answer.
- [ ] If decline cannot be applied safely, fail the phase and reconcile rather
      than leave the provider parked.

## Authorization enforcement

For command, file, plan, privilege, and provider permission approvals:

- [ ] Claim the request under the current pipeline fence.
- [ ] Deny immediately using the provider's exact fail-closed response.
- [ ] Never translate “no person is present” into approval-once or approval for
      the session.
- [ ] Persist `interactive-request` failure after provider resolution or a
      proven stale outcome.
- [ ] Stop the active phase and expose a safe retry path.
- [ ] Remove OpenCode's current grant-once behavior for unexpected permissions;
      configure expected privileges up front instead.

## Crash-consistency checklist

- [ ] Recover `claimed` records by reconciling provider state and responding
      only if the request is still live.
- [ ] Recover `provider-resolved` input records by writing the durable
      auto-decline transcript/summary before continuing.
- [ ] Recover `provider-resolved` authorization records by writing the durable
      workflow failure.
- [ ] Clear terminal journal records only after the workflow/attempt snapshot
      containing the outcome is durable.
- [ ] Fence adoption by pipeline generation/revision.
- [ ] Do not redispatch a workflow prompt when its prior acceptance is
      ambiguous.
- [ ] Converge concurrent monitors to one upstream response and one recorded
      workflow outcome.

## Visibility checklist

- [ ] Add a distinct muted transcript entry for every auto-declined input; it
      is history, not an answerable blocking card.
- [ ] Include provider, kind, bounded request text and offered options, phase,
      timestamp, and outcome in the user-visible transcript record so a
      reviewer can see exactly what was declined.
- [ ] Never include secret form values or answers.
- [ ] Add an auto-decline count to the attempt, ticket, and completion summary.
- [ ] Surface authorization failures in the transcript header and
      `BuildCompletionStatus` with a retry action.
- [ ] Ensure a queued user message remains a normal follow-up and cannot answer
      or rescue a provider request.
- [ ] Add a warning-only stall watchdog when a running session has no
      transcript growth for twice the normal blocking timeout; do not
      automatically abort a legitimately long turn.

## Privacy and telemetry checklist

- [ ] The session transcript may show the request content needed for review.
- [ ] Attempt summaries persist only bounded metadata, safe headers, and counts.
- [ ] Logs and metrics record provider, kind, phase, outcome, latency, and count
      only.
- [ ] Do not record full questions, options, form fields, URLs, commands, file
      paths, or answers in metrics or operational logs.

## Required tests

For every provider:

- [ ] Forced question declines within one monitor interval and the phase
      continues.
- [ ] Transcript entry and attempt count are exactly one.
- [ ] Three questions produce count three; no question produces zero.
- [ ] Unexpected approval/permission denies and fails the phase.
- [ ] Provider response failure fails safely without an invisible wait.
- [ ] Interactive sessions still park and accept a human response.
- [ ] Queued messages are never consumed as answers.
- [ ] Backend restart at `claimed`, `provider-resolved`, and workflow-recording
      boundaries converges correctly.
- [ ] Bridge/provider restart during resolution remains exact-once.
- [ ] Retry does not blindly redispatch an ambiguously accepted prompt.
- [ ] Renderer absence and inactive environment do not affect enforcement.

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

- [ ] No provider input request stalls a pipeline until its ordinary timeout.
- [ ] Input requests decline, continue, and are durably visible/countable.
- [ ] Unexpected authorization requests deny and fail promptly.
- [ ] Crash/restart tests converge to one provider response and one workflow
      outcome.
- [ ] No pipeline result depends on a mounted renderer or queued-message hack.
- [ ] Provider-specific paths have equivalent product behavior.

## Evidence and decisions

Record:

- per-provider enforcement point and exact response mapping;
- detection-to-resolution latency;
- crash-injection state transition results;
- transcript and summary screenshots;
- confirmation that metrics contain metadata only;
- focused test and typecheck output.

No evidence recorded yet.
