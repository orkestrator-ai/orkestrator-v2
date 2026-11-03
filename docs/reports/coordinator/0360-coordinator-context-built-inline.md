# The coordinator context is built inline

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Extract a pure builder**: `buildCoordinatorContext(...)`, testable for size and content. Status: open.

### 1. Extract a pure builder

**Problem.** The prompt is a string concatenation inside `trustedInput`, so its size and content cannot be checked without the service. It has grown a lot since the report.

**Context.** Individual rules were moved to `packages/protocol/src/coordinator.ts`, but the assembly was not.

**Investigation.** Assembly is at `native-agent-service.ts:1297-1335`, mixing async reads (repository config, checkout update, node context, scheduling) with text.

**Decisions.**

- **Where does it live?**
  - **`packages/protocol`, taking already-read values as arguments (recommended).**
    - Pros: pure; the 0024 live suite can assert on it; a size test can guard it.
    - Cons: a long argument list while the prompt has this many inputs.
  - **A helper in `apps/backend`.**
    - Pros: can do its own reads.
    - Cons: not usable from the live suite, and it stays non-pure.

## Related

- [Coordinator report, 6](../2026-10-27-coordinator.md#6-maintainability)
- [0024-coordinator-live-conformance.md](../../todo/coordinator-and-multi-review/0024-coordinator-live-conformance.md)
- [0170-context-block-project-name-and-open-work.md](0170-context-block-project-name-and-open-work.md)
