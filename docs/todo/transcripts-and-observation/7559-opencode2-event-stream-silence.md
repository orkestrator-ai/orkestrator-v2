# OpenCode 2.x event stream silence

## Task analysis

Analysed 2026-11-10 against `main` at `04639b12b`, found while doing
7200 task 1 (the OpenCode 1.x monitor's
silence watchdog).

### Tasks

1. **Watchdog for the 2.x provider's event stream**: `OpenCode2Provider.watchEvents` has no silence deadline, so a `/api/event` stream that stays open but goes quiet is trusted until TCP breaks. Status: open.

### 1. Watchdog for the 2.x provider's event stream

**Problem.** `OpenCode2Provider.watchEvents` (`apps/backend/src/core/opencode2/provider.ts`)
reads `GET /api/event` with `readOpenCode2Events` until the body ends or
throws, then marks everything dirty and reconnects after
`monitorRetryMs` (1 s). Nothing notices a stream that stays open and goes
silent. While `streamConnected` is true the transcript state may answer
"unchanged" without a read (`OpenCode2TranscriptState.canAnswerUnchanged`,
`opencode2/transcript-snapshot.ts`), so a stalled stream can hide changes,
not only delay hints.

**Context.** 7200 task 1 gave the 1.x monitor (`opencode-provider.ts`) a
35 s deadline armed by OpenCode's `server.heartbeat` data frame. The 2.x
server signals idle life differently: observed 2026-11-10 against the pinned
`opencode2` 2.2.6 (loopback, throwaway `HOME`, no credentials), `/api/event`
sent `server.connected` as a data frame and then `: heartbeat` SSE comment
lines, three of them within the first 40 s. The capture was buffered, so the
exact interval was not measured. `readOpenCode2Events` (`opencode2/events.ts`)
keeps only `data:` lines, so the comments never reach `onSignal`; a watchdog
built on signals alone would see an idle healthy stream as silent.

**Investigation.** Not fixed in 7200: it is a different provider, reader and
parser, and outside that to-do's scope. The connection is host-local or to a
container's mapped port, so a half-open connection is unlikely but possible
across a container pause, as for 1.x.

**Decisions.**

- **What counts as life?**
  - **Any bytes read from the body, comments included, observed inside `readOpenCode2Events` (recommended).**
    - Pros: covers the comment heartbeat without parsing it; the parser stays the only reader of the body.
    - Cons: a new callback or return on the parser, which is shared by tests.
  - **Only parsed events.**
    - Pros: no parser change.
    - Cons: an idle healthy stream sends no events, so it would reconnect on every deadline.
- **How long?**
  - **Measure the 2.x heartbeat interval first, then use about three missed intervals (recommended).**
    - Pros: the same rule as the 1.x deadline.
    - Cons: needs one more short live capture without buffering.
  - **Reuse the 1.x 35 s.**
    - Pros: no measurement.
    - Cons: wrong if 2.x heartbeats less often than every 10 s.

## Related

- to-do 7200 (retired on 2026-11-10; see [recurring-work.md](../../architecture/recurring-work.md)) task 1: the 1.x watchdog and the live observation of its heartbeat.
- [0048](0048-recurring-work-qualification.md) task 20: the event-stream reader inventory.
