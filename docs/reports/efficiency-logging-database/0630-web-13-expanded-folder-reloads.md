# Expanded truncated folders are re-read every 5 s without a digest

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Conditional subtree reads**: answer `unchanged` for a folder that has not changed. Status: open.

### 1. Conditional subtree reads

**Problem.** While the All files tab is open, every visible loaded folder is re-read in full on each tick.

**Context.** The whole tree and change list already use a digest (`knownDigest`, `apps/backend/src/core/commands-registry-terminal.ts:201-205`, `:912-917`).

**Investigation.** `reloadFolders` runs on each coordinated read for that tab (`apps/web/src/hooks/useFilesPanel.ts:644-663`, `:774`, at the 5 s interval from `:32` and `:758`). Its comment records that subtrees sit outside the snapshot's digest (`:642-643`). `get_local_file_subtree` and `get_file_subtree` take no digest (`commands-registry-terminal.ts:921`, `:1221`). The read already pauses while the document is hidden, through the read coordinator.

**Decisions.**

- **How to skip the work?**
  - **Add `knownDigest` to both subtree commands using the existing `snapshotResponse` helper (recommended).**
    - Pros: the contract every other Files panel read uses; no payload when nothing changed.
    - Cons: the backend still walks the folder; older backends need the additive fallback.
  - **Skip the folder reload while a watched worktree's snapshot revision is unchanged.**
    - Pros: no read at all.
    - Cons: only works for a watched target; a missed hint leaves a folder stale until a full refresh.

## Constraints and rationale

An explicit refresh must still re-read (`useFilesPanel.ts:795`). Command changes follow `docs/architecture/version-compatibility.md`: additive only.

## Needs verification

- How many folders stay expanded in real use; the report's impact is reasoned, not measured.

## Related

- [Efficiency report, D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 3
