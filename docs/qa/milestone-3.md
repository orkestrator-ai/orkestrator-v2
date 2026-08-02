# Milestone 3 — Provider-neutral interaction capability

Status: Implemented

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

- [x] Introduce a provider-neutral interface equivalent to:

  ```ts
  listPendingInteractions(sessionId): Promise<AgentInteractionRequest[]>;
  resolveInteraction(sessionId, interactionId, resolution):
    Promise<AgentInteractionApplyResult>;
  watchInteractions?(sessionId, onRevision): Unsubscribe;
  ```

- [x] Implement adapters from authoritative Claude, OpenCode, and Codex
      snapshots.
- [x] Retain exact provider response mappers and identities behind adapters.
- [x] Register persisted session origin and policy on create, resume, and adopt.
- [x] Reconcile at backend startup, bridge restart, provider reconnect, session
      adoption, workflow resume, revision gap, and generation change.
- [x] Subscribe before calculating recovery/replay work so no request can
      arrive in the gap.
- [x] Distinguish `running`, `blocked`, `idle`, and `error` provider states.
- [x] Treat a parked interactive prompt as `blocked`; do not report it as
      `idle` or overload it as a generic provider error.

## Safety and bounds checklist

- [x] Bound concurrent monitors globally and per environment.
- [x] Bound pending requests per session, snapshot bytes, response bytes,
      retries, and retry delay.
- [x] Keep policy evaluation and consumers off the Codex stdout read loop.
- [x] Preserve Codex generation checks and exact-once server-request answers.
- [x] Reuse provider idempotency only where the upstream contract proves it.
- [x] Reconcile before retrying ambiguous responses.
- [x] Remove UI state for requests absent from an authoritative snapshot.
- [x] Keep full request and answer content out of monitor logs and metrics.
- [x] Make monitor teardown follow logical session/workflow lifetime, not React
      component lifetime.

## Observe-only rollout checklist

- [x] Add a disabled-by-default observe-only mode for unattended sessions.
- [x] Detect and classify input versus authorization requests without applying
      a response.
- [x] Record only provider, kind, workflow surface, phase, timing, and count.
- [x] Compare detection timestamps with current provider status and eventual
      timeout/withdrawal behavior.
- [x] Prove detection continues with no visible tab and after renderer exit.
- [x] Add a kill switch that disables new monitor adoption without changing
      provider-side fail-closed timeout behavior.

## Provider adapter contract suite

Run the same cases against every provider:

- [x] No pending request.
- [x] One question and one authorization request.
- [x] Valid answer where interactive behavior supports it.
- [x] Deny/cancel.
- [x] Provider withdrawal and stale response.
- [x] Request missed by live events but recovered from snapshot.
- [x] Cross-session response rejection.
- [x] Timeout.
- [x] Provider restart or generation death.
- [x] Malformed/oversized provider payload.
- [x] Multiple simultaneous requests within and beyond bounds.
- [x] Concurrent resolution attempts produce exactly one upstream response.

## Required tests

- [x] Backend monitor continues while the renderer is absent.
- [x] A bridge restart rehydrates a live request or yields an explicit
      stale/abandoned outcome.
- [x] Session policy and origin survive backend restart and adoption.
- [x] No monitor callback can stall the Codex stdout loop.
- [x] Observe-only mode makes no provider response and changes no workflow
      result.
- [x] Metrics and logs contain no request content.

## Commands

```bash
bun test apps/backend/src/core/native-agent-service.test.ts --parallel
bun test apps/backend/src/core/build-pipeline-provider.test.ts --parallel
bun test bridges --parallel
bun run --cwd apps/backend typecheck
```

## Exit criteria

- [x] The backend enumerates and classifies pending interactions consistently
      for all providers.
- [x] Monitoring is backend-owned, bounded, revision-aware, and independent of
      visible UI.
- [x] Restart and stale-response behavior is explicit and exact-once.
- [x] Observe-only evidence matches the baseline and identifies current
      invisible waits without changing them.
- [x] Enforcement remains disabled until Milestone 4.

## Evidence and decisions

Record:

- final provider-neutral interface;
- per-provider mapping table and limitations;
- monitor bounds and retry policy;
- observe-only detections versus provider status/timeouts;
- restart and no-renderer test results;
- focused test and typecheck output.

### Evidence recorded 2026-08-01

- Final interface: every production `BuildPipelineProvider` exposes an
  `AgentInteractionProviderCapability` with authoritative
  `listPendingInteractions(sessionId)` snapshots and
  `resolveInteraction(sessionId, interactionId, resolution)` outcomes.
  Snapshots include a bounded revision so a consumer can reconcile a reset or
  gap. `watchInteractions` remains optional. The production adapters currently
  use full authoritative polling, so there is no subscribe-before-snapshot gap:
  a request arriving after one read is recovered by the next read.
- Provider mapping and limitations:

  | Provider | Input mapping | Authorization mapping | Resolution limitation |
  | --- | --- | --- | --- |
  | Claude | `AskUserQuestion` to `question`, retaining ordered option values | `ExitPlanMode` to `plan-approval` | Questions map back to the bridge's ordered `string[][]`; plan answers map to the exact boolean route. Ordinary tools remain governed by Claude's pinned `bypassPermissions` behavior. |
  | OpenCode | pending questions to `question` | pending permissions to `permission` | Answers preserve SDK label values; decline uses `question.reject`; permission answer/deny uses `once`/`reject`. No deadline is invented because OpenCode publishes none. |
  | Codex | user input and MCP requests to `question`, `mcp-form`, or `mcp-url` | command, file, and permission requests map to their distinct approval kinds | Question values and approval decisions map to their exact routes. MCP forms accept one bounded JSON-object answer and MCP URL elicitations accept or decline through the bridge's exact route. The bridge retains generation/thread/item identity and rejects dead-generation responses. |

- Bounds and retry policy: 64 pending requests per snapshot and 256 KiB per
  snapshot/response use the protocol limits; response bodies are stopped before
  buffering past that byte ceiling. Monitor evidence is capped at 64 aggregates
  and 512 live request identities; provider session tracking and monitor
  adoption are each capped at 1,024, while adapter request-identity maps are
  capped at 4,096. Monitoring defaults to four environments concurrently and
  one active read per environment, adopts at most eight sessions per
  environment, retries at most five exponential steps, and caps delay at 60
  seconds.
- Observe-only is disabled unless
  `ORKESTRATOR_AGENT_INTERACTION_OBSERVE_ONLY=1`. The operational kill switch is
  `ORKESTRATOR_AGENT_INTERACTION_MONITOR_KILL_SWITCH=1`; the backend command
  `set_agent_interaction_monitor_adoption` can also stop or resume new adoption.
  Existing adopted sessions keep reconciling. Evidence is available through
  `get_agent_interaction_observations` and contains only provider, kind,
  workflow surface, phase, timestamps, count, provider state, and eventual
  expired/withdrawn outcome.
- Deterministic observe-only tests detected one input and one authorization
  request with no renderer, applied no provider response, remained unaffected
  by a never-resolving telemetry callback, then classified their disappearance
  against the provider's idle state and authoritative expiry. Restart tests
  reloaded unattended origin/policy and rediscovered the pending request from
  the provider snapshot. Privacy tests forced request content into both a
  snapshot and an exception and proved neither evidence nor logs retained it.
- OpenCode's legacy unattended auto-response path emits a synchronous,
  content-free detection before replying, closing the gap in which a question
  or permission could disappear before the polling observer saw it. A question
  failure is saved to the pipeline before OpenCode is asked to reject the
  upstream request; if that save fails, the request remains pending. Bounded
  monitor leases rotate fairly at both the per-environment and global caps.
- Focused validation: protocol interaction/build-pipeline tests passed (72),
  provider adapter tests passed (150), native-agent service tests passed (147),
  build-pipeline/command/index focused tests passed (114), and the bridge suites
  passed (2,096 passed, 11 live tests skipped). Backend and protocol typechecks
  passed. Enforcement remains disabled until Milestone 4; the existing
  unattended OpenCode fail-closed behavior is preserved and now durable.
