# Bridge restarts in the health row

## Task analysis

Analysed 2026-11-05 against `main` at `ecff91f74`. From E15 part `0820` task 1.
Done 2026-11-10 on a branch from `04639b12b`.

### Tasks

1. **Add a bridge restart count to the health row**: the one figure the report asks for that has no source. Status: done.

### 1. Add a bridge restart count to the health row

**Problem.** "Why did it restart?" can be asked of a bridge too, and the row has no figure for it.

**Context.** The logging report's R12 lists bridge restarts among the row's fields. E15 wrote everything else from sources that exist. Rows hold numbers and job kinds only, and the sample reads memory, so it must not start asking bridges anything.

**Investigation.** Bridge restarts have no counter. `bridge.started` and `bridge.exited` in `local-server-runtime.ts` and `bridge.launched` for Docker are log lines, and the essential log keeps them, so the evidence survives there one event at a time. A container bridge relaunch is seen only by the host's launch path.

**Decisions.**

- **Where does the count live?**
  - **A small in-memory counter per provider beside the existing log lines, read by the sample (recommended).**
    - Pros: one more number in the row with no I/O; the provider names are a fixed list.
    - Cons: two sites to keep in step with their log lines.
  - **Leave it to the essential log.**
    - Pros: nothing to build; the events are already kept.
    - Cons: a count over time means reading a log, and the log's per-event limit can hide a restart loop.

## Current state

Done. Every health `sample` row carries `bridges`: per provider, `localStarts`,
`localUnrequestedExits` and `containerLaunches`, cumulative in the process and left
out while zero. `apps/backend/src/core/bridge-restarts.ts` holds the counter; it is
fed beside `bridge.started` and `bridge.exited` in `local-server-runtime.ts` and
beside the three `bridge.launched` lines in `commands-containers.ts`, and read by
`health-summary.ts`. The behaviour is documented in
[logging.md](../../architecture/logging.md#health-summary-and-the-clean-exit-marker).
How the counts look on a real install over a week is part of
[6141](6141-health-and-diagnostics-live-evidence.md).

## Assumptions and decisions

### Task 1: what counts as a restart

The counter records starts, not "restarts": a first start counts too, and a restart is
a start beyond the first, which a reader of two samples can tell apart. Unrequested
exits are counted separately, so a restart loop shows as starts and unrequested exits
rising together, while a bridge replaced on purpose (a model or login change) raises
only the starts. Counting only "a start after an unrequested exit" would need per-key
state and would miss container relaunches, which the host sees only as launches.

### Task 1: where the count lives

The recommended option: a small in-memory counter beside the existing log lines, read
by the sample with no I/O. Providers are a fixed list (the six local server kinds plus
`opencode2`, the host OpenCode 2 server's key), so the table is bounded and a row still
holds no free text; a key outside the list is not counted. The local-server runtime
takes the counter as an option (the process-wide one by default) so its tests count in
isolation. The two log sites and the counter sit on adjacent lines, which is the
"two sites to keep in step" cost the decision named.

## Related

- [Application logging](../../architecture/logging.md#health-summary-and-the-clean-exit-marker)
