# One busy flag disables unrelated controls

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Add `runAction` and separate the flags**: one helper for the repeated pattern, with a Git busy state apart from a conversation busy state. Status: open.

### 1. Add `runAction` and separate the flags

**Problem.** A branch fetch blocks New side agent, because one `operation` value disables everything.

**Context.** The report's `runAction` suggestion is the same change, since the helper is what sets the flag.

**Investigation.** `operation` is one state (`CoordinatorPanel.tsx:117-119`), with 12 `setOperation` calls. Every control disables on `operation !== null` (`:737`, `:832`, `:964`, `:974`, `:1031`, `:1130`). The set/try/finally pattern is repeated in `runGit`, `confirmUpstreamMerge`, `createConversation`, `setPaused`, `closeConversation` and the switch preparation. `closeConversation` does not clear the earlier error, which a helper would fix ([0180](0180-coordinator-errors-need-an-alert.md)).

**Decisions.** None: Git operations and conversation operations are independent on the backend (Git is serialized per repository root, conversations per project), so two flags are correct.

## Related

- [Coordinator report, 6](../2026-10-27-coordinator.md#6-maintainability)
- [0340-coordinator-panel-does-too-much.md](0340-coordinator-panel-does-too-much.md)
