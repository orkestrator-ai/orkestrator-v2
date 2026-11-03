# Web research settings: limit message and Enter

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Explain the server limit and accept Enter**: say why Add is disabled, and let Enter add. Status: open.

### 1. Explain the server limit and accept Enter

**Problem.** At the limit Add is disabled with no reason, and Enter in either field does nothing.

**Context.** The limit is `MAX_COORDINATOR_RESEARCH_MCP_SERVERS`, eight servers.

**Investigation.** `canAdd` includes the limit (`CoordinatorWebResearchSettings.tsx:65-68`), while `draftProblem` does not (`:59-64`), so no alert appears. The inputs and button are not in a form (`:143-173`).

**Decisions.** None: include the limit in `draftProblem`, and wrap the row in a form whose submit runs the Add handler, keeping `type="button"` off that one button. Pressing Enter inside the parent settings page must not trigger anything else, so stop the submit there.

## Current state

- The report's third point is not a bug: the duplicate check at `:62` is case-sensitive, but names can only be lowercase (`SERVER_NAME`, `packages/protocol/src/coordinator-web-research.ts:56`), so an upper-case name is refused with its own message first.

## Related

- [Coordinator report, 4.4 (U13)](../2026-10-27-coordinator.md#44-ui-and-ux)
