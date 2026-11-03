# ACP's Cursor replay looks like dead code

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Remove the Cursor branches from the ACP bridge**: delete the replay and repoint its test harness. Status: open.

### 1. Remove the Cursor branches from the ACP bridge

**Problem.** The ACP bridge carries a replay path gated on `provider === "cursor"` that spawns a whole agent child per pass. Production runs Cursor through its own bridge, so this looks unreachable, and it adds code and tests to a sensitive module.

**Context.** The report calls it "likely dead code and a deletion candidate". The impact is about maintenance, not run-time cost, since a path that never runs costs nothing.

**Investigation.** Production: `apps/backend/src/core/commands-servers.ts` starts Cursor with the Cursor bridge settings (`CURSOR_BRIDGE_AUTH_FILE`) and reaches `env.ACP_PROVIDER = kind` (`:1172`) only in its later branch. `loadAcpProviderConfig` (`bridges/acp-bridge/src/acp-provider-config.ts:86-102`) has only Grok built in, though `ACP_PROVIDER_CONFIG` can name any id. The gates are `acp-tools.ts:570`, `:688` and `:810`, with labels at `acp-errors.ts:47` and `session-config.ts:84`.

The tests are the catch. `acp-test-harness.ts:246` defaults to `ACP_PROVIDER: "cursor"`, and `testing/fake-agent-context.ts:7` falls back to `"cursor"`, so the harness default has to change as well, and many suites may depend on it.

**Decisions.**

- **Delete, or keep it for a future ACP Cursor?**
  - **Delete the replay and the gates, and move the harness to Grok or a neutral id (recommended).**
    - Pros: removes a path no production launch reaches; the replay's reconciliation logic is large and has its own tests.
    - Cons: a wider diff than it sounds, because of the harness default; tests that use Cursor's generic labels need rewriting or removal.
  - **Leave it.**
    - Pros: no risk to the suites.
    - Cons: the code keeps being maintained for nothing.

## Constraints and rationale

- `bridges/acp-bridge/AGENTS.md` asks for standard ACP to be implemented generically. Only the Cursor-specific parts go; anything generic that uses them stays.

## Open questions

- Does anyone set `ACP_PROVIDER_CONFIG` to a Cursor id by hand? Nothing in the repository does outside tests, as far as the search reached.

## Related

- [Efficiency report, C](../2026-10-27-efficiency.md#c-bridges) (BR-16)
- [1202 task 6](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
