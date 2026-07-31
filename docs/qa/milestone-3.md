# Milestone 3 — Provider-neutral interaction capability

Status: Not started

Depends on: Milestone 1

Unblocks: Milestones 4 and 5

## Outcome

Give the standalone backend one bounded capability to enumerate, watch,
reconcile, and resolve interactions for Claude, OpenCode, and Codex,
independent of any mounted renderer. Run unattended detection in observe-only
mode before enabling enforcement.

## Scope

Primary files:

- `apps/backend/src/core/build-pipeline-provider.ts`
- `apps/backend/src/core/native-agent-service.ts`
- `apps/backend/src/core/commands.ts`
- `apps/backend/src/core/storage.ts`
- `bridges/claude-bridge/src/routes/session.ts`
- `bridges/codex-bridge/src/index.ts`
- provider client wrappers and bridge snapshots

## Capability checklist

- [ ] Introduce a provider-neutral interface equivalent to:

  ```ts
  listPendingInteractions(sessionId): Promise<AgentInteractionRequest[]>;
  resolveInteraction(sessionId, interactionId, resolution):
    Promise<AgentInteractionApplyResult>;
  watchInteractions?(sessionId, onRevision): Unsubscribe;
  ```

- [ ] Implement adapters from authoritative Claude, OpenCode, and Codex
      snapshots.
- [ ] Retain exact provider response mappers and identities behind adapters.
- [ ] Register persisted session origin and policy on create, resume, and adopt.
- [ ] Reconcile at backend startup, bridge restart, provider reconnect, session
      adoption, workflow resume, revision gap, and generation change.
- [ ] Subscribe before calculating recovery/replay work so no request can
      arrive in the gap.
- [ ] Distinguish `running`, `blocked`, `idle`, and `error` provider states.
- [ ] Treat a parked interactive prompt as `blocked`; do not report it as
      `idle` or overload it as a generic provider error.

## Safety and bounds checklist

- [ ] Bound concurrent monitors globally and per environment.
- [ ] Bound pending requests per session, snapshot bytes, response bytes,
      retries, and retry delay.
- [ ] Keep policy evaluation and consumers off the Codex stdout read loop.
- [ ] Preserve Codex generation checks and exact-once server-request answers.
- [ ] Reuse provider idempotency only where the upstream contract proves it.
- [ ] Reconcile before retrying ambiguous responses.
- [ ] Remove UI state for requests absent from an authoritative snapshot.
- [ ] Keep full request and answer content out of monitor logs and metrics.
- [ ] Make monitor teardown follow logical session/workflow lifetime, not React
      component lifetime.

## Observe-only rollout checklist

- [ ] Add a disabled-by-default observe-only mode for unattended sessions.
- [ ] Detect and classify input versus authorization requests without applying
      a response.
- [ ] Record only provider, kind, workflow surface, phase, timing, and count.
- [ ] Compare detection timestamps with current provider status and eventual
      timeout/withdrawal behavior.
- [ ] Prove detection continues with no visible tab and after renderer exit.
- [ ] Add a kill switch that disables new monitor adoption without changing
      provider-side fail-closed timeout behavior.

## Provider adapter contract suite

Run the same cases against every provider:

- [ ] No pending request.
- [ ] One question and one authorization request.
- [ ] Valid answer where interactive behavior supports it.
- [ ] Deny/cancel.
- [ ] Provider withdrawal and stale response.
- [ ] Request missed by live events but recovered from snapshot.
- [ ] Cross-session response rejection.
- [ ] Timeout.
- [ ] Provider restart or generation death.
- [ ] Malformed/oversized provider payload.
- [ ] Multiple simultaneous requests within and beyond bounds.
- [ ] Concurrent resolution attempts produce exactly one upstream response.

## Required tests

- [ ] Backend monitor continues while the renderer is absent.
- [ ] A bridge restart rehydrates a live request or yields an explicit
      stale/abandoned outcome.
- [ ] Session policy and origin survive backend restart and adoption.
- [ ] No monitor callback can stall the Codex stdout loop.
- [ ] Observe-only mode makes no provider response and changes no workflow
      result.
- [ ] Metrics and logs contain no request content.

## Commands

```bash
bun test apps/backend/src/core/native-agent-service.test.ts --parallel
bun test apps/backend/src/core/build-pipeline-provider.test.ts --parallel
bun test bridges --parallel
bun run --cwd apps/backend typecheck
```

## Exit criteria

- [ ] The backend enumerates and classifies pending interactions consistently
      for all providers.
- [ ] Monitoring is backend-owned, bounded, revision-aware, and independent of
      visible UI.
- [ ] Restart and stale-response behavior is explicit and exact-once.
- [ ] Observe-only evidence matches the baseline and identifies current
      invisible waits without changing them.
- [ ] Enforcement remains disabled until Milestone 4.

## Evidence and decisions

Record:

- final provider-neutral interface;
- per-provider mapping table and limitations;
- monitor bounds and retry policy;
- observe-only detections versus provider status/timeouts;
- restart and no-renderer test results;
- focused test and typecheck output.

No evidence recorded yet.
