# Remote workers' sign-in prompts never reach the banner

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Show remote workers' prompts**: the panel's prompt banner covers workers on other nodes. Status: open.

### 1. Show remote workers' prompts

**Problem.** A worker on another node waiting on a sign-in link or code does not appear in the panel's banner. The person talking to the coordinator has to find it another way.

**Context.** The other half of this report item, the growing subscription set, is largely gone (see [Current state](#current-state)).

**Investigation.** `workerEnvironmentIds` excludes any association with a `nodeId` (`CoordinatorPanel.tsx:532-548`), and `useHumanPrompts` reads the local backend only (`apps/web/src/hooks/useUserCommands.ts:79-104`). The notice to the coordinator is also local: `noteWorkerHumanPrompt` filters out `nodeId` (`coordinator-service.ts:1367-1375`). The Work panel can show a remote worker's waiting state (`docs/architecture/coordinator.md:1025-1026`), but not the prompt itself.

**Decisions.**

- **How does the prompt cross?**
  - **Read `listHumanPrompts` through `invokeOnNode` per node, refreshed with node summaries, as the Work panel's remote reads do (recommended).**
    - Pros: no new protocol; the same freshness as other remote rows.
    - Cons: a sign-in link crossing nodes needs a check against what node summaries deliberately omit, and the delay is that of a summary refresh.
  - **Send the prompt as a status notice from the leaf.**
    - Pros: the coordinator hears it too.
    - Cons: new cross-node mail kinds, and it does not reach the banner by itself.

## Current state

- Retention now drops old finished records, so the set of environment ids no longer grows without limit (`b0dcf1660`, #1620). It still includes every kept association, including finished ones (`CoordinatorPanel.tsx:532-546`), which is harmless given the read is one list call.

## Needs verification

Whether a remote worker's prompt reaches the user by any other route in practice; needs two nodes.

## Related

- [Coordinator report, 4.4 (U13)](../2026-10-27-coordinator.md#44-ui-and-ux)
- [0395-coordinator-worker-surfaces-follow-ups.md](../../todo/coordinator-and-multi-review/0395-coordinator-worker-surfaces-follow-ups.md)
