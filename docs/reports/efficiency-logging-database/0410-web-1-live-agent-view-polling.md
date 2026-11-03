# Live agent views poll transcript, state and discovery together

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Capture the baseline**: count requests per visible running tab before changing the round. Status: open.
2. **Take discovery out of the 500 ms round**: stop sending the discovery read on every background tick. Status: open (depends on 1).
3. **Combined read**: one request for transcript and state. Status: open (depends on 2).

### 1. Capture the baseline

**Problem.** The change is structural, and there is no before figure.

**Context.** Decided 2026-11-01 in [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 1: structural tasks need a baseline first.

**Investigation.** The gateway metrics the report names exist, but nothing here was run.

**Decisions.** None: 1202 already fixes the method, an isolated `dev:test` profile run on the old and new commits.

### 2. Take discovery out of the 500 ms round

**Problem.** Each visible running tab sends three POSTs every 500 ms, and discovery changes least often of the three.

**Context.** Decided 2026-11-01 in 1202 task 4: take discovery out of the 500 ms round, then add a combined read; choose push or long-poll only if measurements still justify it, and keep a recovery poll either way.

**Investigation.** All three reads sit in one round in `apps/web/src/hooks/useNativeAgentSession.ts`: transcript at `:2276`, state at `:2415` and discovery at `:2484`. Discovery is not awaited (`:2497` awaits only the other two) but is still sent every tick. The cadence is 500 ms running and 1.5 s idle (`apps/web/src/lib/native-session-read-policy.ts:15-16`). The report's note that Claude and Codex never back off is out of date: they back off while the backend marks `turn.quietObservation` (`native-session-read-policy.ts:43-52`, `:87`). This finding is the client side of GW-1, in section A of the report.

**Decisions.**

- **When should discovery be read?**
  - **On a manual refresh, on a session or identity change and on a slow timer, reusing its `knownToken` (recommended).**
    - Pros: a new command or model still arrives; the slow timer covers a missed change.
    - Cons: a catalogue change can take as long as the timer to appear.
  - **Only when an event announces a change.**
    - Pros: no periodic discovery reads.
    - Cons: needs a new discovery event, and a missed one leaves the list stale.

### 3. Combined read

**Problem.** Transcript and state still cost two requests per tick after task 2.

**Context.** The Decided sequencing above applies. Which form the combined read takes is not decided.

**Investigation.** Only `/invoke` exists for these reads (1202 task 4). The tokens in `useNativeAgentSession.ts:2271-2272` and `:2410-2411` are the contract a combined read would carry.

**Decisions.**

- **Where does the combined read live?**
  - **One new progressive-update command that answers transcript and state with their `knownToken`s (recommended).**
    - Pros: one request; reuses the existing token contract; older backends are detected by the missing command.
    - Cons: a new protocol command that needs a version-compatibility entry.
  - **A generic bounded `/invoke-batch`.**
    - Pros: helps every caller.
    - Cons: new gateway surface with its own bounds, auth and error semantics.

## Constraints and rationale

The report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) on incremental live events over authoritative snapshots and on "unmount is not cancel" name this finding directly. A recovery poll stays, as decided.

## Needs verification

- Request counts per tab; the report's impact is reasoned, not measured.

## Related

- [Efficiency report, D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), tasks 1 and 4
- [0052 remote client bandwidth](../../todo/transcripts-and-observation/0052-remote-client-bandwidth.md)
