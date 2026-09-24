# 10 — Tighten lifecycle timers and transport retry policy

Status: Not started. Dependencies: 01, 02. Finding: F09; inventory L01–L14.

## Outcome

Every long-lived owner can dispose its timers and observers completely, outages
do not produce synchronized retry storms, and protocol/safety timers preserve
their original guarantees. Optimize measured hotspots selectively.

## Cursor and Pi lifecycle

Targets: `bridges/cursor-bridge/src/server.ts`, `bridges/pi-bridge/src/server.ts`
and `packages/protocol/src/parent-watchdog.ts`.

1. Retain idle-sweep and parent-watch stop handles in the server lifecycle owner.
   Clear them before awaiting shutdown disposal. Make start behavior explicit:
   idempotent while started, or reject repeated start before installing anything.
   Do not promise restart of module-global closed state without implementing it.
2. Reuse the common parent-watchdog implementation where its semantics fit,
   preserving the current five-second check requirement rather than accidentally
   inheriting its fifteen-second default.
3. Coalesce per-session detach work and capture generation. A new prompt or
   interaction appearing while detachment is pending must prevent unsafe cleanup.
   Preserve Pi's blocked/compacting/dispatching protection and Cursor's running
   background-child protection.
4. Catch timer callbacks and shutdown rejections. Keep fatal rejection guards as
   the last line of defense, not as expected error handling. Deny/withdraw
   approvals under each bridge's existing contract before dropping ownership.

Tests: explicit shutdown without process exit leaves zero lifecycle timers;
repeated start cannot duplicate work; late callbacks do nothing; parent death
triggers one shutdown; active/blocked/newly-dispatched sessions do not detach;
idle sessions do detach and later reattach to existing history.

## ACP disconnect fallback

Target: `bridges/acp-bridge/src/acp-server.ts` and owning HTTP tests.

1. Establish why the 50 ms per-request fallback exists using tests/history and
   supported runtime behavior. Count concurrent long requests and callback cost.
2. Exercise request abort, peer half-close, full socket close, proxy disconnect,
   response close, keep-alive reuse and already-destroyed sockets. Use real
   sockets as well as unit seams; event assumptions are the behavior under test.
3. If events cover all supported cases, remove periodic fallback or restrict it
   to the documented exceptional operation. Otherwise consolidate one bounded
   server-level sweep over active cancellable requests at a justified cadence.
4. Preserve read cancellation without cancelling a user turn simply because its
   view disappeared. Remove listeners/registrations on both success and failure.

Acceptance: equivalent cancellation latency and no orphaned request work, with
measured reduction in periodic callbacks. Keep the old bounded fallback if proof
is insufficient; document that as an intentional deferral.

## Reconnect policy

Targets: `opencode-provider.ts`, web gateway, terminal WebSocket client, native
chat stores and bridge process-supervisor retry paths.

1. Inventory existing retry owner, reset condition, cap and cancellation for
   each transport. Share a pure backoff/jitter policy where useful, not transport
   state or dispatch retry decisions.
2. Trial exponential capped jitter for repeated read/stream reconnect failures.
   Keep initial reconnect responsive; reset after a meaningful healthy period,
   not merely after a connection that immediately closes. Limit one reconnect
   timer per owner and bound pending subscriptions/channels.
3. Preserve replay cursor/generation, subscribe-before-replay, connected-frame
   cursor echo and explicit reconciliation on expiry/gap. Recovery of a stream
   never automatically resubmits an ambiguous prompt or approves an interaction.
4. Audit every abort consumer for owned rejection handling, including
   `reader.cancel()`. Preserve the existing real-client OpenCode disposal test.
   Do not wrap transport operations in a scheduler that blocks the Codex stdout
   read loop on rendering, SSE writes or browser work.

## Heartbeats, maintenance and batching

Keep gateway's 25-second heartbeat/cursor advancement, Claude's 30-second
heartbeat and Codex's current active/idle protocol behavior until transport
measurement supports any change. A shared clock per owning process is optional;
there is no reason for an IPC scheduling service across bridges.

Retain coarse Codex/Claude transcript cleanup, one-minute Cursor/Pi idle sweeps,
and six-hour log retention unless their measured cost warrants a due-index.
Keep storage/controller/test/toolchain lock heartbeats and approval/auth expiry
independent of soft-work pools. The validation worker's 500 ms persistence can
be split into liveness versus changed-result writes only with cross-process
crash-recovery and cancellation proof; do not simply slow its heartbeat.

Preserve PTY/terminal-history/message/persistence flush bounds and maximum
latency. Data-triggered debounce and bounded readiness loops are intentionally
outside broad recurring-timer conversion. iOS's bounded web readiness check
remains a startup concern; test it if shared client readiness semantics change.

## Rollback

Keep lifecycle disposal improvements even when retry cadence experiments revert.
Revert each transport's policy independently and confirm one active driver.
Any heartbeat/replay regression blocks rollout; restore the known transport
policy before proceeding with unrelated efficiency changes.
