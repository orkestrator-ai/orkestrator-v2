# Scope pipeline activity updates to affected environments

## Task analysis

Analysed 2026-11-18 against `main` at `583da944e`. Work counts from the performance review at `259e88d90`.

### Tasks

1. Apply pipeline change events to the affected environments and retain full reconciliation for recovery. Status: open.

### 1. Apply pipeline change events to the affected environments and retain full reconciliation for recovery

**Problem.** One pipeline update lists and clones every stored pipeline, marks all their environments dirty, and scans the full pipeline collection again for each dirty environment. Finished build history increases the work done by every active build.

**Context.** `BuildPipelineActivity` maintains the sidebar activity source and emits completion notifications. It serializes observations, debounces changes per pipeline, and runs full reconciliation every 30 seconds for missed or cross-process changes. [Pipeline activity observer](../../../apps/backend/src/core/build-pipeline-activity.ts)

**Investigation.** In a temporary SQLite store with 100 completed pipelines in 100 environments, one `observe` call after startup listed 100 pipeline records and read 100 environments. `observe` already fetches the changed record by ID before the full pass. The full pass also serves startup and retry.

**Decisions.**

- **Update the recorded pipeline and only reconcile its previous and current environments on the event path (recommended).** Pros include scoping work to the change and having a full recovery path for missed events. The event path must handle deletions, reassignments, and events that arrive during an activity write.
- **Keep a full pass for every event and group records by environment during that pass.** Pros include simpler recovery logic and removing the nested scans. Every event would still list all pipelines and recheck unrelated environments.

## Needs verification

- Repeat the 100-environment fixture and count record listings and environment reads for a single change. Count full passes separately and measure what the single-record storage read does after a revision changes.
- Verify two pipelines sharing an environment, a moved or deleted pipeline, a completion during an activity write, retry after a failed write, and missed-event recovery. Exercise an inactive environment through completion and verify its final status and notification after returning and reloading. [Existing activity tests](../../../apps/backend/src/core/build-pipeline-activity.test.ts)
