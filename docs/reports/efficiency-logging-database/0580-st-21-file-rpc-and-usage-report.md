# Whole files cross RPC as base64, branch reads spawn twice, and usage reports parse every row

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Range route for file reads**: serve file bytes over HTTP instead of base64 RPC. Status: open.
2. **One process for branch reads**: stop running `cat-file` then `show`. Status: open.
3. **Usage report cost**: stop parsing every row per request. Status: open.

### 1. Range route for file reads

**Problem.** A file read is encoded as base64 inside one RPC response, whole.

**Context.** The report points at `transcript-artifacts/media-stream-route.ts` as the model.

**Investigation.** The commands are registered at `apps/backend/src/core/commands-registry-terminal.ts:940` and `:960`; `read_container_file_base64` is beside `read_file_at_branch` (`:1240-1258`). The allowlist of readable roots for `read_file_base64` is built in that handler (`:942-957`), so a route must apply the same check.

**Decisions.**

- **Replace, or add?**
  - **Add a route and move large-file readers to it, keeping the commands for small reads and older clients (recommended).**
    - Pros: additive; no version-compatibility break; the same authorisation can be shared.
    - Cons: two read paths, and a new route is gateway surface.
  - **Keep RPC and only cap sizes.**
    - Pros: no new surface.
    - Cons: does not remove the base64 cost for what remains.

### 2. One process for branch reads

**Problem.** Each read spawns `git cat-file -s`, then `git show`, and resolves its base with more.

**Context.** The report suggests one `git cat-file --batch` process.

**Investigation.** The local path is `apps/backend/src/core/commands-files.ts:2335-2361`; the container path is `commands-registry-terminal.ts:1244-1252`.

**Decisions.**

- **How far?**
  - **One `git cat-file --batch` invocation per read, which answers size and content from one process (recommended).**
    - Pros: one process; the size is known before reading the body, so the size check stays.
    - Cons: output parsing must be bounded so an oversized blob is not read in full.
  - **A long-lived batch process per worktree.**
    - Pros: cheapest per read.
    - Cons: a process to supervise and retire, for an occasional read.

### 3. Usage report cost

**Problem.** A report parses up to 20,000 rows per request, even when it filters by environment.

**Context.** The report suggests querying by owner and caching by revision.

**Investigation.** `report` walks `readRecords` (`apps/backend/src/core/usage-history-store.ts:146`, `:336-350`). The file's comments say both choices are deliberate. A report reads every row even when filtered, because `recordingSince` and `recordedPlatforms` describe the whole recording (`:44-47`, `:147-151`), so a query by owner would lose them. Reads are also uncached on purpose, because caching the whole store "would retain months of history in memory for a pane nobody has open" (`:41-43`).

**Decisions.**

- **Which fix survives that?**
  - **Keep the small finished report per query and store state, not the parsed rows (recommended).**
    - Pros: respects both comments; a repeat query costs almost nothing; each entry is small and easy to bound.
    - Cons: needs a change signal for these uncached rows, which `usage-history-store.ts` does not have today, and a day rollover must invalidate it.
  - **Query by owner, and store the whole-recording facts separately.**
    - Pros: smallest read for a filtered report.
    - Cons: new stored data to keep consistent, and an unfiltered report still reads everything.

## Constraints and rationale

File read authorisation must not weaken on a new route. Caches need byte and count bounds, per the report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep).

## Needs verification

- How often large files are read this way; the report's impact is reasoned, not measured.

## Related

- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 7
