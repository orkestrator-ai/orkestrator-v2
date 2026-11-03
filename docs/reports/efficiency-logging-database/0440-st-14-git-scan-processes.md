# Each diff scan spawns several git processes

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **One diff pass**: replace the separate `--name-status` and `--numstat` diffs with one. Status: open.
2. **Ensure the exclude file once per worktree**: stop resolving and reading it on every scan. Status: open.
3. **Reuse the resolved base oid**: stop resolving the base twice. Status: open.

### 1. One diff pass

**Problem.** Every scan runs rename detection twice over the same range.

**Context.** The report's fix is one `git diff --raw --numstat -z -M` pass. Containers have the same pair.

**Investigation.** The local pair is at `apps/backend/src/core/commands-files.ts:1008-1028`; the container script runs it at `:656-659`; Git scopes repeat it at `apps/backend/src/core/change-tracking/git-scopes.ts:382`. The two outputs feed `parseGitFileChanges`, and numstat also filters out stat-only modifications, because `diff.autoRefreshIndex=false` lets name-status report them (`commands-files.ts:1044-1049`).

**Decisions.**

- **Combine the output, or keep two runs?**
  - **One `--raw --numstat -z -M` run with one new parser, used by all three callers (recommended).**
    - Pros: removes one rename detection per scan everywhere.
    - Cons: a new `-z` parser that must read both record shapes, and the stat-only filter must be re-proved against the combined output.
  - **Keep two runs, and only do tasks 2 and 3.**
    - Pros: no parser risk.
    - Cons: the costliest process stays.

### 2. Ensure the exclude file once per worktree

**Problem.** Each scan spawns `git rev-parse --git-path info/exclude` and reads the exclude file, to write nothing almost every time.

**Context.** The patterns only need to be added once.

**Investigation.** `getLocalGitStatusDetailed` calls `addLocalWorkspaceArtifactsToGitExclude` first (`commands-files.ts:979`), which resolves and reads the file on every call (`:2583-2600`, `:2602-2605`).

**Decisions.**

- **How long does "ensured" last?**
  - **A bounded in-process set of ensured worktrees, cleared when the environment is forgotten (recommended).**
    - Pros: no spawn after the first scan; survives nothing it should not.
    - Cons: an exclude file edited away mid-process is not restored until restart.
  - **Stat the exclude file and rewrite only on a change.**
    - Pros: repairs an edit.
    - Cons: still needs the path, so it keeps either the spawn or a cached path.

### 3. Reuse the resolved base oid

**Problem.** The base is resolved with up to two `rev-parse` calls, then `rev-parse` runs again for its oid.

**Context.** Both answers come from the same command.

**Investigation.** `resolveLocalGitBase` calls `gitRefExists` for `origin/<branch>` and then `<branch>` (`commands-files.ts:1296-1298`, `:1216-1219`). `getLocalGitStatusDetailed` then runs `rev-parse --verify -q <base>^{commit}` (`:1035`).

**Decisions.** None: have the resolver return the oid it already verified, and pass it on.

## Constraints and rationale

The scan's hardening must stay: `HARDENED_GIT_CONFIG`, `neutralizeGitFilters` before anything can hash worktree bytes (`commands-files.ts:999-1004`), and the legacy fsmonitor removal (`:982`).

## Needs verification

- Whether `--raw --numstat -z -M` reports stat-only modifications the same way the two separate runs do.
- Process counts per scan; the report's 7 to 9 is from reading code. `git-spawn` per job kind in the recurring-work metrics can confirm it.

## Related

- [Efficiency report, E](../2026-10-27-efficiency.md#e-storage-change-tracking-git-and-files)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 7
- [ST-15](0450-st-15-untracked-file-count-cache.md), [ST-16](0420-st-16-local-scan-minimum-gap.md)
