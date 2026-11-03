# Side agents can call `adopt_workflow`

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Refuse adoption from a side agent**: a side conversation cannot move a workflow to itself. Status: open.

### 1. Refuse adoption from a side agent

**Problem.** `adopt_workflow` is a write offered under `discovery`, so side agents have it. They can reassign a workflow and clear its notice state.

**Context.** The impact is smaller than the report says. It claims a side agent that adopts a build "then receives its wakes", but status notices always go to the main (`coordinator-status-wakes.ts:1940-1953`), delegation wakes too (`coordinator-service.ts:1198-1199`), and `ensureMainConversation` force-moves live work back to the main (`:315`, `:349-380`). What remains: until that next ensure, `association.conversationId` names the side agent, and `lastNotifiedRevision`, `terminalNotifiedAt` and `statusNotice` are cleared (`storage-coordinators.ts:1065-1067`). A repeat notice to the same main is deduplicated by its request id (`coordinator-status-wakes.ts:1952`).

**Investigation.** The tool is granted at `control-mcp-tools.ts:130` and registered at `control-mcp-coordinator-tools.ts:228`. `adopt_coordinator_workflow` (`commands-registry-coordinator.ts:408-422`) and the store (`storage-coordinators.ts:1023-1059`) have no role check. Mail from a side agent is checked by role at `coordinator-worker-mail.ts:400`.

**Decisions.**

- **Where to refuse?**
  - **In the `adopt_coordinator_workflow` command (recommended).**
    - Pros: covers every caller of the command; `force` from the backend does not go through it, so main takeover is unaffected.
    - Cons: the tool stays listed, so a side agent learns only on calling it.
  - **Regrant the tool under a main-only capability.**
    - Pros: the tool disappears from the side agent's list, and one tool leaves its schemas.
    - Cons: no capability fits exactly; `environments` would be misleading here. Doing both is reasonable.

## Current state

- The report's doc drift is fixed: `docs/architecture/coordinator.md:351-353` now lists `discovery`, `mail` and `schedules` (`3fa7d1733`, #1436).

## Related

- [Coordinator report, 4.1 (S2)](../2026-10-27-coordinator.md#41-security-and-boundary)
