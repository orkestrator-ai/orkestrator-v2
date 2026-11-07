# Evidence for a queued row whose turn the renderer does not see as running

## Task analysis

Analysed 2026-11-05 against `main` at `41f9eb638`.

### Tasks

1. **Record when a queued row is unsteerable because the turn is not running**: leave content-free evidence that survives until someone reads the log. Status: open.

### 1. Record when a queued row is unsteerable because the turn is not running

**Problem.** A queued row with no note and no Steer means the renderer did not see the turn as `running`. Nothing records that state, so if [4700](4700-coordinator-steer-missing-on-long-lived-coordinator.md) recurs this way, its new log lines stay silent and the cause is still unknown.

**Context.** `isRunning` is `phase === "running"` in `AgentNativeTab.controller.tsx`, and `queuedSteerNote` in `auto-steer.ts` returns no note when it is false. The phase comes from the backend's projection. There it can be `recovering` while the bridge is reconnecting or unreachable, `cancelling`, `error` or `blocked` (`native-agent-transcript-projection.ts`). The renderer then merges what it receives, so its view can also differ from the backend's latest.

**Investigation.** This was carried from 4700 because it cannot be logged cheaply. A `web.native-agent` line is a few lines of code, but it stays in the browser console: only the seven startup markers cross to the saved log (`docs/architecture/logging.md`, "What stays out of the persistent log"), and whether more may cross is undecided (R8 in the logging review (`git show 413bd6219:docs/reports/2026-10-29-logging-and-database-efficiency.md`)). The backend can log its own phase, but it cannot see the renderer's merged state. None of the options below has been built or tried.

**Decisions.**

- **Where should the evidence come from?**
  - **A backend debug line when a projection with queued items is not `running` (recommended).** Write one line on each change of phase, with the agent, environment id, phase and queue length.
    - Pros: no new path out of the renderer; content-free; separates a backend or bridge cause from a renderer one, because a `running` phase on the backend with a bare row points at the renderer.
    - Cons: shows the backend's view only; needs per-session state to fire on changes; a queue draining at the end of a normal turn also writes it; needs **Log Detail** set before the occurrence.
  - **The renderer reports a content-free transition to the backend.**
    - Pros: records the renderer's actual view, which is what the row is drawn from.
    - Cons: a new write path from the renderer, with bounds to design; it pre-empts the undecided R8.
  - **A renderer console line only.**
    - Pros: trivial.
    - Cons: lost on reload and never saved, so it helps only if DevTools is already open when the problem happens.

## Needs verification

- Whether a real occurrence is this case at all. It is only one of the three states 4700 could not tell apart for 2026-11-04.

## Related

- [4700-coordinator-steer-missing-on-long-lived-coordinator.md](4700-coordinator-steer-missing-on-long-lived-coordinator.md) (the reported problem, and how to read its log lines).
