# Duplicated mailbox authorization and runtime ids in the Control MCP tools

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Use one own-mailbox check**: the three copies call `ownConversationMailbox`. Status: open.
2. **Use `coordinatorRuntimeId`**: replace the hand-built ids. Status: open.

### 1. Use one own-mailbox check

**Problem.** An authorization rule is copied three times, so a fix to one can miss the others.

**Context.** `control-mcp-tools.ts` is now 2,411 lines (2,002 in the report).

**Investigation.** The helper is at `:392-412`, used once (`:2114`). Copies are at `:2240-2259`, `:2285-2304` and `:2372-2391`. They differ only in the error text ("read" or "acknowledge"). The helper finds a conversation by id whether or not it is closed, as they do, so behaviour would not change.

**Decisions.** None: a small `assertOwnMailbox(input, verb)` built on the helper.

### 2. Use `coordinatorRuntimeId`

**Problem.** The `coordinator:<id>:<conversation>` format is written by hand in several places.

**Context.** The helper is in `@orkestrator/protocol/coordinator`.

**Investigation.** `control-mcp-tools.ts:407`, `:2240`, `:2285`, `:2324`, `:2372`, `control-mcp-server.ts:583` and `scheduled-jobs/service.ts:560`.

**Decisions.** None: mechanical replacement. `control-mcp-tools.ts` already imports from that module.

## Related

- [Coordinator report, 6](../2026-10-27-coordinator.md#6-maintainability)
