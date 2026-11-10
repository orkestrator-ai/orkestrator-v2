# Repoint source comments for retired diagnostics to-dos

## Task analysis

Analysed 2026-11-10 against main at `c98b20e6f633`.

### Tasks

1. **Repoint the two backend source comments**: replace the retired task-file references with the living logging architecture document. Status: open.

### 1. Repoint the two backend source comments

**Problem.** Two backend comments name task files retired by the four-status
to-do index change, leaving readers with paths that no longer exist.

**Context.** This ticket permits documentation and the index test only.
The source-comment edits therefore belong in a subsequent change that permits
backend file edits. Neither comment affects runtime behavior.

**Investigation.** `apps/backend/src/core/bridge-restarts.ts` names
`docs/todo/cross-cutting/6142-health-row-bridge-restarts.md` in its opening
comment. `apps/backend/src/core/diagnostics-container-logs.ts` names
`docs/todo/cross-cutting/6143-diagnostics-bundle-container-logs.md` in its
module comment. Their durable behavior is documented in
[logging.md](../../architecture/logging.md). Replace both references with
`docs/architecture/logging.md`, then search `apps/` for both retired
filenames to confirm neither reference remains.

**Decisions.**

- **Repoint the comments in a code-allowed follow-up (recommended).**
  - Pros: respects this ticket's scope and points readers to maintained docs.
  - Cons: the two comments remain stale until that follow-up lands.
- **Restore the completed task files.**
  - Pros: the current comment paths work immediately.
  - Cons: keeps completed work solely for source references and duplicates
    the living architecture documentation.

## Outstanding work

- Complete task 1; no credentials, live profile or product decision is needed.

## Constraints and rationale

- Keep the later edit limited to comment references; preserve runtime behavior.

## Related

- [Cross-cutting index](0000-index.md)
- [Logging architecture](../../architecture/logging.md)

## Assumptions and decisions

### Task 1: respect the documentation-only scope

Record the exact two edits here rather than changing backend source in this
ticket. This resolves the review's missing-follow-up finding while keeping
the completed tasks retired.
