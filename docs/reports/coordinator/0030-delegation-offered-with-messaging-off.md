# With agent messaging off, the coordinator is still told to delegate

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Include messaging in the availability check**: `coordinatorDelegationAvailable` also requires `agentMessaging.enabled`. Status: open.
2. **Say so in the panel**: show "Delegation unavailable: agent messaging is off" beside the Control MCP warning. Status: open.

### 1. Include messaging in the availability check

**Problem.** With messaging off the coordinator is told to launch workers, finish its turn and wait for a wake that cannot arrive.

**Context.** Messaging is on by default (`packages/protocol/src/agent-mail.ts:167`), so this affects users who turned it off.

**Investigation.** `apps/backend/src/core/index.ts:1168-1170` checks only `controlMcp.getSettings().running` and the platform's qualification. The prompt branches on it at `native-agent-service.ts:1300`. Mail tools register only when messaging is on (`control-mcp-tools.ts:584-588`, `:1967`), and `sendAgentMail` throws `messaging-disabled` (`storage-agent-mail.ts:470`). The check is synchronous and config reads are async.

**Decisions.**

- **How does the synchronous check read the setting?**
  - **Make the callback async and await it at `:1300`, which is already in an async function (recommended).**
    - Pros: reads the current setting, as `schedulingEnabled` does for the timers line in the same prompt.
    - Cons: one more config read per coordinator turn.
  - **Cache the setting and refresh it on config changes.**
    - Pros: stays synchronous.
    - Cons: a second copy of the setting that can go stale.

### 2. Say so in the panel

**Problem.** The panel explains Control MCP being off but not messaging being off.

**Context.** `CoordinatorSnapshot` carries `controlMcp` but no messaging state (`coordinator-service.ts:518-526`).

**Investigation.** The warning line is at `CoordinatorPanel.tsx:998-1004`.

**Decisions.** None: add the field to the snapshot, as `controlMcp` is, and render one more line in the same place.

## Related

- [Coordinator report, 4.3 (A1)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
- [0010-delegation-wake-loops-stop-on-first-error.md](0010-delegation-wake-loops-stop-on-first-error.md): `messaging-disabled` also aborts the wake pass
