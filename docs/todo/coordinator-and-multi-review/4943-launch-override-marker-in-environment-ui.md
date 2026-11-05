# Launch override marker in the environment and tab UI

## Task analysis

Analysed 2026-11-05 against main at af2e566e5, with coordinator batch C7 (Work panel and navigation) applied.

### Tasks

1. **Mark a coordinator launch that overrode the default, where the environment is shown**: no screen shows it since the Work panel was removed on 2026-11-05. Status: open.

### 1. Mark a coordinator launch that overrode the default, where the environment is shown

**Problem.** A coordinator can launch a worker on a more expensive model than the configured default, and someone looking at that environment or its tab cannot see that it was an override.

**Context.** From coordinator report C7, part `0260`, task 1. Its Context noted that `docs/architecture/coordinator.md` called this "a tracked follow-up" although no to-do mentioned it. This file is now that to-do. C7 added the marker on Work rows ("requested", from `delegation.request.source`); the Work panel, and that marker with it, was removed on 2026-11-05.

**Investigation.** The tool results report `selection.source` (see Launch defaults in `coordinator.md`). `delegation.request` holds it per request in the coordinator store, for this coordinator's own workers. The environment record holds `initialAgentModel` and `initialReasoningEffort` but not whether they were requested, and the tab header reads the live session's model.

**Decisions.**

- **Where should the fact live?**
  - **Show it from the delegation on the tab of a coordinator's worker (recommended).**
    - Pros: no new stored field; the record already exists.
    - Cons: the tab needs a coordinator read it does not make today, and a worker on another node keeps the record on the command node.
  - **Add `launchSource` to the environment record.**
    - Pros: every surface can read it, on any node.
    - Cons: a new field on a large record, for a marker only coordinator launches set.

## Related

- [Launch defaults](../../architecture/coordinator.md#launch-defaults)
