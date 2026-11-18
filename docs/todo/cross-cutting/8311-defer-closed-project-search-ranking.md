# Defer project search ranking until the palette opens

## Task analysis

Analysed 2026-11-18 against `main` at `583da944e`. Benchmark from the performance review at `259e88d90`.

### Tasks

1. Prepare and rank project search results only when the palette needs them. Status: open.

### 1. Prepare and rank project search results only when the palette needs them

**Problem.** The mounted sidebar search prepares sources and ranks results even with its palette closed. A change to environments, machines, or recent items can trigger that work when nobody can see the results.

**Context.** `ProjectSearchBar` builds local and remote sources, then scores and sorts the matches. An empty query still ranks rows before returning a limited set of recents. [Search bar](../../../apps/web/src/components/sidebar/ProjectSearchBar.tsx) · [Project search ranking](../../../apps/web/src/lib/project-search.ts)

**Investigation.** In headless Chromium 159, running local source preparation and empty-query ranking with 50 projects took a median of 1.2 ms for 500 environments and 5.2 ms for 2,000. The fixture excludes React commits and remote sources.

**Decisions.**

- **Gate source preparation and ranking on the palette's open state (recommended).** Pros include removing the closed-state work and ranking the current inputs when the reader opens the palette. First-open latency pays for the ranking and needs a measurement.
- **Maintain a search index while the palette is closed.** Pros include potentially faster first-open results on very large installations. Index maintenance still consumes renderer time while closed and needs invalidation across nodes.

## Needs verification

- Confirm updates to environments, machines, and recent items trigger no source preparation or ranking while the palette is closed. Measure first-open latency with the 500- and 2,000-environment fixtures.
- Verify button and keyboard opening, current recents, live updates while open, machine filters, and keyboard selection after closing and reopening.
