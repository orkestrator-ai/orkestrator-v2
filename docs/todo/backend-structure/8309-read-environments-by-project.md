# Read only the requested project's environments

## Task analysis

Analysed 2026-11-18 against `main` at `583da944e`. Benchmark from the performance review at `259e88d90`.

### Tasks

1. Use the existing project-scoped environment reader for project lookups. Status: open.

### 1. Use the existing project-scoped environment reader for project lookups

**Problem.** `getEnvironmentsByProject` loads, normalizes, and sorts every stored environment before filtering by project. A batch of per-project reads repeats that work for every project in the batch.

**Context.** The environment list and snapshot commands use this method. `ProjectsRepository.loadProjectEnvironments` already reads SQLite rows by owner and applies the same normalization and ordering. [Projects repository](../../../apps/backend/src/core/storage-projects.ts) · [Environment commands](../../../apps/backend/src/core/commands-registry-environments.ts)

**Investigation.** A temporary store held 50 projects with 10 environments each. A batch of 50 lookups took 20.49 ms through the current method and 1.08 ms through the existing owner-scoped reader, using the median of seven warm batches. Both returned 500 rows in aggregate. The timings cover repository reads and exclude command transport.

**Decisions.**

- **Route the lookup through `loadProjectEnvironments` (recommended).** Pros include reading only one project's rows and reusing the repository's current owner and normalization logic. Verify equivalent results through both command paths, including older persisted records and tied sort keys.
- **Index the full in-memory environment snapshot by project.** Pros include reusing decoded data for callers that need the whole snapshot. It adds retained state and revision handling for a lookup SQLite already supports.

## Needs verification

- Compare IDs, ordering, normalized values, and empty-project responses through the list and snapshot paths. Include older records, tied order values, and recent creation, movement, and deletion.
- Repeat the batch benchmark and measure a single project read as the number of unrelated environments grows.
