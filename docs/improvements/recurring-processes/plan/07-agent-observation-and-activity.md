# 07 — Share agent observations and schedule due activity groups

Status: Not started. Dependencies: 01, 02, 06; step 11 before reduced safety
polling. Findings: F05, F06.

## Outcome

Backend activity, prompt queue readiness, mail presence, workflow observation
and visible session reads reuse compatible observations without repeatedly
hydrating transcripts or touching idle sessions. Background turns and approvals
remain observable without a mounted renderer.

## Existing sources

`native-agent-service-reconciliation.ts`, `native-agent-service-provider.ts`,
`native-agent-service-projection.ts`, `http-bridge-provider.ts`,
`opencode-provider.ts`, `opencode-session-lifecycle.ts`, `agent-mail-service.ts`,
`tmux-poll.ts`, bridge activity routes, and `useNativeAgentSession.ts`.

The current native sweep already joins scans, groups by environment/provider,
uses eight workers and backs off failed groups. Extend these protections rather
than adding a competing observer alongside them.

## Implementation tasks

1. Build a provider capability matrix from current adapters: activity snapshot,
   transcript revision, pending interactions, turn transition notifications,
   background children, generation identity and no-touch behavior. Record
   unsupported surfaces explicitly. Do not assume an event from one provider
   has the same completeness on every provider.
2. Define a bounded observation record by backend/environment/provider/session
   generation: observation timestamp, activity, ready-for-input, pending
   interaction indicator, relevant revision and freshness. Do not retain a full
   transcript merely to share an activity answer.
3. Add compatible in-flight joining for cheap reads and a short freshness window
   justified by the baseline. A workflow needing a newer post-dispatch observation
   must be able to request it. Cached pre-dispatch idle can never advance a
   pipeline or drain another prompt.
4. Preserve `observeProvider` semantics: no start command, no attach/hydration,
   no liveness touch. A missing bridge differs from a failed probe; maintain
   existing conservative handling and absent-bridge cooldown. Do not replace
   `/activity` with a tab-facing `/status` route for convenience.
5. Track next-due provider groups. Running, cancelling, recovering, blocked and
   uncertain groups retain responsive observation; stable idle groups may back
   off only with a qualified wakeup path for externally started work. Provider
   generations and durable session mutations wake the appropriate group.
6. Feed one confirmed observation into environment activity, queue/mail readiness
   and completion handling. Preserve session-level completion while another
   session in the same environment remains active. Keep PR probes edge-triggered,
   not one probe per idle observation.
7. Coordinate mail presence's current four-second TTL with the new policy. Either
   preserve enough refresh for an authoritative presence lease, or represent
   stable/unknown/stale presence explicitly. Never let slower observation be
   interpreted as permission to inject into an active session.
8. Separate interaction-state freshness from optional transcript/discovery
   freshness. New questions, approvals, errors and ambiguous-dispatch controls
   must invalidate the critical view promptly. If a provider cannot supply these
   events, retain its bounded fallback reads.
9. Audit provider eviction/reconnect ownership. A failed observation must not
   abort a controller shared with prompt dispatch. Subscription replacement must
   dispose obsolete observers safely without leaving duplicates or killing a
   live turn. Retain the OpenCode rejected-cancel regression and fatal guard.
10. Expose generation-aware backend invalidations to the client coordinator.
    Before slowing native idle reads, qualify every supported provider and
    retain conservative fallback for older bridges. Do not change dispatch
    request IDs, retry journals or approval decisions as part of observation.

## Tests

Extend `native-agent-service-reconciliation.test.ts` and owning provider tests.
Prove observation never starts a bridge or hydrates/touches idle sessions; many
consumers join only compatible reads; stale idle cannot follow a new dispatch;
failed reads remain unknown/recovering; one completed session drains its queue
while another stays busy; PR discovery runs once per completion edge; externally
started work is eventually discovered; mail injection waits for trustworthy
readiness; and generation replacement fences all late results.

Include live provider coverage in isolated fixtures for missed final events,
parked approvals, background subagents, reconnect, idle detach/reattach and
hidden-client completion. For a provider whose events remain incomplete,
document and keep the fallback instead of claiming universal event-driven support.

## Acceptance and rollback

Duplicate provider reads drop measurably while activity/approval/completion
latency meets baseline budgets. Idle detach still occurs with backend monitoring
running. Zero-renderer workflows and queues continue. Rollback re-enables the
current observation cadence per provider, retaining generation fences and
authoritative snapshots; it must not create an extra concurrent subscription.
