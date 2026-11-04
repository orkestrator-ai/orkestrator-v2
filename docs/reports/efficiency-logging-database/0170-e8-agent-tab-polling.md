# E8: Agent tab polling

This file merges two reports of the same change into one: `0170` (GW-1, from the gateway section of the efficiency report) and `0410` (WEB-1, the client side of it).

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`. The discovery trace under task 2 was checked on 2026-11-04 at `a44641cbc`.

## Task analysis

### Tasks

1. **Capture the baseline**: measure requests and bytes per visible running agent tab before changing the round. Status: open.
2. **Take discovery out of the 500 ms round**: stop sending the discovery read on every background tick. Status: open (depends on 1).
3. **Add one combined read**: answer transcript and state in one request. Status: open (depends on 2).

### 1. Capture the baseline

**Problem.** The report measured nothing and the change is structural, so there is no before figure, and the maintainer gated this on numbers.

**Context.** Decided 2026-11-01 in [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 1: structural tasks need a baseline first, including task 4, which holds this finding.

**Investigation.** The instruments are listed in 1202 task 1 and the report's "Measuring before changing". The gateway metrics the report names exist, but nothing here was run.

**Decisions.** None: 1202 already fixes the method, an isolated `dev:test` profile run on the old and new commits.

### 2. Take discovery out of the 500 ms round

**Problem.** Each visible running tab sends three POSTs every 500 ms, and discovery changes least often of the three.

**Context.** Decided 2026-11-01 in 1202 task 4: take discovery out of the 500 ms round first, then add a combined read; choose push or long-poll only if measurements still justify it, and keep a recovery poll either way. Quiet backoff for idle views already covers all six providers (0052 task 2), so this is about running tabs.

**Investigation.** All three reads sit in one round in `apps/web/src/hooks/useNativeAgentSession.ts`: transcript at `:2276`, state at `:2415-2416` and discovery at `:2484-2485`. Discovery is not awaited (`:2497` awaits only the other two) but is still sent every tick. The cadence is 500 ms running and 1.5 s idle (`apps/web/src/lib/native-session-read-policy.ts:15-16`). The report's note that Claude and Codex never back off is out of date: they back off while the backend marks `turn.quietObservation` (`native-session-read-policy.ts:43-52`, `:87`). `retainedCommandFields` (`useNativeAgentSession.ts:579`) falls back to the held discovery view, so a slower read does not blank commands.

The backend already announces discovery changes, so no new event is needed. `discoveryAnnouncementKey` decides whether a change is worth announcing (`apps/backend/src/core/native-agent-transcript-projection.ts:3508`). The backend then calls `announceNativeAgentSessionProjection` with `discovery-deadline` or `discovery-renewal` (`:3609`, `:3638`), and the hook's `native-agent-session` listener calls `coordinatedInvalidate` (`useNativeAgentSession.ts:3026-3034`). Two limits follow from that path:

- A discovery refresh is only scheduled from the discovery read path (`scheduleProgressiveDiscovery`, called at `native-agent-transcript-projection.ts:3702`). With no read, nothing refreshes, so nothing is announced. The timed read is what detects a change.
- The listener does not look at why a session changed, so reading discovery on every invalidation could keep it on a running tab's fast path. An invalidation would need to name discovery first.

**Decisions.**

- **What triggers a discovery read?**
  - **Mount, a session or identity change, a manual refresh, resync, a phase change and an invalidation that names discovery, with a 30 s backstop that reuses its `knownToken` (recommended).**
    - Pros: covers both reports' lists; a new command or model still arrives; the backstop covers a missed hint and drives the refresh that produces announcements.
    - Cons: a catalogue change not announced waits up to 30 s, and the invalidation has to start naming discovery.
  - **Only events, with no backstop.**
    - Pros: fewest reads.
    - Cons: the maintainer asked for a recovery poll to stay, and with no read the backend would not refresh discovery, so a change would never be announced.

### 3. Add one combined read

**Problem.** After task 2, transcript and state still cost two requests per tick, each paying headers, auth and an HTTP/1.1 connection slot.

**Context.** The sequencing is decided (1202 task 4, above). Which form the combined read takes is not. Only `/invoke` exists for these reads (`apps/backend/src/gateway-auth.ts:471`).

**Investigation.** Each read already has a `knownToken` contract (`useNativeAgentSession.ts:2271-2272`, `:2410-2411`), so a combined command can reuse it. `apps/web/src/lib/native/web-gateway.ts:1363` is the single request path.

**Decisions.**

- **Where does the combined read live?**
  - **One new progressive-update command that answers transcript and state with their `knownToken`s (recommended).**
    - Pros: one request; reuses the existing token contract; an older backend is detected by the missing command.
    - Cons: a new protocol command that needs a version-compatibility entry.
  - **A generic bounded `/invoke-batch`.**
    - Pros: helps every caller.
    - Cons: new gateway surface with its own bounds, auth and error semantics.

## Constraints and rationale

- Decided 2026-11-01 (1202 tasks 1 and 4), as above: do not reopen these choices.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): missed events stay detectable, live events stay incremental over authoritative snapshots, and unmount is not cancel. Moving reads off timers must not make background work depend on a mounted view. A recovery poll stays, as decided.

## Needs verification

- Request counts per tab; the report's impact is reasoned, not measured.

## Related

- [Efficiency report, A](../2026-10-27-efficiency.md#a-gateway-and-transport) (GW-1), and WEB-1 in [section D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 tasks 1 and 4](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [0052 remote client bandwidth](../../todo/transcripts-and-observation/0052-remote-client-bandwidth.md)
- [E10 part 0180](0160-e10-conditional-reads-and-deltas.md#0180-session-state-reads-have-no-conditional-path-from-the-bridge): the backend's cost of each state read
