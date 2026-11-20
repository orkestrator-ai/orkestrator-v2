# Defer project search ranking until the palette opens

## Task analysis

Analysed 2026-11-18 against `main` at `583da944e`. Benchmark from the performance review at `259e88d90`.

### Tasks

1. Prepare and rank project search results only when the palette needs them. Status: done.

### 1. Prepare and rank project search results only when the palette needs them

**Problem.** The mounted sidebar search prepares sources and ranks results even with its palette closed. A change to environments, machines, or recent items can trigger that work when nobody can see the results.

**Context.** `ProjectSearchBar` builds local and remote sources, then scores and sorts the matches. An empty query still ranks rows before returning a limited set of recents. [Search bar](../../../apps/web/src/components/sidebar/ProjectSearchBar.tsx) · [Project search ranking](../../../apps/web/src/lib/project-search.ts)

**Investigation.** In headless Chromium 159, running local source preparation and empty-query ranking with 50 projects took a median of 1.2 ms for 500 environments and 5.2 ms for 2,000. The fixture excludes React commits and remote sources.

**Decisions.**

- **Gate source preparation and ranking on the palette's open state (recommended).** Pros include removing the closed-state work and ranking the current inputs when the reader opens the palette. First-open latency pays for the ranking and needs a measurement.
- **Maintain a search index while the palette is closed.** Pros include potentially faster first-open results on very large installations. Index maintenance still consumes renderer time while closed and needs invalidation across nodes.

## Current state

Done on 2026-11-20. `useProjectSearchResults` (`apps/web/src/components/sidebar/useProjectSearchResults.ts`) prepares the local and remote sources, the recent keys and the ranking only while the palette is open; closed, it returns empty results without reading its inputs. `ProjectSearchBar` uses it and shows no destination empty-state line while closed.

Verification:

- `useProjectSearchResults.test.ts` wraps every input (projects, environments, repositories, other machines, recents) in read-counting proxies and proves a closed palette reads none of them while they change, that opening ranks the inputs current at that moment, recents first, and that live updates, the machine filter, closing and reopening behave as before.
- `ProjectSearchBar.test.tsx` ("opens by button or shortcut on the environments and recents current at that moment") changes environments and recents while closed, opens by button and by ⌘K, and checks current rows, recents order, a live update while open and keyboard selection.

Measurements: `mise exec -- bun e2e/perf/project-search-open-perf.ts` (`e2e/fixture/ProjectSearchScalePerfFixture.tsx`, production React, headless Chromium 158.0.8127.18, 50 projects, 8 recent projects, 30 updates and 20 opens per run) on beelink (Intel Core Ultra 9 285H, load average about 2), three runs each of this change and of `main` at `0b778d995` with the old `ProjectSearchBar.tsx` built in. Figures are the median of the three per-run medians, in milliseconds.

| Environments | Measure | `main` | This change |
| --- | --- | --- | --- |
| 500 | Closed update (render and commit of an environment-list change) | 0.8 | 0.2 |
| 500 | First open, button press to first result row | 7.7 | 7.0 |
| 500 | First open, to the end of the next frame | 9.1 | 8.1 |
| 500 | Update while open | 2.1 | 2.0 |
| 2,000 | Closed update | 2.1 | 0.2 |
| 2,000 | First open, button press to first result row | 6.4 | 7.9 |
| 2,000 | First open, to the end of the next frame | 7.5 | 9.0 |
| 2,000 | Update while open | 2.8 | 3.0 |

The closed update now costs only the search bar's own render at both sizes. First open at 2,000 environments pays the preparation and ranking it no longer does in the background, about 1.5 ms; at 500 the difference is inside the run-to-run spread (per-run first-open medians ranged 5.5 to 17.1 ms on `main` and 6.0 to 7.9 ms with the change).

## Assumptions and decisions

### Task 1: where the gate lives

Chose a hook, `useProjectSearchResults`, that takes every input as an argument and returns empty results while closed, over gating the three memos inside `ProjectSearchBar`. The hook is testable alone with read-counting inputs, which is the closed-state proof the task asks for, and keeps the 1,200-line component shorter. Command search, which ranks a fixed catalogue, is unchanged.

### Task 1: the closing motion

While the dialog plays its 200 ms exit motion the palette is already closed, so its destination rows leave with the rest of the reset (the query and filter already cleared on close) and the "No projects yet" line is suppressed rather than shown for the frames of the fade. Keeping the last results through the motion would need a state update on every live change while open.
