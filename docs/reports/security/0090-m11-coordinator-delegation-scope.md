# Limit how far prompt injection can spread through the coordinator

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Limit delegation to environments the coordinator created**: unless the user opts in. Status: open.
2. **Mark delegations that came from worker mail**: so the recipient can tell. Status: open.

### 1. Limit delegation to environments the coordinator created

**Problem.** An injected worker can ask the coordinator to have environment B run something. B then follows it under B's own, possibly looser, policy, including environments the user created by hand.

**Context.** The limits the report names remain: worker mail is untrusted to the coordinator, with hop and hourly budgets, per-tab Off and mute.

**Investigation.** `send_coordinator_agent_mail` only requires the same project (`apps/backend/src/core/coordinator-worker-mail.ts:405-408`) and treats the project home specially. `coordinatorInvoker` checks the same, plus the project home (`apps/backend/src/core/control-mcp-server.ts:596-606`). A tab has `coordinatorOrigin` only when a coordinator conversation created its environment, and the route rule uses it (`packages/protocol/src/agent-mail.ts:213-232`), but a tab with no origin (a user's) still takes the `coordinator` route. So the data to draw the line exists, and nothing refuses on it.

**Decisions.**

- **Where should the line be?**
  - **Refuse by default for environments without this coordinator's origin, with a per-project setting to allow them (recommended).**
    - Pros: the report's fix; uses data already stored; the user chooses to widen.
    - Cons: a user who wants the coordinator to drive a hand-made environment must turn it on; breaks workflows that do this today.
  - **Hold such messages for approval, as the project home does.**
    - Pros: no setting; reuses `message-project-home`-style requests (`apps/backend/src/core/coordinator-worker-mail.ts:270-326`).
    - Cons: more prompts, and approval fatigue weakens the control.
  - **Leave it and rely on the framing and budgets.**
    - Pros: no work.
    - Cons: the recipient is told that this is an authenticated delegation (see task 2).

### 2. Mark delegations that came from worker mail

**Problem.** A recipient reads coordinator mail as "an authenticated delegation" and is told it may follow it (`packages/protocol/src/agent-mail.ts:940`, `:967`), even when the coordinator's turn began with a worker's untrusted message.

**Context.** The cross-node path already keeps this from being promoted: a leaf coordinator's answer stays in a carrier with untrusted framing (`docs/architecture/coordinator.md:201-203`, which cites M11). Local mail has no equivalent.

**Investigation.** No origin marking was found on outgoing coordinator mail. A conversation's `lastTurnOrigin` is already persisted before dispatch and is used to refuse an account-switch grant from a turn the user did not start (`apps/backend/src/core/control-mcp-coordinator-tools.ts:663`, `apps/backend/src/core/native-agent-service.ts:3744`).

**Decisions.**

- **How to mark it?**
  - **Use `lastTurnOrigin`: when it is not `user`, the framing says that the request arose from agent mail and is not the user's instruction (recommended).**
    - Pros: no new taint tracking; the signal is already reliable enough for a stronger use.
    - Cons: coarse: it also marks a delegation that merely happened during such a turn, and a later user turn clears the mark even if the content carried over.
  - **Track provenance per message through the turn.**
    - Pros: precise.
    - Cons: an agent's reasoning cannot be traced to specific input, so it would give a false sense of precision at high cost.

## Open questions

- Could some coordinator-only tools other than mail (`send_prompt_to_tab`, worker commands) need the same line? Task 1's check would naturally live beside `apps/backend/src/core/control-mcp-server.ts:596-606`, which covers arguments named `environmentId`, while mail uses `toEnvironmentId`, so both need it.

## Needs verification

- How often coordinators legitimately drive environments they did not create, which decides how disruptive task 1's default would be. Only usage shows that.

## Related

- [Security report, M11](../2-26-10-27-security.md#m11-prompt-injection-can-spread-worker--coordinator--another-worker-design)
- `docs/architecture/coordinator.md`, "Messaging the project home" (M10's outcome, the model for an approval)
