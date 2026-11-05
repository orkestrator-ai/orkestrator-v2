# X1: Coordinator trust boundary

This file combines 5 reports into one batch to build together. What a coordinator or side agent may reach, and how its mail is framed. `0120` task 2 is a live check and can run separately.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [Security 0090](#security-0090-limit-how-far-prompt-injection-can-spread-through-the-coordinator) | High | M11: delegation scope and marking mail-originated delegations |
| [Security 0180](#security-0180-control-mcp-confirmation-operator-token-and-self-reminder-soft-spots) | Medium | L16: operator token reads, confirm token wording, self-reminder framing |
| [Security 0210](#security-0210-correct-what-the-docs-say-a-side-agent-can-do) | Low | I2: two stale statements about side agents |
| [Coordinator 0120](#coordinator-0120-label-the-project-home-in-listings-and-prove-the-message-gate-live) | Medium | Labelling the home in `list_environments` and a live read-only step for the message gate. |
| [Coordinator 0310](#coordinator-0310-side-agents-can-call-adopt_workflow) | Low | Refusing `adopt_workflow` from a side agent. |

## Security 0090: Limit how far prompt injection can spread through the coordinator

### Task analysis

#### Tasks

1. **Limit delegation to environments the coordinator created**: unless the user opts in. Status: open.
2. **Mark delegations that came from worker mail**: so the recipient can tell. Status: open.

#### 1. Limit delegation to environments the coordinator created

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

#### 2. Mark delegations that came from worker mail

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

### Open questions

- Could some coordinator-only tools other than mail (`send_prompt_to_tab`, worker commands) need the same line? Task 1's check would naturally live beside `apps/backend/src/core/control-mcp-server.ts:596-606`, which covers arguments named `environmentId`, while mail uses `toEnvironmentId`, so both need it.

### Needs verification

- How often coordinators legitimately drive environments they did not create, which decides how disruptive task 1's default would be. Only usage shows that.

## Security 0180: Control MCP confirmation, operator token and self-reminder soft spots

### Task analysis

#### Tasks

1. **Keep the operator token away from coordinators**: the sandbox denies writes, not reads, of the data directory. Status: open.
2. **Say what a confirm token does and does not prove**: an agent can complete the flow itself. Status: open.
3. **Frame self-reminders as the agent's own**: they read as an authenticated system notice. Status: open.

#### 1. Keep the operator token away from coordinators

**Problem.** A read-only coordinator runs as the user, so a command it is allowed can read `<dataDir>/control-mcp.json`, which holds credentials with wider authority than its own.

**Context.** Plaintext at mode 0600 is a settled decision, so that Copy setup works at any time ([todo 0041](../../todo/mcp/0041-control-mcp-voice-surface.md), decision 2, and `docs/architecture/control-mcp.md:65`). That decision rules out encrypting the file, not hiding it from a sandbox.

**Investigation.** `writeControlMcpDescriptor` writes the file (`apps/backend/src/core/control-mcp-credentials.ts:331-346`). `claudeReadOnlySandbox` returns `filesystem: { denyWrite: ... }` and no read rule (`bridges/claude-bridge/src/services/read-only-policy.ts:583`, typed at `:553`). `denyRead` appears nowhere in `bridges/claude-bridge/src` or `apps/backend/src/core`. `READ_ONLY_TOOLS` also includes `Read` and `Grep` (`:60-63`).

**Decisions.**

- **How to deny the read?**
  - **Add `denyRead` for the data directory to the Claude read-only sandbox, and refuse the path in the `Read` and `Grep` hook (recommended).**
    - Pros: the report's fix; small; holds for commands and tools.
    - Cons: depends on the sandbox being active, and a host where the probe reports it unavailable relies on the hook alone; other providers' read-only turns need their own check.
  - **Move the credentials out of the data directory.**
    - Pros: none over the above: same uid, same reach.
    - Cons: breaks the documented location.

#### 2. Say what a confirm token does and does not prove

**Problem.** The first call returns a token and the second succeeds, so the same agent can complete it alone. It is an idempotency and intent check, not human approval.

**Context.** The HMAC design is deliberate and is documented (`apps/backend/src/core/control-mcp-confirm.ts:6-14`, `docs/architecture/control-mcp.md:175-205`). On a voice client a person hears the description. That document does not say that it gives no assurance against an agent.

**Investigation.** Nothing binds a token to a human action. The class of each action is in `PUBLIC_ACTION_INPUTS` (`docs/architecture/control-mcp.md:177-178`).

**Decisions.**

- **What should change?**
  - **State in `control-mcp.md` that confirmation is not a human-approval boundary (recommended).**
    - Pros: costs nothing; destructive actions on coordinators already go through user-approved requests.
    - Cons: an agent with an operator credential can still run `always` actions.
  - **Route `always` actions through a user approval when the caller is an agent.**
    - Pros: a real control.
    - Cons: the backend cannot tell an agent from a person on one MCP credential, and it breaks unattended voice and automation use.

#### 3. Frame self-reminders as the agent's own

**Problem.** A reminder an agent set for itself arrives as "an authenticated Orkestrator workflow status notification". Text chosen by an injected agent therefore comes back with higher standing than it started with.

**Context.** `docs/architecture/scheduled-jobs.md:185-191` explains that no tab may mail itself, so a reminder is a backend notice. It can only reach its owner, which limits the damage to a later turn of the same session.

**Investigation.** `apps/backend/src/core/scheduled-jobs/executor.ts:781-787` sends a `system` sender with `source: "workflow"` and adds "(Scheduled by you: ...)" to the body. The sender's framing is at `packages/protocol/src/agent-mail.ts:948`, and does not distinguish a reminder.

**Decisions.**

- **How to distinguish it?**
  - **A distinct `source` value with framing that says this is the session's own note, not from Orkestrator or the user (recommended).**
    - Pros: honest framing; `source` is already a typed field.
    - Cons: a protocol change; older bridges or clients must tolerate the new value (`docs/architecture/version-compatibility.md`).
  - **Keep the sender and rely on the "Scheduled by you" line.**
    - Pros: no change.
    - Cons: the authenticated framing around it still speaks first.

### Current state

Done, so not in Tasks: the report's fourth point, Cursor and Pi accepting policy fields from the body, closed with the narrow-only routes (`bridges/cursor-bridge/src/http.ts:216`, `bridges/pi-bridge/src/http.ts:284`; commits `2d4528dc5`, `a2bba9d80`). `readOnly` from the body stays, and only the backend now holds the token that can send it ([todo 4210](../../todo/containers-and-environments/4210-read-only-boundary-from-a-token-holder.md)).

### Needs verification

- Whether a `denyRead` rule in the Claude SDK sandbox blocks reads on both Seatbelt and bubblewrap: nothing was run.
- Whether anything outside `read-only-policy.ts` confines the paths that reading commands take. No path check was found in that file, and the read itself was not attempted.

## Security 0210: Correct what the docs say a side agent can do

### Task analysis

#### Tasks

1. **Add `schedules` to the two stale statements**: the README and one line of the Control MCP guide. Status: open.

#### 1. Add `schedules` to the two stale statements

**Problem.** Two documents say side agents get only `discovery` and `mail`. The code also grants `schedules`.

**Context.** `docs/architecture/coordinator.md:352` and `:2261` were already corrected, and `docs/architecture/control-mcp.md:518` is right.

**Investigation.** The grant is `apps/backend/src/core/control-mcp-tools.ts:193`. `README.md:19` and `docs/architecture/control-mcp.md:505` still have the old list.

**Decisions.** None: this is a documentation correction.

## Coordinator 0120: Label the project home in listings and prove the message gate live

### Task analysis

#### Tasks

1. **Label the home in `list_environments`**: the model can tell the project home from a worker before acting on it. Status: open.
2. **Add a live read-only step**: mail the home through a real provider and check that the checkout digest is unchanged while approval is pending. Status: open.

#### 1. Label the home in `list_environments`

**Problem.** To the model the project home looks like an ordinary worker. It learns otherwise only when a call is refused.

**Context.** The report's first choice, refusing the home outright and hiding it, was superseded: `5161688cf` (#1632) allows a message with a reason and usually the user's approval (see [Current state](#current-state-1)). The home therefore has to stay addressable, so a filter is no longer the right fix for a local listing.

**Investigation.** The local listing filters the home only for node targets (`control-mcp-tools.ts:932`). `environmentSummary` has no `projectHome` field (`control-shared-actions.ts:60-80`). `get_environment` on the home is refused outright (`control-mcp-server.ts:603`), so the model cannot look it up either.

**Decisions.**

- **Label it or hide it?**
  - **Add `projectHome: true` to the coordinator's listing row (recommended).**
    - Pros: the routing rule's "exceptional circumstances" can be followed knowingly; the gate needs the id to be discoverable.
    - Cons: one more field on every row (absent for workers, so nearly no cost); operator reads share `environmentSummary`, so add it only in the coordinator branch.
  - **Hide it and put the id in the routing rule.**
    - Pros: the model is never tempted.
    - Cons: a per-turn prompt line for an exceptional case, and hiding contradicts a rule that allows it.

#### 2. Add a live read-only step

**Problem.** The gate has unit evidence only. The live read-only scenario proves `launch_job` is refused on the home, but not this route.

**Context.** The report's roadmap asks for the step. `docs/todo/coordinator-and-multi-review/0024-coordinator-live-conformance.md` describes the existing case and calls `launch_job` "the one Control MCP route to a write in the checkout", which has been out of date since #1632.

**Investigation.** `apps/desktop/scripts/dev/coordinator-live.ts:222` is the home probe, with `homeEnvironmentId` at `:198` and the home-work check at `:579-627`. Nothing there sends mail to the home. `coordinator-worker-mail.test.ts` and `control-mcp-server-messaging.test.ts` cover the gate without a provider.

**Decisions.**

- **What does the step assert?**
  - **`send_message` with no reason is refused, with a reason it is held as pending, and the digest and home work are unchanged (recommended).**
    - Pros: covers what a read-only coordinator can do unattended; needs no approval click.
    - Cons: does not exercise the send after approval, which the unit tests cover.
  - **Approve it too, and check the delivered mail.**
    - Pros: the whole round trip.
    - Cons: an approved message legitimately writes to the checkout, so it cannot be a read-only check.

### Current state

- `send_coordinator_agent_mail` requires `projectHomeReason`, holds the message for approval, and allows it for 3 hours after a sent message (`coordinator-worker-mail.ts:417-432`, `:268-336`). The user's dialog is `ProjectHomeMessageApprovalDialog`, described in `docs/architecture/coordinator.md:1178-1216`.
- The scheduled route goes through the same gate: a `send_message` schedule calls the coordinator's own tool (`scheduled-jobs/tools.ts:219-229`, `scheduled-jobs/executor.ts:594-596`, `:639`). That action has no reason field, so it is refused; a generic `tool` schedule reaches the same command and the same approval. So the report's concern about `create_schedule` does not hold.
- A node's home stays refused (`coordinator.md:1213-1216`), and the regression tests are in `coordinator-worker-mail.test.ts`.

### Constraints and rationale

- This changes the report's stance: it wanted the home refused, and the shipped design allows it with approval. Security finding M10 recommends the same refusal, so that report is out of date on this point too.

## Coordinator 0310: Side agents can call `adopt_workflow`

### Task analysis

#### Tasks

1. **Refuse adoption from a side agent**: a side conversation cannot move a workflow to itself. Status: open.

#### 1. Refuse adoption from a side agent

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

### Current state

- The report's doc drift is fixed: `docs/architecture/coordinator.md:351-353` now lists `discovery`, `mail` and `schedules` (`3fa7d1733`, #1436).

## Related

- [Security report, M11](../2-26-10-27-security.md#m11-prompt-injection-can-spread-worker--coordinator--another-worker-design)
- `docs/architecture/coordinator.md`, "Messaging the project home" (M10's outcome, the model for an approval)
- [Security report, §5 Low severity](../2-26-10-27-security.md#5-low-severity) (L16)
- [Todo 0041](../../todo/mcp/0041-control-mcp-voice-surface.md), decision 2
- [Security report, §6 Informational](../2-26-10-27-security.md#6-informational) (I2)
- [Coordinator report, 4.1 (S1)](../2026-10-27-coordinator.md#41-security-and-boundary) and [7](../2026-10-27-coordinator.md#7-suggested-roadmap)
- [Security report, M10](../2-26-10-27-security.md)
- [0024-coordinator-live-conformance.md](../../todo/coordinator-and-multi-review/0024-coordinator-live-conformance.md)
- [1021-coordinator-gap-tools-follow-ups.md](../../todo/coordinator-and-multi-review/1021-coordinator-gap-tools-follow-ups.md): the approval dialog's fixture
- [Coordinator report, 4.1 (S2)](../2026-10-27-coordinator.md#41-security-and-boundary)

## Outcome

Built on 2026-11-05 from `main` at `af2e566e5`, then rebased onto `main` at `0194a0675` before this table was last updated. The report's line numbers were recorded at `a2bba9d8` and were re-checked against `af2e566e5`. The claims held after C4 (#1809), though most line numbers had moved (see Line numbers at `af2e566e5`). One recommendation's detail no longer fit: the check's location, under Decisions. This table was re-checked item by item after the review fixes, so it describes the finished work.

### What the deny rule covers

- **Rule:** the whole data directory is denied, with an allowance, rather than specific files. A file list goes stale silently when a store adds a secret; a missing allowance fails loudly. This covers `control-mcp.json`; the provider secrets L17 records as an accepted risk, which live in `config.json`, its backups and remnants and staged `portable-inputs`, not the database as this report first assumed; `orkestrator.sqlite` and its `-wal` and `-shm` files; every account's login; and other conversations' runtimes.
- **Allowance, only inside the directory:** that conversation's own `claude-home` (saved tool results and memory; `applyCoordinatorClaudeAccount` keeps logins out of it), its attachment directory, the user-skills directory it was given, the managed toolchains, and a checkout placed inside it. A checkout above the directory does not re-open it.
- **Proven on Seatbelt with the pinned CLI, a fixture directory and a scripted model, no provider turn:** a command cannot read the credentials, database, a login or another conversation; a command can read its own tool results, memory and attachments; `Read`, `Grep` and `Glob` are refused on the directory, through a link and from above it; `Read` and `Grep` work on its own files; a command naming a link to the credentials is refused with no sandbox behind it. The provider-secret files and the hook's symlink, parent-directory and implicit-root refusals are proven by `read-only-path-boundary.test.ts`, not by the Seatbelt run.
- **Left to [6080](../../todo/coordinator-and-multi-review/6080-x1-coordinator-trust-boundary-follow-ups.md):** bubblewrap (task 2); OpenCode, Cursor, Pi and Grok coordinators, which have no path rule (task 3); a read-only review turn in a worker bridge (task 4). Codex's deny-by-default profile already excludes the directory by configuration, read but not run. Windows has no sandbox here, so the hook is all there is, and it was not run there.

### Decisions

- **Where the check lives.**
  - **A table of tools checked before each handler, plus the two mail commands (chosen).** Pros: tools have validated input and a clear name, so reads stay readable; scheduled fires pass through it too; a test forces each new tool to choose. Cons: a command reached by another route is not checked, and today none is.
  - **Beside the project home check in `coordinatorInvoker`, as the report suggested.** Pros: one place. Cons: it sees commands, not tools, so it cannot tell a read from an action, and it misses `toEnvironmentId`, `existingEnvironmentId`, `environment.environmentId`, `to.environmentId` and arguments nested in `invoke_on_node`. This is why the report's location no longer fits.
- **Which records prove an origin.** An `environment` launch with `baseCommit`, or a `build-pipeline` or `graph-run` whose `createdEnvironmentId` names that environment, on the same node and any conversation of this coordinator. The mailbox's `coordinatorOrigin` was not used even though the report pointed at it: it reads launch records only and skips other nodes, so it would refuse this coordinator's own pipelines and remote workers.
- **Creation receipts, not workflow membership.**
  - **Receipts that name the environment a workflow created (chosen).** Pros: they survive the cleanup of workflow history, and a review or a pipeline aimed at an existing environment adopts nothing, so turning the setting off revokes access. Cons: a bounded record is kept while each environment exists, and an older workflow record with no receipt needs the setting.
  - **Treat any workflow running in the environment as proof, as first built.** Pros: uses the records that already exist. Cons: cleanup revoked a real worker, and work started under the setting kept its access after the setting was turned off. Review found both.
- **Older environments with no stored origin are refused.** Nothing distinguishes one from a hand-made environment, so allowing it would leave the check nothing to refuse. Allowing them was the alternative, and it would void the fix for every environment that exists today. `version-compatibility.md` allows this safe, explicit outcome, and the refusal names the way out.
- **Replies get no exception.** A reply carries the same authenticated framing and can carry the same instructions. It costs an agent in a hand-made environment its answer until the user opts in, so [6080](../../todo/coordinator-and-multi-review/6080-x1-coordinator-trust-boundary-follow-ups.md) task 6 measures it.
- **The carrier keeps saying `workflow` for a self-reminder.** A renderer before this refuses any other `source` and shows the raw block, so the carrier adds `selfReminder: true` and the stored message and mail tools carry the real value. Registered in `version-compatibility.md`. After a downgrade, an older backend would write the real value into a carrier for a reminder still undelivered, which an older renderer then shows raw; that is a display fault on one message.
- **A message the user approved is not marked as agent-originated.** The user read that exact text. `turnOrigin` would otherwise describe whichever turn came last at approval time.

### Line numbers at `af2e566e5`

- `send_coordinator_agent_mail`'s check is at `coordinator-worker-mail.ts:479-492`, and the invoker's at `control-mcp-server.ts:518-543`.
- `adopt_workflow` is still granted under `discovery`, at `control-mcp-tools.ts:150`.
- The turn origin is written at `native-agent-service.ts:3930`, and the grant's check is at `control-mcp-coordinator-tools.ts:741`.

### Outcome table

| Part and task | Outcome | Evidence |
| --- | --- | --- |
| Security 0090 task 1: limit delegation | Done, recommended option | `coordinator-environment-scope.ts`, `control-mcp-coordinator-environment-scope.ts`; setting `coordinatorOtherEnvironments` in Project Settings, Coordinator; tests in `coordinator-environment-scope.test.ts` cover mail and every checked tool, the setting on, another node, takeover, adoption and no stored origin. Pipeline controls resolve their environment through `pipelineId`, and addressing a review always takes the check; `coordinator-pipeline-step-actions.test.ts`, `coordinator-review-actions.test.ts` and `coordinator-surfaces-remote.test.ts` cover both, locally and on a node. Cancelling a review or a graph checks the workflow's environment the same way, locally and on a node, and a pipeline started for a new environment keeps a creation intent so delayed provisioning still records the receipt; `coordinator-environment-scope.test.ts` covers the cancellations and `commands-registry-coordinator-nodes.test.ts` a remote receipt repaired after late provisioning. Before a workflow's environment is published, pipeline and graph controls (pause, cancel, resume, restart a failed step) are allowed only from a settled launch association matching project, coordinator, workflow kind, resource and node; after publication the environment check applies. `coordinator-environment-scope.test.ts` covers both, locally and on a node, with pending and mismatched associations refused |
| Security 0090 open question: `send_prompt_to_tab`, worker commands | Answered: yes, they need the line | Checked along with every tool that sends work or changes an environment; reads and user-approved requests stay out. `list_worker_commands` is a read; `run_worker_command` and `stop_worker_turn` are checked. A test fails on any environment- or workflow-taking tool in no list |
| Security 0090 task 2: mark mail-originated delegations | Done, recommended option | `turnOrigin: "mail"` on the coordinator and node actors, `COORDINATOR_MAIL_ORIGIN_NOTE` in the carrier; a user-started turn's text is pinned unchanged in `agent-mail.test.ts` |
| Security 0090 verification: how often coordinators need others | Not done, usage only | [6080](../../todo/coordinator-and-multi-review/6080-x1-coordinator-trust-boundary-follow-ups.md) task 6 |
| Security 0180 task 1: operator credentials | Done for Claude, recommended option with a stated exception | `read-only-path-boundary.ts`; sandbox `denyRead`/`allowRead`; hook on `Read`, `Grep`, `Glob` and commands. With no sandbox behind it, the hook also refuses symlink-following search modes and recursive `diff`, and checks the working directory as a search's implicit root. It refuses `diff -r` clusters and every abbreviation of `--recursive`. A path attached to a clustered short option (`rg -nFf<path>`) is checked too; `read-only-path-boundary.test.ts` covers absolute, relative, symlink and symlink-parent spellings, and recursive `diff` over a descendant link to the credentials |
| Security 0180 task 2: confirmation | Done, recommended option | `docs/architecture/control-mcp.md`, Confirmation |
| Security 0180 task 3: self-reminders | Done, recommended option | `source: "self-reminder"`, `SELF_REMINDER_NOTE`, `executor.ts`; older renderers pinned in `agent-mail.test.ts` and `client-only-messages.test.ts` |
| Security 0180 verification: `denyRead` on Seatbelt and bubblewrap | Seatbelt proven; bubblewrap not observed | `conformance-coordinator-read-boundary-live.test.ts`, 6 of 6 on this macOS host, rerun after the rebase, including a control that reads the fixture without the rule; [6080](../../todo/coordinator-and-multi-review/6080-x1-coordinator-trust-boundary-follow-ups.md) task 2 |
| Security 0180 verification: anything confining reading commands' paths | Answered: nothing did; the sandbox rule and the hook do now | The control case above read the fixture credentials with only the old sandbox |
| Security 0210 task 1: `schedules` | Done | `README.md`, `docs/architecture/control-mcp.md` |
| Coordinator 0120 task 1: label the home | Done, recommended option | `projectHome: true` in the coordinator branch of `list_environments` only; `environmentSummary` unchanged, so operator reads and `list_workflows` are too. `coordinator-environment-scope.test.ts` checks the coordinator's listing marks the home and not a worker, and that an operator's `list_environments` and `get_environment` leave the home unmarked |
| Coordinator 0120 task 2: live read-only step | Step built and checked offline; live run not done | `homeMailGateFailures`, prompt steps 9 and 10, `coordinator-live.spec.ts`, 7 cases in `coordinator-live.test.ts`; 0024's line corrected; [6080](../../todo/coordinator-and-multi-review/6080-x1-coordinator-trust-boundary-follow-ups.md) task 1 |
| Coordinator 0310 task 1: refuse adoption from a side agent | Done, recommended option | `adopt_coordinator_workflow` refuses `role: "side"`; the store's `force` path is unaffected, with a test for both. The tool stays listed for side agents, as the option noted |
