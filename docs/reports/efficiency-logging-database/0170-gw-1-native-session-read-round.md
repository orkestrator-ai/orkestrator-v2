# Native session views send three requests per tick and there is no combined read

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Capture the baseline**: measure requests and bytes per visible agent tab before changing the round. Status: open.
2. **Take discovery out of the fast round**: read it on mount, resync, invalidation and phase change, or at most every 30 s. Status: open (depends on 1).
3. **Add one combined read**: answer transcript and state in one request. Status: open (depends on 2).

### 1. Capture the baseline

**Problem.** The report measured nothing, and the maintainer gated this on numbers.

**Context.** Decided 2026-11-01 in 1202 task 1: task 4, which holds this finding, needs a baseline first.

**Investigation.** The instruments are listed in 1202 task 1 and the report's "Measuring before changing".

**Decisions.** None: the decision was made in 1202.

### 2. Take discovery out of the fast round

**Problem.** Each running tab sends a discovery POST every 500 ms, and discovery almost never changes.

**Context.** Decided 2026-11-01 (1202 task 4): discovery comes out first. Quiet backoff for idle views already covers all six providers (0052 task 2), so this is about running tabs.

**Investigation.** The three reads are in one function of `apps/web/src/hooks/useNativeAgentSession.ts`: transcript (`:2276`), session state (`:2415-2416`) and discovery (`:2484-2485`). The cadences are `apps/web/src/lib/native-session-read-policy.ts:15-16`. The backend already announces discovery changes (`discoveryAnnouncementKey` in `apps/backend/src/core/native-agent-transcript-projection.ts:3508`), which gives an invalidation to read on. `retainedCommandFields` (`useNativeAgentSession.ts:579`) falls back to the held discovery view, so a slower read does not blank commands.

**Decisions.**

- **What triggers a discovery read?**
  - **Mount, resync, invalidation and phase change, with a 30 s backstop (recommended).**
    - Pros: the report's list; the backstop covers a missed hint.
    - Cons: a catalogue change not announced waits up to 30 s.
  - **Only events, with no backstop.**
    - Pros: fewest reads.
    - Cons: the maintainer asked for a recovery poll to stay.

### 3. Add one combined read

**Problem.** Transcript and state still cost two requests per tick, each paying headers, auth and an HTTP/1.1 connection slot.

**Context.** Decided 2026-11-01 (1202 task 4): add a combined read after discovery; choose push or long-poll only if measurements still justify it, and keep a recovery poll either way. Only `/invoke` exists today (`apps/backend/src/gateway-auth.ts:471`).

**Investigation.** Each read already has a `knownToken` contract, so a combined command can reuse it. `apps/web/src/lib/native/web-gateway.ts:1363` is the single request path.

**Decisions.**

- **Where does the combined read live?**
  - **One new progressive-update command that answers transcript and state with their `knownToken`s (recommended).**
    - Pros: one request; reuses the token contract; an older backend is detected by the missing command.
    - Cons: a new protocol command that needs a version-compatibility entry.
  - **A generic bounded `/invoke-batch`.**
    - Pros: helps every caller.
    - Cons: new gateway surface with its own bounds, auth and error semantics.

## Constraints and rationale

- Decided 2026-11-01 (1202 tasks 1 and 4), as above: do not reopen these choices.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): missed events stay detectable, and unmount is not cancel. Moving reads off timers must not make background work depend on a mounted view.

## Related

- [Efficiency report, A](../2026-10-27-efficiency.md#a-gateway-and-transport) (GW-1), and WEB-1 in [section D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 tasks 1 and 4](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [0052 remote client bandwidth](../../todo/transcripts-and-observation/0052-remote-client-bandwidth.md)
- [0180](0180-tx-5-session-state-conditional-read.md): the backend's cost of each state read
