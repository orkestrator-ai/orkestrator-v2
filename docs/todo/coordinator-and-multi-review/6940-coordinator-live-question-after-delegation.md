# A live coordinator turn that delegates and then asks the user

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da89`.

### Tasks

1. **Live delegate-and-ask scenario**: add an `ask` scenario to the live coordinator suite in which a coordinator turn launches a worker and asks the user a question in the same turn, and the harness answers the card. The billed Claude and Codex runs of it moved to the manual-test checklist. Status: open.

### 1. Live delegate-and-ask scenario

**Problem.** No live run shows a coordinator on a real model delegating to a worker and asking the user a question in one turn. Each half has evidence on its own, but the combination, where the question card must appear while the turn already holds a delegation, has only fake-provider evidence.

**Context.** Split out of [0001](../agent-engines/0001-agent-interactions-and-permissions.md) task 7 on 2026-11-06. That task added `e2e/InteractionPolicyChecks.spec.ts`, whose coordinator case runs the Claude bridge as a coordinator process with a fake SDK: the process authority makes the session `coordinator-read-only`, `mcp__orkestrator__*` is on the allow list, `launch_environment` passes the read-only PreToolUse hook, a Write is refused without a card, and an AskUserQuestion parks a card that survives a reload and is answered. It does not show that a real model chooses to ask after delegating, or that the CLI's own permission flow agrees with the bridge's hook. The live coordinator suite in [0024](0024-coordinator-live-conformance.md) covers delegation (`async`, `family`) and status wakes but has no scenario that asks the user anything.

**Investigation.** The suite's scenarios are listed in `apps/desktop/scripts/dev/coordinator-live.ts` (`COORDINATOR_LIVE_PLATFORMS` and the scenario prompts) and run through `mise run test:agent:coordinator` on an isolated profile with the provider's login. A question on Claude arrives as AskUserQuestion through `canUseTool`, which a coordinator's `deny` policy still lets through (`turnCanUseTool` handles questions before the policy check). Codex coordinators ask through `item/tool/requestUserInput`, which only parks when `default_mode_request_user_input` is on ([agent-engines.md](../../architecture/agent-engines.md#interaction-deadlines-and-pausing)). Building the scenario is agent work; its billed runs on Claude and Codex are on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md).

**Decisions.**

- **Where should the scenario live?**
  - **Add an `ask` scenario to the live coordinator suite: launch one worker, then ask the user to pick between two named options, and have the harness answer the card (recommended).**
    - Pros: reuses the suite's profile, teardown and per-platform loop; every platform that runs the suite gets the check.
    - Cons: a billed turn per platform; the harness must answer a card through the CLI or browser, which the suite does not do yet.
  - **A one-off manual run on Claude, recorded in this file.**
    - Pros: no harness work.
    - Cons: not repeated on provider bumps; one platform only.
- **Which platforms first?**
  - **Claude and Codex (recommended).**
    - Pros: the two default coordinator platforms; both have a parked-question path the backend already maps.
    - Cons: Codex needs its question feature flag to park (`codexRequestUserInputConfig`).
  - **Every coordinator platform.**
    - Pros: complete.
    - Cons: Grok has no login on the qualifying hosts (0024 task 1).

## Related

- [0001-agent-interactions-and-permissions.md](../agent-engines/0001-agent-interactions-and-permissions.md) task 7 (the fake-provider check).
- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md) (the live coordinator suite).
- [agent-engines.md](../../architecture/agent-engines.md#interaction-deadlines-and-pausing) (Codex questions; was todo 0161, deleted 2026-11-06).
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 1: the billed Claude and Codex runs of the `ask` scenario) moved there on 2026-11-10.
