# Milestone 6 — Recovery, activity, accessibility, and diagnostics

Status: Not started

Depends on: Milestones 2, 4, and 5

Unblocks: Milestone 7

## Outcome

Prove the complete interaction system under inactive environments, reconnects,
provider/backend restarts, stale responses, narrow viewports, and concurrent
resolution. Add useful global navigation and privacy-safe operational evidence
without making UI state authoritative.

## Scope

Primary files:

- `apps/web/src/hooks/useGlobalActivityMonitor.ts`
- `apps/web/src/App.tsx`
- `packages/protocol/src/agent-activity.ts`
- provider bridge metrics modules
- backend pipeline and looped-review metrics
- interaction, activity, end-to-end, and recovery tests
- relevant operational documentation

## Global activity checklist

- [ ] Extend activity snapshots with a provider-neutral waiting reason for
      interactive requests.
- [ ] Preserve amber waiting precedence over blue working.
- [ ] Add a global “needs you” count derived from authoritative store snapshots.
- [ ] Let the user jump to the next blocked environment/request.
- [ ] Remove count entries immediately after authoritative terminal resolution.
- [ ] Show unattended authorization failures as actionable failures, not amber
      requests nobody can answer.
- [ ] Keep unattended auto-declines as history/counts, not pending activity.
- [ ] Add an optional Electron notification when an interactive request arrives
      while the app is unfocused, behind explicit user control.
- [ ] Treat iOS badge/push support as a separately gated platform deliverable;
      it must consume authoritative gateway state and must not become request
      authority.

## Diagnostics and bounds checklist

- [ ] Add counters for interactions presented by provider, kind, and surface.
- [ ] Add outcomes for answered, denied, auto-declined, expired, abandoned,
      cancelled, and stale.
- [ ] Add unattended detection-to-resolution/failure latency.
- [ ] Add revision-gap, reconciliation, and restart-recovery counts.
- [ ] Add recovered-after-renderer/bridge/backend-restart counts.
- [ ] Add bounded rate limiting for malformed or repeated response attempts.
- [ ] Prove retries, events, snapshots, journal records, and failure summaries
      stay within count/byte limits.
- [ ] Never log request titles/descriptions unless explicitly classified as a
      bounded safe header; never log questions, options, answers, commands,
      file paths, URLs, forms, terminal content, secrets, tokens, or attachments.
- [ ] Add an operational runbook for investigating an unexpected interactive
      request or a warning-only stall watchdog event.

## Provider contract matrix

For Claude, OpenCode, and Codex:

- [ ] List empty and non-empty snapshots.
- [ ] Answer, decline/cancel, and deny supported kinds.
- [ ] Withdraw before response and return a stale result.
- [ ] Miss a live event and recover from the snapshot.
- [ ] Disconnect SSE and reconcile on reconnect.
- [ ] Restart bridge/provider and rehydrate or abandon explicitly.
- [ ] Reject cross-session and malformed responses.
- [ ] Time out under authority.
- [ ] Resolve exactly once under concurrent attempts.
- [ ] Enforce pending-count and byte bounds.

## Interactive acceptance matrix

For Claude Native, OpenCode Native, Codex Native, and Claude tmux:

- [ ] Single choice, multi-choice, custom input, and free text where supported.
- [ ] Required-field validation.
- [ ] Submit, dismiss/deny, retryable error, stale, expiry, withdrawal, and
      provider generation loss.
- [ ] Countdown agreement with authority.
- [ ] Environment switch before request arrival.
- [ ] Tab unmount/remount while pending.
- [ ] Renderer restart restores request but not plaintext draft.
- [ ] Non-secret draft survives ordinary unmount and clears after resolution.
- [ ] Secret answer never enters shared state.
- [ ] Global waiting count and jump navigation.
- [ ] Keyboard navigation, screen-reader announcement, and focus restoration.
- [ ] Mobile/narrow layout at 390×844 with software keyboard open.

Add tmux coverage for questions, plans, permissions, approvals, elicitations,
and screen-detected terminal selections.

## Automated-workflow acceptance matrix

For each provider and representative build/review phase:

- [ ] Force an input request despite prompt guidance.
- [ ] Verify immediate decline, continuation, durable history, and count.
- [ ] Force an unexpected authorization request.
- [ ] Verify immediate denial and `interactive-request` failure.
- [ ] Restart renderer while the request arrives.
- [ ] Restart backend between claim, provider response, and workflow record.
- [ ] Restart bridge/provider during resolution.
- [ ] Retry the failed phase safely.
- [ ] Verify queued messages are not answers.
- [ ] Verify normal configured privileges do not prompt on the success path.
- [ ] Prove no visible pipeline/review tab is required.

## Inactive-environment acceptance procedure

For each interactive provider:

1. Start a turn in environment A.
2. Switch to environment B before the request arrives.
3. Let the provider issue an interaction.
4. Verify A becomes globally waiting.
5. Return to A and verify the authoritative card, deadline, draft, and controls.
6. Answer once and prove it cannot be answered again.

For automated workflows, repeat steps 1–3 and verify the correct policy outcome
without returning to A.

## Required tests and commands

```bash
bun test packages/protocol --parallel
bun test bridges --parallel
bun test tests --parallel
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
bun run --cwd apps/desktop typecheck
bun run test
```

## Manual verification

- [ ] Electron desktop inactive/focus/notification behavior.
- [ ] Desktop remote browser reconnect and environment switching.
- [ ] iPhone `WKWebView` narrow layout, keyboard, background, and foreground.
- [ ] iPad `WKWebView` layout and foreground recovery.
- [ ] Backend restart during build and looped-review interactions.
- [ ] Provider/bridge restart during an interactive answer and unattended
      policy response.
- [ ] Operational runbook can diagnose injected cases without inspecting user
      content.

## Exit criteria

- [ ] Every matrix case has automated coverage or explicitly recorded manual
      evidence with an owner for remaining automation.
- [ ] Interactive waiting is globally visible and navigable while inactive.
- [ ] Automated outcomes remain visible without an answerable card.
- [ ] Metrics demonstrate zero invisible waits and contain no user content.
- [ ] Malformed/repeated attempts remain bounded.
- [ ] Full Bun tests and all three typechecks pass.

## Evidence and decisions

Record:

- completed provider/surface/restart matrix;
- device and viewport results;
- notification/badge scope decision;
- representative privacy-safe metric output;
- rate-limit and bound tests;
- full suite and typecheck output.

No evidence recorded yet.
