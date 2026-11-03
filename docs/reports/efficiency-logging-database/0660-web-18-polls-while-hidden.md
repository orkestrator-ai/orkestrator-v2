# Some renderer polls keep running while the window is hidden

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Route polls through the read coordinator**: pause presentation polls while the document is hidden. Status: open.

### 1. Route polls through the read coordinator

**Problem.** These polls keep issuing reads while nobody can see the result.

**Context.** `apps/web/src/lib/read-coordinator.ts` pauses automatic reads while the document is hidden and reconciles once on return, and `apps/web/src/hooks/useCoordinatedRead.ts` is the hook for it. 1202 task 3 decided (GW-13) that `useUserCommands` keeps its 3 s backstop rather than losing it; that concerns removing the poll, not pausing it while hidden.

**Investigation.** Plain `setInterval`s, none of which check visibility:

- Docker probe, 60 s: `apps/web/src/App.tsx:683`.
- User commands, 3 s while one runs: `apps/web/src/hooks/useUserCommands.ts:68`.
- Dialogs and panels: `components/bug-report/BugReportSheet.tsx:183`, `components/docker/DockerImageStatusPanel.tsx:97`, `components/docker/DockerSettings.tsx:105`, `:214`, `components/environments/EnvironmentRecoveryCopies.tsx:119`, `components/federation/ProjectCopyDialog.tsx:171`, `components/settings/machines/useMachineMaintenance.ts:136`.
- Annotation selection, 400 ms, only while selecting: `components/browser/annotations/useAnnotationCapture.ts:491`.

**Decisions.**

- **Which polls move?**
  - **All of them except annotation selection, which keeps its timer and gains a visibility check (recommended).**
    - Pros: one scheduling owner; annotation selection is a short, user-started operation whose status the user is waiting on.
    - Cons: many small migrations, each of which has to keep its cadence.
  - **Add a visibility check to each timer.**
    - Pros: smaller diffs.
    - Cons: each one needs its own catch-up on return, which is what the coordinator already does.

## Constraints and rationale

The coordinator is read-only and must never own commands, per its header comment. "Unmount is not cancel" in the report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) applies: only the view's reads pause, not the work they watch.

## Needs verification

- How much hidden-window timer throttling already hides this in Electron and browsers. Not checked.

## Related

- [Efficiency report, D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 3
