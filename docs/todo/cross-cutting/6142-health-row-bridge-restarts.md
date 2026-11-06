# Bridge restarts in the health row

## Task analysis

Analysed 2026-11-05 against `main` at `ecff91f74`. From E15 part `0820` task 1.

### Tasks

1. **Add a bridge restart count to the health row**: the one figure the report asks for that has no source. Status: open.

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

## Related

- [Application logging](../../architecture/logging.md#health-summary-and-the-clean-exit-marker)
