# Coordinator self-timers and account switching: decisions

Status: Living — what was built for coordinator self-timers, usage limits and
provider-account switching, where each part is tested, and the decisions
behind it. Folded in from to-do 1000 (retired 2026-11-13, once its last agent
task, the live suite's `account-switch` scenario, was built; read it with
`git show 17d28238c:docs/todo/coordinator-and-multi-review/1000-coordinator-self-timers-and-account-switching.md`).
The behaviour itself is described in
[agent-accounts.md](agent-accounts.md#coordinator-switching) and
[scheduled-jobs.md](scheduled-jobs.md). The live runs still owed (the
scenario's billed run on real Claude and Codex coordinators, and real
providers' usage-limit signals) are on the
[manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md),
cited as `1000 (retired)`.

## What was built

### 1. Self-timers on the existing scheduler

**Problem.** Coordinators were woken only by mail and workflow notices. A reminder to `"coordinator"` already existed (`send_message` with `toEnvironmentId: "coordinator"`), but a side agent sending to `"coordinator"` reached the main coordinator, not itself; nothing bounded how many reminders or how far ahead; and the result did not say which zone an absolute time used.

**Context.** `apps/backend/src/core/scheduled-jobs/tools.ts` (the `remind_me` type, `timeZoneUsed`, `nextFireLocal`, the default `Self-timer: …` name), `control-mcp/coordinator-tools.ts` (`coordinatorScheduleBackend().selfTimer`, which resolves the conversation's own address), `scheduled-jobs/store.ts:109` (the pending self-timer cap) and `scheduled-jobs/service.ts:130` (`assertSelfTimerDelay`), `packages/protocol/src/scheduled-jobs.ts` (`maxSelfTimerDelayMs`, `maxPendingSelfTimers`). Delivery is the executor's `remind()` (`executor.ts`), a system `workflow` notice through `sendAgentMail`.

**Investigation.** A schedule could already target a coordinator's own conversation through `isReminderToSelf`; one-shot `at` already took `+2h` and `14:30`; schedules already survive restarts (one store row each). Mid-turn, a system notice is held by the mail drain (`agent-mail-service.ts`, held reason `busy`) and delivered when the session is idle; system senders never steer. Tests: `coordinator-timers-and-accounts.test.ts` ("self-timers").

**Decisions.** See Assumptions and decisions: "Self-timer target", "Timer limits", "Firing while busy".

### 2. List and switch provider accounts

**Problem.** A worker that hit a usage limit stayed stuck until the user switched accounts by hand.

**Context.** `apps/backend/src/core/control-mcp/account-tools.ts` (tools registered from `:388`; `machineFor` at `:112`; `timerPermission` at `:574`), `nodes/node-account-switch.ts` (the approved request's executor), the `switch-agent-account` kind in `nodes/node-action-requests.ts` and `node-coordination.ts`, and `NodeActionRequestsDialog.tsx`. The switch is `set_active_agent_account` (`agent-accounts.ts` `setActiveAgentAccount`), the command Settings calls.

**Investigation.** Accounts are per machine and per platform (`agent-accounts.json`, `active[platform]`); only Claude and Codex have them. A switch records the choice and kills nothing; idle bridges are replaced on next use, busy ones when idle (`localBridgeIsOnActiveAccount`). Todo 0722 decision (c) says a switch must be the user's act because it changes who is billed. Tests: `coordinator-timers-and-accounts.test.ts` ("provider accounts", the scenario), `nodes/node-account-switch.test.ts`, `nodes/node-coordination.test.ts` (the sanitizer and executor), `node-action-requests.test.tsx`.

**Decisions.** See Assumptions and decisions: "Switch scope", "Safety", "Other machines".

### 3. Usage-limit reader

**Problem.** Nothing classified a usage-limit failure; a coordinator would have had to read every tab live.

**Context.** `apps/backend/src/core/agent-usage-limits.ts:119` (`readProjectUsageLimits`, command `get_project_usage_limits`), `packages/protocol/src/agent-usage-limits.ts` (`classifyUsageLimitError`, `usageLimitFailure`, `exhaustedUsageWindows`).

**Investigation.** The one durable record of a failed turn is the session's `turnOutcomes` (bounded error text, written for every backend-dispatched prompt). When this was built, bridges reduced usage limits to error strings (Codex's `codexErrorInfo` code was dropped in `setPhase`, Claude's `rate_limit_event` status was not read); task 5 changed that. Plan windows are cached per platform for the active account (`plan-usage/cache.ts`). Tests: `agent-usage-limits.test.ts` (backend and protocol).

**Decisions.** See Assumptions and decisions: "Usage-limit reader".

### 4. Live qualification of the scenario

**Problem.** No real coordinator has used these tools.

**Context.** The live coordinator suite (`apps/desktop/scripts/dev/coordinator-live.ts`); see [Live coordinator suite](../development/agent-testing.md#live-coordinator-suite).

**Investigation.** A real run needs two signed-in logins of one provider in an isolated profile, and a worker that genuinely hits a usage limit, which cannot be produced on demand without spending a plan. The parts that can be qualified cheaply are: the model choosing `remind_me` with the right body for the scenario prompt, the timer waking it, `get_usage_limits` on a seeded failed turn outcome, and the approval request appearing in the real dialog.

Built 2026-11-13 as the recommended option below: the `account-switch`
scenario (the `account-switch` case under "Live coordinator suite" in
[`agent-testing.md`](../development/agent-testing.md#live-coordinator-suite)),
tested over a scripted transport (`coordinator-live-account-switch.test.ts`).
Its billed run on real Claude and Codex coordinators is on the manual-test
checklist, cited as `1000 (retired)` task 4.

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

**Context.** Codex `codexErrorInfoToCode` (`bridges/codex-bridge/src/app-server/errors.ts`), `EngineError.code`, `ThreadContext.errorCode` (`sessions/thread-registry.ts`) and `getStatus` (`app-server-runtime-sessions.ts`); Claude's `handleRateLimitEvent` (`session-manager-prompt-handlers/leaf.ts`), `TurnState.rateLimitRejected` and the failure path in `session-manager-prompt-settle.ts`, served by `GET /session/:id` (`routes/session.ts`); the backend's `throwExplainedTurnFailure` (`http-bridge-transport.ts`), `ProviderSessionFailedError.failureKind` and `readProviderStatus` (`agent-provider-contract.ts`), `PersistedNativeAgentTurnOutcome.failureKind` (`models.ts`, stored by `storage-native.ts`), `turnOutcomeFailureKind` (`agent-usage-limits.ts`).

**Investigation.** Re-checked 2026-11-05: still open. The Codex code survived only in a transient `session.warning`; the Claude SDK's `rate_limit_info.status` (`allowed`, `allowed_warning`, `rejected`) was not read, although the bridge already carried a refusal's words as the turn's error when the text classified (`result.ts`). Besides the coordinator's reader, the automatic switcher (`handleLimitStop`, `noteUnresentStop`), the native resend and four workflow call sites classified the same text, so they were given the structured kind too. Tests: `bridges/codex-bridge/src/app-server-runtime-usage-limit.test.ts`, `bridges/claude-bridge/src/services/session-manager-prompt-usage-limit.test.ts`, `routes/session.test.ts` ("reports a usage-limit errorCode…"), `apps/backend/src/core/http-bridge/usage-limit-signal.test.ts` (including an older bridge without the code), `native-agent-service-turn-outcome.test.ts` ("the drain records a bridge's usage-limit code, and an older bridge's limit by its text", "an observer returns and keeps…"), `agent-usage-limits.test.ts` (backend and protocol), `agent-accounts-auto-switch.test.ts` ("the bridge's usage-limit code counts whatever the wording").

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

**Context.** `ScheduledJobService` option `defaultTimeZone` (host zone); `ScheduleToolBackend.defaultTimeZone` and `timeZoneUsed` in `scheduled-jobs/tools.ts`; `coordinatorScheduleBackend().defaultTimeZone` (`control-mcp/coordinator-tools.ts`); `CoordinatorWorkspace.userTimeZone` (`packages/protocol/src/coordinator.ts`), written in the coordinator dispatch mutation of `native-agent-prompt-dispatch.ts`; `DispatchNativeAgentPromptInput.clientTimeZone` (validated in `commands-validation.ts`, carried by the queue drain); the renderer's `dispatchNativeAgentIntent` (`apps/web/src/lib/backend/workflows.ts`) and `enqueue` (`useNativeAgentSession.ts`).

**Investigation.** Re-checked 2026-11-05: still open; no user or client zone was stored anywhere. The result's `timeZoneUsed` and `nextFireLocal` already made the zone visible. Tests: `native-agent-service-base.test.ts` (the coordinator dispatch test records `Asia/Tokyo` from a user turn and keeps it on a mail turn), `coordinator-timers-and-accounts.test.ts` ("an absolute time is read in the zone of the device the user last prompted from"), `commands-validation.test.ts` ("keeps a client time zone this runtime can name…"), `native-agent-prompt-queue-dispatcher.test.ts` (the queued zone reaches dispatch), web `workflows.commands.test.ts`, `backend.test.ts` and `useNativeAgentSession.commands.test.tsx`.

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

**Context.** `SchedulesSettings.tsx` (`AccountSwitchPermissionBadge`); `CoordinatorAccountSwitchGrant.tsx` (the list under the tick) and `CoordinatorAccountSwitchNotices.tsx` (the toast); `run_timer_agent_account_switch` (`commands-registry-nodes.ts`) → `runTimerAccountSwitch` (`nodes/node-account-switch-grant.ts`) → `NodeActionRequests.runUnattended` (`authorizedBy: "self-timer"`, `selfTimer`); the `scheduleId` branch of `switch_provider_account`.

**Investigation.** Re-checked 2026-11-05: half done. The standing permission (2026-11-04) already recorded its switches as executed requests, toasted them and listed them under the tick, which was this task's recommended history. A timer's switch still called `set_active_agent_account` directly with no record, and nothing in the renderer read `action.input.grant`. Tests: `coordinator-timers-and-accounts.test.ts` (the scenario now checks the record, the event, the listing and a retry), `nodes/node-action-requests.test.ts` ("a self-timer's switch is recorded with the timer, outside the standing permission's limit"), web `SchedulesSettings.test.tsx` (the badge, its window and lapse) and `CoordinatorAccountSwitchGrant.test.tsx` ("a switch a self-timer's permission allowed says so…").

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

**Context.** `get_usage_limits` returns `nextStep` telling the coordinator to prompt each tab (`send_prompt_to_tab`); `resumeAfterSwitch` and the `resumeTabs` read in `control-mcp/account-tools.ts`; `requesterFollowUp` in `nodes/node-coordination.ts` (the mail for an approved switch); `COORDINATOR_TIMERS_AND_ACCOUNTS_RULE`.

**Investigation.** Re-checked 2026-11-05: still open for a coordinator's own switch. Automatic switching (built since) resends what the weekly limit stopped by itself (`NativeAgentUsageLimitResend`), but a coordinator's switch pins the account and turns that off, so its limited tabs still needed a prompt; the switch result only said "Tabs stopped on a usage limit need a new prompt". The risks were a coordinator that forgets, or prompts a tab whose turn was not limited; task 5's structured signal and the per-provider list address the second. Tests: `coordinator-timers-and-accounts.test.ts` (the switch lists only the limited Claude tab, not a limited Codex one), `coordinator-account-switch-grant.test.ts` (`resumeStep` on the standing permission's switch), `nodes/node-coordination.test.ts` (the approval mail), `agent-usage-limits.test.ts` ("after a switch the coordinator is told to resume exactly the limited tabs").

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

### Standing permission (tasks 2 and 7)

Added 2026-11-04 after two approval requests waited about 4.5 hours overnight while seven build pipelines failed on the 5-hour limit.

- **Options.** (a) Keep only the self-timer permission. (b) A per-provider Settings tick, held on the coordinator's machine, covering its switches there and on the machines it controls. (c) The same tick, plus a per-target-machine list.
- **Choice.** (b), with guardrails: signed-in target only, never one whose reading shows a used-up window, at most 3 per target machine and provider per rolling hour (then an approval request with `askedBecause`). Each switch is recorded as an executed `switch-agent-account` request (`authorizedBy: "standing-grant"`), toasted, and listed under the tick. It pins like any manual switch.
- **Why.** (a) needs the user to foresee the night. (c) adds a list nobody asked for: the user's case was two machines at once, and Settings' machine picker already lets a leaf hold its own choice for its own coordinators. Recording as a request reuses task 7's recommended history and gives the limit a durable count. See [agent-accounts.md](agent-accounts.md#switching-without-asking).
- **Evidence per acceptance criterion** (ticket b5ebc08b). Backend tests are in `apps/backend/src/core/coordinator-account-switch-grant.test.ts` ("grant test") unless named otherwise; all use fake accounts.

  | Criterion | Where it is built | Test |
  | --- | --- | --- |
  | 1. Per-provider tick, off by default, persisted | `CoordinatorAccountSwitchGrant.tsx` in each provider's accounts pane; `coordinatorAccountSwitchGrant` config key written only by `set_coordinator_account_switch_grant` | grant test "is off by default, per provider, and persisted"; `storage-config.test.ts` "keeps the coordinator account-switch permission across settings saves and restarts"; `CoordinatorAccountSwitchGrant.test.tsx` "is off by default, and ticking it grants the provider on this machine" |
  | 2. Granted: switches at once, here and with `nodeId` | `switch_provider_account` → `run_granted_agent_account_switch` → `NodeActionRequests.runUnattended` | grant test "granted: switches at once on this machine, recorded and shown to the user" and "granted: switches a controlled machine with nodeId through the node link" |
  | 3. Off: approval request and self-timer unchanged | the `scheduleId` branch runs before the grant is read and is not modified | grant test "not granted: the switch is a request the user approves, as before"; the unmodified `coordinator-timers-and-accounts.test.ts` (timer scenario, lapse, other machine, other provider) |
  | 4. Signed-out or known-exhausted target refused | the `signedIn` check and `refuseExhausted` | grant test "refuses a signed-out or known-exhausted account even with the grant" and "an account with no usage reading is not treated as exhausted" |
  | 5. Over the hourly cap: approval request with a reason | `COORDINATOR_ACCOUNT_SWITCH_LIMIT` (3 per machine and provider per hour), `askedBecause` | grant test "past the hourly limit it asks the user and says why"; `node-action-requests.test.ts` (backend) "unattended runs take the limit and the record together, and never mail"; web `node-action-requests.test.tsx` "an account switch past the standing permission's limit says why it asks" |
  | 6. Each switch recorded and shown with machine, accounts, coordinator, reason | executed request with `authorizedBy: "standing-grant"`; `CoordinatorAccountSwitchNotices` toast; list under the tick | grant test "granted: switches at once on this machine, …" (record and event payload); `CoordinatorAccountSwitchGrant.test.tsx` "lists each switch with machine, accounts, coordinator and reason" and "the notice names the machine, both accounts, the coordinator and the reason" |
  | 7. Turning it off makes the next call ask | the grant is read on every call; `run_granted_agent_account_switch` reads it again | grant test "turning it off makes the next call ask again" and "the grant command refuses to record a switch while the permission is off" |
  | 8. Tool description and docs explain it; tests cover the cases | tool description in `control-mcp/account-tools.ts`, `COORDINATOR_TIMERS_AND_ACCOUNTS_RULE`, `agent-accounts.md`, `coordinator.md`, `control-mcp.md` | grant test "the tool description says when no approval is needed"; the rows above cover granted, not granted, cap, refused target and remote machine |

### Usage-limit reader (task 3)

- **Options.** (a) Classify at the time the outcome is recorded and persist a kind. (b) Classify at read time from the persisted error text. (c) Read every tab live through `get_tab_state`.
- **Choice.** (b), plus the plan-usage cache's exhausted windows for the active accounts.
- **Why.** No schema change, works on records written before this change, and costs one storage listing. (c) costs a bridge read per tab. Task 5 records the stronger signal later.

### Where the signal is carried (task 5)

- **Options.** (a) The recommended `failureKind: "usage-limit"` on the persisted turn outcome, filled from a bridge `errorCode` when present and from the text classifier otherwise. (b) Text classification only.
- **Choice.** (a). Each bridge answers `errorCode: "usage-limit"` beside `error` only while the session is failed, and clears it with the error. Readers use `usageLimitFailure`, which takes the kind when present and the text otherwise, so a record written before the field still classifies.
- **Why.** As the file recommended. The contract-test cost turned out small: only the Claude and Codex snapshots gained a field, and the backend's single parse point (`throwExplainedTurnFailure`) reads it.

### What counts as Claude's signal (task 5)

- **Options.** (a) A `rate_limit_event` with `status: "rejected"` in the failed turn. (b) An assistant message with `error: "rate_limit"`.
- **Choice.** (a), applied only if the turn then fails, and never for a killed process.
- **Why.** The ticket names the rate-limit status. `rate_limit` on an assistant message also covers a transient 429 for an API-key user, which is not a plan allowance; the SDK sends `rate_limit_event` to subscription users only.

### Which consumers take the signal (task 5)

- **Options.** (a) The coordinator's reader only, as the problem statement names. (b) Also the automatic switcher, the native resend and the four workflow call sites, which classified the same text.
- **Choice.** (b).
- **Why.** Each is a one-field addition (`failureKind` beside `error`), and leaving them on text would keep the silent miss the task exists to remove for the path that acts without a coordinator.

### Older bridges (task 5)

- **Choice.** No version check: a snapshot without `errorCode` is classified by its text, as before. A Claude or Codex outcome recognised from text alone is counted (`usage-limit.text-classified`) and listed in the version-compatibility register. The text path itself is permanent, since four providers have no signal.

### Where the user's zone comes from (task 6)

- **Options.** (a) The recommended zone of the client that sent the user's latest prompt. (b) A global setting.
- **Choice.** (a). The renderer sends `clientTimeZone` with every native dispatch and queued prompt; only a coordinator dispatch whose origin is `user` records it, on the workspace (`userTimeZone`), so any of its conversations sets it for all. An unknown zone is dropped at the command, never a refusal. Until one is seen the host's zone is used and `timeZoneUsed` says the user's zone is not known yet.
- **Why.** As recommended. On the workspace rather than per conversation, because the zone belongs to the user, not to a conversation; a side agent's timer then uses the zone the user last typed from anywhere in that coordinator.

### Recording a timer's switch (task 7)

- **Options.** (a) The recommended executed `switch-agent-account` request plus a Schedules badge. (b) Rely on the coordinator's report.
- **Choice.** (a). The standing permission had already built the "recent" view this option needed, so the timer's switch reuses it: `run_timer_agent_account_switch` records it with `authorizedBy: "self-timer"`, the timer id and the user's words, and runs the same executor. It is not counted against the standing permission's hourly limit. Settings → Schedules badges a timer that carries the permission and shows when it lapses.
- **Why.** One history for every unattended switch, and a timer that may switch is visible, with the user's words, while it can still be cancelled.

### Who resumes (task 8)

- **Options.** (a) The recommended: the coordinator, guided by the tool results. (b) An option on `switch_provider_account` that prompts the listed tabs.
- **Choice.** (a). A switch that ran returns `limitedTabs` (that provider's limited tabs of this project on that machine) and a `resumeStep`; an approved switch's mail says to read them with `get_usage_limits`; the coordinator rule names the step.
- **Why.** As recommended: no automation that spends turns on its own, and the switch stays easy to approve. Listing only that provider's tabs, from the outcome's structured kind where the bridge gave one, guards against prompting a tab that was not limited.

### Seeding the scenario (task 4)

- **How the usage limit is produced.** Options: (a) append a usage-limit
  turn outcome to a real worker's stored session from outside the backend;
  (b) write a whole synthetic session row; (c) wait for a real limit. Chose
  (a): the worker is a real tab with one finished turn, and only its newest
  outcome is added (`appendNativeAgentTurnOutcome` in
  `storage-test-support.ts`, reached through `e2e/agent-testing/backend-store.ts`),
  so the session row stays one the backend wrote. A running backend observes
  it through the store's committed revision, which
  `storage-test-support-turn-outcome.test.ts` checks against the usage-limit
  reader. (b) would have to reproduce the row's ownership and provider
  fields; (c) is the plan the decision above rejects.
- **Which accounts.** One extra signed-in fixture account for the
  coordinator's own platform, added to the profile's registry beside the
  existing ones, with the active account unchanged; the registry is written
  back exactly afterwards, which also undoes the switch and its pin. The case
  runs only on Claude and Codex, the platforms with accounts. Switching the
  active account to a fixture login would break the coordinator's next turn,
  so the granted switch is the last step of the case and the registry is
  restored before anything else runs.
- **Both permission paths in one case.** A `request` phase (no permission:
  a pending request, which the harness rejects so nothing changes) and a
  `granted` phase (a timer set in a user-started turn with the user's
  permission: the switch runs at once and is recorded as the timer's). The
  approval itself is answered with `resolve_node_action_request` rather than
  in the dialog; the dialog is part of the billed run on the checklist.

## Behaviour in brief

A coordinator can set a timer that prompts itself later ("in 2 hours", "at
14:30"), find workers that stopped on a provider usage limit, list the
machine's Claude and Codex logins with their remaining plan usage, and switch
the active login. The scenario it supports end to end: "Check the
environments in 2 hours. See if any of them have hit usage limits, then
switch to another account that has usage allocation left." Everything has
deterministic evidence only.

With "Let coordinators switch accounts without asking" ticked in Settings for a
provider, a switch runs at once instead of waiting for approval, within the
limits in "Standing permission".

The tools are offered to every main coordinator: `get_usage_limits` with
capability `environments`, the account tools with the new capability
`accounts`. `remind_me` needs the experimental scheduling switch, like every
schedule tool.

Since 2026-11-05: the Claude and Codex bridges report a usage limit as a
structured signal that the backend records and every usage-limit reader
accepts, with the error text as the fallback; a self-timer's "14:30" is the
user's own 14:30 once they have sent the coordinator a prompt; a timer that
may switch accounts is marked in Settings → Schedules and the switches it
allows are recorded and shown with the account; and a switch tells the
coordinator exactly which tabs to resume.

## Constraints and rationale

- Never write a credential: every switch is `set_active_agent_account`.
- Tests use fakes only: no real `~/.claude`, `~/.codex` or `~/.pi`, no billed turns.

## Known gaps

- Task 6 has no browser check: the renderer change is a field on two requests, covered by unit tests.

## Related

- [agent-accounts.md](agent-accounts.md#machines) ("Preferred login"; to-do 0722's decision (c), retired 2026-11-10), why a switch is the user's act.
- [agent-accounts.md](agent-accounts.md), to-do 0003 (retired 2026-11-13).
- [0024-coordinator-live-conformance.md](../development/coordinator-live-conformance.md), where task 4's scenario would live.
- [Manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md): the human-only parts of to-do 1000 (the billed run of task 4's scenario; the real-provider check of task 5's usage-limit signals), cited as `1000 (retired)`. Record their results in this file.
- `docs/architecture/scheduled-jobs.md` (Self-timers), `docs/architecture/agent-accounts.md` (Coordinator switching), `docs/architecture/coordinator.md`.
