# Load earlier history directly when no kept row names a cursor

Found while applying the user's 2026-11-14 legacy-retirement decision to
[0232](0232-direct-history-cursor-minting.md). Removing joined paging (0232
task 4) no longer waits on the support window, but three cases still page
through the joined v1 path because the current renderer has no direct cursor
for them. They need direct recovery first, or they would have nothing older
to load once the path goes.

## Task analysis

Analysed 2026-11-14 against `main` at `066992035`. Nothing has been built.

### Tasks

1. **Direct recovery for the three `unnamed-cursor` cases**: a first-message snapshot whose projected rows exceed the backend byte bound, a window whose kept rows name no cursor at its boundary (the OpenCode error-row case), and a cursor too long to wrap. Status: open.

### 1. Direct recovery for the three `unnamed-cursor` cases

**Problem.** When the session's latest progressive view carries no direct
history cursor although the source pages, "Load earlier messages" falls back
to the joined v1 path (`history.joined-v1-page.unnamed-cursor`). That path is
compatibility code the sweep removes.

**Context.** `directHistoryGaps` and the projection's history cache in
`native-agent-transcript-projection.ts`; the renderer's mint fallback in
`loadEarlierMessages` (`useNativeAgentSession`). 0232's Outstanding work item
3 describes the three causes and their tests (`a view retaining only an
error row uses joined paging …` for OpenCode history, the summary-transcript
owners for the byte-bound case). The register row for joined paging names
"direct recovery for the first-message byte-bound, cursor-boundary and
cursor-length cases" as part of its removal condition
([version-compatibility.md](../../architecture/version-compatibility.md#register)).

**Investigation.** Not started. For each case, find what the backend could
name instead: the source's own page cursor for the first dropped row (byte
bound), the nearest earlier row that does carry one (boundary), or a
server-side handle for an overlong cursor.

**Decisions.**

- **Where does the recovery live?**
  - **In the backend, so every view it serves carries a direct cursor
    whenever the source pages (recommended).**
    - Pros: the renderer keeps one paging path; the `unnamed-cursor` counter
      goes quiet by construction.
    - Cons: the backend must keep or derive a cursor for rows it dropped.
  - **In the renderer, by re-reading a smaller window to find a cursor.**
    - Pros: no backend state.
    - Cons: extra reads on every such page; a second paging path in the
      renderer.

## Assumptions and decisions

### Why a new to-do (2026-11-14)

0232 task 4 recorded that no task in that file or any other builds this
recovery, and the repository rule puts new work in a new file. This file is
that work; 0232 task 4 waits on it and on 0050 task 1.

## Constraints and rationale

- Transcript rows stay one model response each, and history paging keeps
  every row reachable (root `AGENTS.md`, invariant 14).

## Related

- [0232](0232-direct-history-cursor-minting.md) task 4: the removal this unblocks.
- [0050](0050-transcript-history-efficiency.md) task 1: the `/messages`
  fallback removal, the other wait.
- [8108](../cross-cutting/8108-legacy-retirement-sweep.md): the sweep.

## Replaces

Nothing; new work found on 2026-11-14.
