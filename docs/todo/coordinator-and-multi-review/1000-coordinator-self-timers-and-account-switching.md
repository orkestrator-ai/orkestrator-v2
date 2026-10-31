# Coordinator self-timers and provider-account switching

## Task analysis

Analysed 2026-10-30 against `main` at `361dc0a6`.

### Tasks

1. **Self-timers on the existing scheduler**: `create_schedule` action type `remind_me`, delivered to the setting conversation, relative and absolute times in the user's zone, limits, restart persistence. Status: done.
2. **List and switch provider accounts**: `list_provider_accounts` and `switch_provider_account` through the Settings switch path, with a user-approved request by default and a self-timer permission as the one exception. Status: done.
3. **Usage-limit reader**: `get_usage_limits` across the project's environments without bridge or transcript reads. Status: done.
4. **Live qualification of the scenario**: a real Claude and Codex coordinator sets a timer, is woken, finds a limited worker and switches, on an isolated `dev:test` profile with two logins. Status: open (depends on 1, 2 and 3; needs live providers).
5. **Structured usage-limit signal from the bridges**: carry Codex's `usageLimitExceeded` code and Claude's rate-limit status to the backend instead of classifying error text. Status: open.
6. **The user's zone when the coordinator's machine is not the user's**: absolute times use the backend host's zone. Status: open.
7. **Show a timer's permission and a coordinator's switches to the user**: Settings → Schedules and the account views do not mark either. Status: open.
8. **Resume limited workers after a switch**: the coordinator must prompt each limited tab itself. Status: open (depends on 5).

### 1. Self-timers on the existing scheduler

**Problem.** Coordinators were woken only by mail and workflow notices. A reminder to `"coordinator"` already existed (`send_message` with `toEnvironmentId: "coordinator"`), but a side agent sending to `"coordinator"` reached the main coordinator, not itself; nothing bounded how many reminders or how far ahead; and the result did not say which zone an absolute time used.

**Context.** `apps/backend/src/core/scheduled-jobs/tools.ts` (the `remind_me` type, `timeZoneUsed`, `nextFireLocal`, the default `Self-timer: …` name), `control-mcp-coordinator-tools.ts` (`coordinatorScheduleBackend().selfTimer`, which resolves the conversation's own address), `scheduled-jobs/service.ts:413` (`assertSelfTimerLimits`) and `:123` (`assertSelfTimerDelay`), `packages/protocol/src/scheduled-jobs.ts` (`maxSelfTimerDelayMs`, `maxPendingSelfTimers`). Delivery is the executor's `remind()` (`executor.ts`), a system `workflow` notice through `sendAgentMail`.

**Investigation.** A schedule could already target a coordinator's own conversation through `isReminderToSelf`; one-shot `at` already took `+2h` and `14:30`; schedules already survive restarts (one store row each). Mid-turn, a system notice is held by the mail drain (`agent-mail-service.ts`, held reason `busy`) and delivered when the session is idle; system senders never steer. Tests: `coordinator-timers-and-accounts.test.ts` ("self-timers").

**Decisions.** See Assumptions and decisions: "Self-timer target", "Timer limits", "Firing while busy".

### 2. List and switch provider accounts

**Problem.** A worker that hit a usage limit stayed stuck until the user switched accounts by hand.

**Context.** `apps/backend/src/core/control-mcp-account-tools.ts` (tools at `:183`, `:213`, `:315`; `machineFor` at `:79`; `timerPermission` at `:267`), `nodes/node-account-switch.ts` (the approved request's executor), the `switch-agent-account` kind in `nodes/node-action-requests.ts` and `node-coordination.ts`, and `NodeActionRequestsDialog.tsx`. The switch is `set_active_agent_account` (`agent-accounts.ts` `setActiveAgentAccount`), the command Settings calls.

**Investigation.** Accounts are per machine and per platform (`agent-accounts.json`, `active[platform]`); only Claude and Codex have them. A switch records the choice and kills nothing; idle bridges are replaced on next use, busy ones when idle (`localBridgeIsOnActiveAccount`). Todo 0722 decision (c) says a switch must be the user's act because it changes who is billed. Tests: `coordinator-timers-and-accounts.test.ts` ("provider accounts", the scenario), `nodes/node-account-switch.test.ts`, `nodes/node-coordination.test.ts` (the sanitizer and executor), `node-action-requests.test.tsx`.

**Decisions.** See Assumptions and decisions: "Switch scope", "Safety", "Other machines".

### 3. Usage-limit reader

**Problem.** Nothing classified a usage-limit failure; a coordinator would have had to read every tab live.

**Context.** `apps/backend/src/core/agent-usage-limits.ts:79` (`readProjectUsageLimits`, command `get_project_usage_limits`), `packages/protocol/src/agent-usage-limits.ts` (`classifyUsageLimitError`, `exhaustedUsageWindows`).

**Investigation.** The one durable record of a failed turn is the session's `turnOutcomes` (bounded error text, written for every backend-dispatched prompt). Bridges reduce usage limits to error strings: Codex's `codexErrorInfo` code is dropped at `bridges/codex-bridge/src/sessions/thread-registry.ts:664` (`setPhase` keeps a string), Claude's `rate_limit_event` status is not read. Plan windows are cached per platform for the active account (`plan-usage-cache.ts`). Tests: `agent-usage-limits.test.ts` (backend and protocol).

**Decisions.** See Assumptions and decisions: "Usage-limit reader".

### 4. Live qualification of the scenario

**Problem.** No real coordinator has used these tools.

**Context.** The live coordinator suite (`apps/desktop/scripts/dev/coordinator-live.ts`) has scenarios `read-only`, `async`, `family`, `status`, `peer`.

**Investigation.** A real run needs two signed-in logins of one provider in an isolated profile, and a worker that genuinely hits a usage limit, which cannot be produced on demand without spending a plan. The parts that can be qualified cheaply are: the model choosing `remind_me` with the right body for the scenario prompt, the timer waking it, `get_usage_limits` on a seeded failed turn outcome, and the approval request appearing in the real dialog.

**Decisions.**

- **How to qualify without burning a plan?**
  - **Seed the failure, run the rest live (recommended).** A `coordinator-live.ts` scenario `account-switch` that writes a usage-limit `turnOutcomes` entry into a worker session of the disposable profile, gives the profile two fake account directories (signed-in state only, no real login), and checks the coordinator sets a timer, is woken, lists, and files a `switch-agent-account` request (and switches directly with a granted timer).
    - Pros: exercises every tool and the model's use of them; no real switch of anyone's login; cheap.
    - Cons: the usage-limit text is ours, not a provider's; `get_agent_account_usage` returns `unavailable` for fake accounts.
  - **Wait for a real limit.**
    - Pros: fully real.
    - Cons: needs an exhausted plan and a second paid login; unrepeatable.

### 5. Structured usage-limit signal from the bridges

**Problem.** The reader matches error text. A provider rewording its message would hide a limit.

**Context.** Codex `codexErrorInfoToCode` (`bridges/codex-bridge/src/app-server/errors.ts`), `EngineError.code`; Claude's `rate_limit_event` handling in the Claude bridge's prompt handlers; `ProviderSessionStateSnapshot.error` (`apps/backend/src/core/agent-provider-contract.ts`).

**Investigation.** The Codex code survives only in a transient `session.warning`; the Claude SDK's allowed/rejected status is not read. Both would need a protocol field (`errorCode`) on the session snapshot and on `PersistedNativeAgentTurnOutcome`.

**Decisions.**

- **Where to carry it?**
  - **An optional `failureKind: "usage-limit"` on the persisted turn outcome, filled from a bridge `errorCode` when present and from the text classifier otherwise (recommended).**
    - Pros: one place for readers; old records still classify by text.
    - Cons: touches every bridge's session snapshot and the bridge contract tests.
  - **Keep text classification only.**
    - Pros: no bridge change.
    - Cons: silent miss when wording changes.

### 6. The user's zone when the coordinator's machine is not the user's

**Problem.** `at: "14:30"` is read in the backend host's zone. For a coordinator on the user's own machine that is the user's zone; for one on a leaf in another zone it is not.

**Context.** `ScheduledJobService` option `defaultTimeZone` (host zone), the tool description built from `hostTimeZone()` in `scheduled-jobs/tools.ts`.

**Investigation.** No user or client time zone is stored anywhere; the renderer knows its own zone. The result's `timeZoneUsed` and `nextFireLocal` make the zone visible, so a wrong guess is reported rather than silent.

**Decisions.**

- **Where to get the user's zone?**
  - **Record the zone of the client that sent the user's latest prompt on the coordinator conversation, and default to it (recommended).**
    - Pros: right even across machines; no setting.
    - Cons: needs a renderer field on prompt dispatch; a user travelling changes it.
  - **A global "time zone" setting.**
    - Pros: explicit.
    - Cons: one more setting nobody sets.

### 7. Show a timer's permission and a coordinator's switches to the user

**Problem.** The user sees a granted timer only as an ordinary schedule in Settings → Schedules, and a switch made under a timer's permission only in the coordinator's report and the account views' new active account.

**Context.** `SchedulesSettings.tsx`; the account views listen to `agent-accounts-changed`.

**Investigation.** The permission is `action.input.grant` on the schedule; nothing in the renderer reads it. A switch with permission creates no request record.

**Decisions.**

- **How to make an unattended switch visible?**
  - **Record it as an already-executed `switch-agent-account` request and badge granted timers in Settings → Schedules (recommended).**
    - Pros: one history for every switch a coordinator made; the user can see and cancel a timer that may switch.
    - Cons: an executed request in a list that today holds only pending ones needs a "recent" view.
  - **Rely on the coordinator's report.**
    - Pros: nothing to build.
    - Cons: a report the user did not read leaves no trace.

### 8. Resume limited workers after a switch

**Problem.** A tab that stopped on a usage limit does not run again by itself after the switch.

**Context.** `get_usage_limits` returns `nextStep` telling the coordinator to prompt each tab (`send_prompt_to_tab`).

**Investigation.** The coordinator can already do it; the risk is a coordinator that forgets, or prompts a tab whose turn was not actually limited.

**Decisions.**

- **Who resumes?**
  - **The coordinator, guided by the tool results (recommended).**
    - Pros: no new automation that spends turns on its own.
    - Cons: depends on the model following `nextStep`.
  - **An option on `switch_provider_account` to prompt the listed tabs.**
    - Pros: one call.
    - Cons: a switch tool that also spends turns is harder to approve.

## Assumptions and decisions

### Self-timer target (task 1)

- **Options.** (a) A new `set_timer` tool family. (b) Reuse `send_message` to `"coordinator"`. (c) A `remind_me` action type on `create_schedule`.
- **Choice.** (c), resolving to the existing reminder-to-self path.
- **Why.** The task says extend the scheduler, not build a second one, and a reminder to self already delivers through the coordinator mail and wake path. A separate action type lets the backend pick the address (a side agent's `"coordinator"` means the main coordinator, so (b) could not return a side agent's timer to itself) and is the only place the account-switch permission can be stamped.

### Timer limits (task 1)

- **Options.** Maximum delay 24 hours, 7 days or 30 days; pending cap 10, 20 or the general 50.
- **Choice.** 7 days ahead for a one-shot, 20 active self-timers per owner (the main coordinator, or each side agent); the general limits (50 per owner, 1 000 in all) still apply. Listing and cancelling are the existing `list_schedules` and `cancel_schedule`; persistence is the existing store.
- **Why.** "Check in 2 hours" and "after the weekly reset" both fit in 7 days; a forgotten timer a month out is more likely a mistake. 20 leaves room for several workflows' checks while stopping a loop that sets a timer every turn.

### Firing while busy (task 1)

- **Options.** Queue like mail; steer into the running turn; drop.
- **Choice.** Queue: a reminder is system mail, held by the mail drain while the coordinator is busy and delivered when it is idle, together with any other waiting mail.
- **Why.** It matches mail and workflow notices, needs no new code, and a reminder steered into a turn about something else would be missed or derail it. The permission window (2 hours from delivery) is long enough for a turn to finish.

### Switch scope (task 2)

- **Options.** Machine-wide; per environment.
- **Choice.** Machine-wide per provider, because that is the only scope accounts have: no tab, environment or settings tier records an account. Running sessions are not restarted: idle ones move on their next turn, a running turn finishes on the old account. Every tool result says so (`scope: "machine"`, `effect`).
- **Why.** Per-environment accounts would need a new account dimension in bridge keys, tab records and settings tiers, which the accounts design deliberately avoids.

### Safety (task 2)

- **Options.** (a) Always ask the user (a `switch-agent-account` request like `request_environment_deletion`). (b) Allow automatically when the timer prompt asked for it. (c) Ask, unless the switch was requested in the user's own instruction that the timer carries.
- **Choice.** (c), as recommended. Without permission, `switch_provider_account` files a request the user approves in the coordinator-request dialog; the approved request runs `set_active_agent_account` and mails the outcome back. A self-timer carries permission only when the main coordinator sets it with `authorizeAccountSwitch` in a turn the user started: the backend now records each coordinator conversation's `lastTurnOrigin` at dispatch (`user` for a prompt the user sent, `mail` for mail, status wakes and fired timers; recovery keeps the previous value), and the schedule backend refuses the permission unless it is `user`. The permission names providers and any other machines, carries the user's words, cannot be passed through a `tool` action, and is honoured for 2 hours after the timer fires.
- **Why.** (a) defeats the scenario when nobody is there in two hours. (b) would let any timer, including one a prompt-injected mail turn set, change billing. (c) ties the permission to the user's own turn with a check the model cannot fake. Residual risk: within a user turn the coordinator may misread the user's intent, and a steered message from a side agent can reach a user-started turn; the user's words are recorded and shown in the reminder and the switch result.

### Other machines (task 2)

- **Options.** This machine only; any node through the node link.
- **Choice.** Built: `nodeId` on both account tools, routed through `invoke_on_node` (accounts belong to the machine, so a node needs no copy of the project). A timer's permission covers another machine only if `nodeIds` names it.
- **Why.** Settings → Machines already switches nodes this way, so it was cheap and reuses the same command.

### Usage-limit reader (task 3)

- **Options.** (a) Classify at the time the outcome is recorded and persist a kind. (b) Classify at read time from the persisted error text. (c) Read every tab live through `get_tab_state`.
- **Choice.** (b), plus the plan-usage cache's exhausted windows for the active accounts.
- **Why.** No schema change, works on records written before this change, and costs one storage listing. (c) costs a bridge read per tab. Task 5 records the stronger signal later.

## Current state

A coordinator can set a timer that prompts itself later ("in 2 hours", "at
14:30"), find workers that stopped on a provider usage limit, list the
machine's Claude and Codex logins with their remaining plan usage, and switch
the active login. The scenario it supports end to end: "Check the
environments in 2 hours. See if any of them have hit usage limits, then
switch to another account that has usage allocation left." Everything has
deterministic evidence only.

The tools are offered to every main coordinator: `get_usage_limits` with
capability `environments`, the account tools with the new capability
`accounts`. `remind_me` needs the experimental scheduling switch, like every
schedule tool.

## Outstanding work

Tasks 4 to 8 above.

## Constraints and rationale

- Never write a credential: every switch is `set_active_agent_account`.
- Tests use fakes only: no real `~/.claude`, `~/.codex` or `~/.pi`, no billed turns.

## Needs verification

- Task 4 in full. Until then nothing shows a real model choosing `remind_me`, or a real approval dialog for `switch-agent-account` on screen.

## Related

- [0722-per-machine-agent-accounts.md](../agent-engines/0722-per-machine-agent-accounts.md) decision (c), why a switch is the user's act.
- [0003-agent-accounts-and-sign-in.md](../agent-engines/0003-agent-accounts-and-sign-in.md).
- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md), where task 4's scenario would live.
- `docs/architecture/scheduled-jobs.md` (Self-timers), `docs/architecture/agent-accounts.md` (Coordinator switching), `docs/architecture/coordinator.md`.
