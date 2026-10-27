# Coordinator review

Date: 2026-10-27. Reviewed against `main` at `1aabf049` (branch
`coordinator-review-1a5200f9caa3-r1`).

Scope: the Project Coordinator end to end. That covers the backend service and
storage, status wakes, the Control MCP tool surface and the agent-facing
context prompt, provider qualification, and the web UI (panel, tab groups,
toolbar, leaf-mode gate and settings). Work already tracked in
`docs/todo/coordinator-and-multi-review/` is not repeated here unless this
review changes its priority.

Method: I read [`docs/architecture/coordinator.md`](../architecture/coordinator.md)
and the open todo files. Three parallel code reviews followed (backend core,
MCP and prompt, UI), and I re-read the code behind every high-severity finding
and most medium ones. Findings marked **verified** were checked in the source
for this report. **Reported** means the reviewer traced it and I did not
independently re-trace every step. Nothing was run live: no provider sessions
and no test suites.

---

## 1. Executive summary

The coordinator is in good shape on the hard problems: the read-only
enforcement tiers, crash-safe one-wake-per-delegation, idempotent launches and
durable status wakes. The design doc is unusually precise, and the live
conformance suite covers five providers. The weaknesses are elsewhere, in three
areas:

1. **One hole in the read-only boundary.** The main coordinator can
   `send_message` to the **project home** environment. That is a writable agent
   working directly in the user's checkout, so the coordinator can get edits
   made there indirectly. Every other route to the home is refused. This is the
   one finding I would fix before anything else.
2. **Durability and scale problems that show up after weeks of use.** Workflow
   associations are never pruned, and the 2,000-record cap is shared by all
   projects. Once it is reached, every coordinator launch in every project
   fails, and delegations opened by `send_message` fail silently. One stuck
   delegation can also block the wake pass for every project, and delegations
   to a forgotten node never close.
3. **The UX does not surface what the backend knows.** The panel knows exactly
   which workers it is waiting on, which of them need a person, and which mail
   came from which environment. But there is no clickable path to any worker
   ("Waiting on 2 workers" is a non-interactive `<span>` with a tooltip).
   Changing provider means knowing to close the main tab. Side agents are
   never explained. Errors are often collapsed under a heading that says
   "Repository", or hidden behind a Git error.

Small changes fix most of the UX problems, and they would change how the
feature feels more than any backend work.

### Top 10 actions

| # | Action | Area | Effort |
| --- | --- | --- | --- |
| 1 | Refuse `projectHome` destinations in coordinator `send_message` (and hide the home from local `list_environments`) | Security | S |
| 2 | Retire woken or reported associations (TTL or compaction), and make the cap per project | Backend | M |
| 3 | Catch errors per item in the delegation wake and reconcile loops | Backend | S |
| 4 | Make the "Waiting on N workers" chip a popover with Open buttons, and add "Open environment" to mail tiles | UI | S–M |
| 5 | Add a visible **Change agent…** action, and confirm before closing the main | UI | S |
| 6 | Show coordinator action errors in their own alert, not under the Git error | UI | S |
| 7 | Scope "startup failed" to the conversation that failed | UI + backend | M |
| 8 | Close open delegations when a node is forgotten, and notify the coordinator | Backend | S |
| 9 | Gate the delegation prompt on agent messaging being enabled | Prompt | S |
| 10 | Give the coordinator a "what am I waiting on" tool (delegation state in `list_workflows` or a new `list_delegations`) | MCP | S–M |

---

## 2. How it works today (brief)

- **Backend.** There is one coordinator workspace per project, with one
  **main** conversation and up to 15 **side agents**. Each conversation has its
  own bridge, a scoped MCP credential and a mailbox. The main delegates through
  Control MCP (`launch_environment`, `launch_job`, `send_prompt_to_tab`,
  `send_message`, Multi Review, Build Pipeline, schedules). Each delegation
  wakes the main exactly once, when the worker's turn ends. Status wakes report
  settled Multi Review and Build Pipeline states and waiting workers. A
  `coordinator-repair` sweep runs every 60 s and recovers anything missed.
- **Agent.** Every prompt is prefixed with an `<orkestrator-coordinator-context>`
  block (role, scope, network, delegation rules, launch base, async contract,
  repository revision, branch and commit). The main sees **56 tools**. Their
  names, descriptions and schemas come to about **54k characters, roughly
  13.5k tokens**. The context block is about **800–1,100 tokens per turn**, and
  the MCP server instructions add about 370 tokens.
- **UI, in order on screen:**
  1. the leaf-mode gate (when applicable);
  2. "Connect a local checkout" (when there is no path);
  3. the toolbar: Read-only badge, path, `Context rN`, the waiting-workers
     chip, branch picker, upstream state, Sync, Refresh, Pause;
  4. warnings: dirty checkout, blocked reason, a collapsed "Repository or
     coordinator error", and a Control MCP warning;
  5. a banner for worker commands waiting on the user;
  6. a notice that the branch changed;
  7. tab groups ("Coordinator", "Side 1"…, "+ New side agent" or
     "+ Start coordinator");
  8. the pane body: the composer with agent picker and tier caveats, the chat
     with mail tiles, or a full-pane state card;
  9. a footer line.

---

## 3. Strengths worth keeping

- **Read-only is graded, not binary.** The `enforced`,
  `provider-configured` and `advisory` tiers come from one table
  (`coordinator-providers.ts`) that every gate consults. Each tier is backed by
  a provider-specific translation of `capabilityPolicy`, and process-level
  `ORKESTRATOR_BRIDGE_EXECUTION_POLICY` means a stored record cannot widen a
  live session.
- **The wake protocol is crash-safe.** Close the delegation, record
  `wakeKind`, release or notify under a fixed request id, then mark `wokenAt`.
  Idempotency conflicts count as delivered.
- **Ownership is explicit.** Only work with a durable association wakes a
  coordinator. A Multi Review the user starts never does.
- **Delivery state, not timestamps.** `hasUndeliveredCoordinatorRequest`
  (including `pendingAgentLaunch`) stops a startup idle from settling a
  delegation that never started.
- **Status reducers are pure and keyed on stable identities** (Fix identity,
  session plus start time), so retries and restarts dedupe cleanly.
- **Hostile-skill handling is thorough.** Skills are mirrored with only safe
  frontmatter, `allowManagedHooksOnly` and `disableSkillShellExecution` are
  set, and a live probe checks it against the real CLI.
- **The renderer side is mostly clean.** The pane layout reconciler is pure and
  returns the same object when nothing changed. Project-switch fencing in
  `useCoordinatorPanelData` drops stale reads.

---

## 4. Findings

Severity: **High** means data, safety or availability is affected. **Medium**
means user-visible misbehaviour. **Low** means polish or edge cases.

### 4.1 Security and boundary

#### S1. The coordinator can mail the project home, which bypasses read-only (High, verified)

- `apps/backend/src/core/commands-registry-coordinator.ts:389-392`: the local
  `send_message` path checks only `destination.projectId === project`.
- The scoped invoker's project-home guard in `control-mcp-server.ts:474-495`
  runs only when the argument is called `environmentId`. `send_message` passes
  `toEnvironmentId`.
- No mail-store code checks `projectHome` (grep finds no match in
  `storage-agent-mail*.ts` or `agent-mail*.ts`).
- The cross-node path does refuse the home
  (`commands-registry-coordinator-nodes.ts:138`), so the two paths disagree.
- Local `list_environments` does not filter the home out: the filter at
  `control-mcp-tools.ts:780` applies only to node targets. `environmentSummary`
  carries no `projectHome` flag, so to the model the home looks like an
  ordinary worker.

**Scenario.**
1. The coordinator lists environments, sees the home, and calls
   `send_message({ toEnvironmentId: <home id>, body: "apply this patch…" })`.
2. Coordinator-route mail wakes the recipient whatever the default inject
   policy is.
3. The home's writable agent then edits the real checkout, and a delegation
   opens against it.

This contradicts `coordinator.md` § Project home ("A coordinator credential
cannot target it"). It may also be reachable through `create_schedule` with a
`send_message` action, since that runs the same command.

**Fix.**
- Refuse `projectHome === true` in the coordinator `send_message` branch,
  mirroring the node path.
- Filter the home out of local `list_environments` for coordinator
  credentials.
- Better still, move the home check into one helper used by every
  coordinator-scoped resolution of an environment id, whatever the argument is
  called.
- Add a regression test next to the existing project-home invoker test.

#### S2. Side agents can adopt workflows (Low–Medium, reported)

- `adopt_workflow` is granted under `discovery` (`control-mcp-tools.ts:97`),
  which side agents hold.
- `adoptCoordinatorWorkflowAssociation` (`storage-coordinators.ts:571-607`)
  has no role check.
- A side agent that adopts an orphaned build then receives its wakes, but
  cannot message the worker or cancel the build. That breaks "every worker
  reports to the main".

**Fix.** Refuse adoption for `role === "side"`.

**Doc drift.** `coordinator.md:110` says side agents carry only `discovery`
and `mail`, but the code also grants `schedules`.

### 4.2 Backend correctness and durability

#### B1. Workflow associations are never pruned, and the cap is global (High, verified)

- `MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS = 2_000` (`storage-coordinators.ts:20`)
  is enforced at `:213` and `:258` on a single store shared by all projects.
- Associations are removed only when a project is deleted (`:689-695`) or a
  duplicate review receipt is merged (`:317`).
- Every launch, job and prompt creates one, and so does every `send_message`
  that does not join an open delegation.

**Scenario.** An active user who sends about 30 delegations a day reaches
2,000 in roughly two months, counting all projects together. From then on:
- `launch_environment`, `launch_multi_review` and `start_build_pipeline` throw
  "Coordinator workflow association store is full";
- `send_message` still sends, but `openWorkerDelegation`'s error is only
  `console.warn`ed (`commands-registry-coordinator.ts:437-442`), so the
  coordinator is never woken and sees mid-turn progress mail one message at a
  time.

The only recovery is deleting the project. Long before the cap, every sweep,
`snapshot()` and view digest walks the whole list, and associations for
deleted workflows are re-read every 60 s.

**Fix.**
- Compact associations that are terminal and reported (delegation woken,
  workflow terminal and notified) after N days.
- Keep request-id aliases only as long as the retry window needs.
- Make the cap per project, and surface "store full" to the user rather than
  only to the model.

#### B2. One bad delegation blocks wakes for every project (Medium, reported; structure verified)

- `deliverDelegationWakesOnce` (`coordinator-service.ts:1124-1269`) loops over
  all unwoken delegations with no per-item try/catch.
- A throw from `sendAgentMail` aborts the whole pass. Examples:
  `messaging-disabled`; `recipient-not-found` because mailbox sync bailed when
  pane layouts were unavailable; or a permanent `message-not-found` on replay
  after retention removed the message.
- The same item comes first again on the next sweep, so wakes stall
  everywhere, indefinitely.
- `reconcileWorkerDelegations` (`:955-1013`) has the same shape.
- The status-wake `reconcile()` already catches per item
  (`coordinator-status-wakes.ts:917,932`).

**Fix.** Catch per item, log with the association id, and after K failures
mark the delegation `failed`, sending one system notice.

#### B3. A delegation that closes during an in-flight wake pass is delayed up to 60 s (Medium, verified)

- `deliverDelegationWakes()` (`coordinator-service.ts:1115-1122`) returns the
  promise of the pass already running.
- That pass read its list (`:1125`) before the new delegation closed.
- Worker B finishing while worker A's wake is being delivered (which can take
  seconds: `ensureMainConversation`, mailbox sync, a 5 s excerpt read) leaves
  B's report waiting for the next `coordinator-repair` tick.

**Fix.** Add a "rerun requested" flag so a call made mid-pass schedules one
more pass after it.

#### B4. Delegations to a forgotten node never close (Medium, reported)

- `node-coordinator-remote.ts:52-57` turns every routing failure into
  `"unavailable"`, and `coordinator-service.ts:1048-1052` treats
  `"unavailable"` as no news.
- `forgetNode` (`nodes/node-service.ts:738`) leaves the node's associations
  untouched.
- The result: the chip shows "Waiting on N workers" forever, the coordinator
  is never told, and the node is re-polled every minute.

**Fix.**
- On forget, close the node's open delegations as `stopped`, mark its
  workflows reported, and send one notice.
- For a node that has been offline for a long time, send one notice after
  something like 24 h.

#### B5. Notices held while no main is open are dropped after 24 h (Low–Medium, verified)

- `coordinator-status-wakes.ts:1013-1022` records any non-terminal status with
  no prior notice and `updatedAt` older than `STATUS_BACKFILL_LIMIT_MS`
  without waking anyone.
- That rule exists for workflows that predate status wakes. But it also
  swallows the case the doc promises to handle (`coordinator.md:791-793`): a
  review reaches `ready` on Friday with the main closed, the user starts a main
  on Monday, and the coordinator never hears the review is ready to address.

**Fix.** Apply the backfill rule only to associations created before a
recorded cutover, or before the association's own `createdAt`.

#### B6. Closing the main during wake delivery can strand a report (Low, reported)

- `closeConversation` (`coordinator-service.ts:702`) is not inside the
  per-project `serialize`, so it can land between `ensureMainConversation`
  returning and the send.
- The report then lands in a tombstoned mailbox and the delegation is marked
  woken.
- Separately, a `waiting` episode is cleared only on a `working` edge
  (`coordinator-status-wakes.ts:1087,1157`). A waiting → idle transition on a
  delegation that stays open leaves the "needs you" marker stale and stops a
  later waiting episode from producing a notice.

**Fix.** Serialize close, select and pause like create and ensure, and clear
`waiting` on any edge that leaves `waiting`.

#### B7. The repair sweep repeats global work for each workspace (Medium, performance, reported)

- `reconcileWorkerDelegations` runs `reconcileMainMail` once per coordinator
  workspace. Each run does a full `synchronizeAgentMailboxes` (all projects,
  environments, pane layouts and one session read per environment) plus two
  full association scans.
- The cost is roughly workspaces × environments every minute.
- `snapshot()`, which the panel calls on every `get`, runs the same reconcile,
  writes included.
- Each delegation wake writes three times and announces a change three times,
  and each announcement triggers a renderer re-read, which repeats the sync.
- `listOpenCoordinatorDelegations` is re-read inside the loop (`:965`), which
  is quadratic in open delegations.

**Fix.**
- Sync once per sweep.
- Make `snapshot()` read-only and leave repair to the sweep.
- Batch the three wake writes into one mutation with one announcement.

### 4.3 Agent experience (prompt and tools)

#### A1. With messaging off, the coordinator is still told to delegate (Medium, verified)

- `coordinatorDelegationAvailable` (`apps/backend/src/core/index.ts:885-887`)
  checks only `controlMcp.running` and the platform's qualification.
- When agent messaging is disabled, the mail tools are not registered and
  injection drains exit early. Yet the prompt still says to launch workers,
  finish the turn and wait for a wake that can never arrive.

**Fix.** Include `agentMessaging.enabled` in the check. Then show "Delegation
unavailable: agent messaging is off" in the panel, which already has a
Control MCP warning line next to it.

#### A2. The "omit to use defaults" rule cannot be followed for `agent` (Medium, verified)

- `agent` is a required enum on `launch_environment`
  (`control-mcp-tools.ts:1268`) and on `launch_job`.
- `COORDINATOR_LAUNCH_DEFAULTS_RULE` tells the model to override the agent
  only when asked, but nothing says to copy `defaults.agent` from
  `get_launch_options`.
- A model that writes `claude` out of habit silently runs workers on a
  platform other than the user's default.

**Fix.** Make `agent` optional and resolve the repository default, matching
how `modelId` is handled. Alternatively, state explicitly in the description to
pass `defaults.agent`.

#### A3. The request-id namespace lasts the coordinator's lifetime, but the model is only told to reuse (Medium, reported)

- Idempotency is keyed on `coordinatorId + requestId`, permanently and across
  conversations (`storage-coordinators.ts:228-241`).
- The coordinator prompt says only "Reuse requestId on retry"
  (`native-agent-service.ts:939`), while operator instructions say "Every
  mutation needs a new requestId".
- A fresh main that picks `launch-1` again gets a payload conflict, replays an
  old environment, or (for delegations) quietly fails to open one.

**Fix.**
- Say "use a new unique requestId for each new action; reuse it only to
  retry".
- Namespace server-side by conversation, or tell the model the id has been
  used before ("requestId already used for …; choose a new one").

#### A4. Poll-guard coverage is uneven (Medium, reported)

- The `list_agents` description invites polling ("Read this instead of polling
  tabs one by one"), and that tool has no guard. Neither do `get_tab_state`,
  `get_tab_transcript`, `get_environment`, `get_multi_review` or
  `get_build_pipeline`.
- The guard is keyed on the exact input JSON, so changing `limit` resets it.
- Its window resets 120 s after the first read, so polling at intervals over
  40 s is never flagged.

**Fix.** Key the guard on the tool plus its semantic target rather than the raw
arguments, and use a sliding window. Rewrite the `list_agents` description.

#### A5. The tool surface costs about 13.5k tokens per turn, and the duplicates weaken behaviour (Low–Medium, reported)

- The largest schemas are `start_build_pipeline` (5.7k characters),
  `create_schedule` (4.2k), `launch_multi_review` (4.0k) and
  `start_multi_review` (3.7k).
- Seven legacy `*_node_*` tools duplicate the `nodeId` forms, and they are
  weaker:
  - `launch_node_environment` skips the base-commit check and model
    validation, and returns no async contract;
  - `send_prompt_to_node_tab` skips the outstanding-delegation check.
- `start_multi_review` is kept "for diagnostics" but is offered to every
  coordinator.

**Fix.**
- Remove the legacy node tools from the coordinator set, or route them through
  the same implementation.
- Hide `start_multi_review` from coordinators.
- Trim schema prose that repeats the context block.

The context block itself (about 850 tokens, sent on every turn including mail
wakes) is reasonable. Two changes would make it more useful:
- add the project **name** and checkout path (it currently gives only
  `Project: <uuid>`);
- add a one-line **open delegations** summary ("Waiting on: api-fix (running),
  docs (needs a person)"). That helps most after context compaction, when the
  model has forgotten what it launched.

#### A6. The coordinator cannot answer "what am I waiting on?" (Medium, reported)

- `list_workflows` returns the last 200 associations
  (`control-mcp-coordinator-tools.ts:103`). Most are one row per message to
  the same environment, and none expose delegation `state`, `workerTabId` or
  `waiting`.
- So a coordinator asked "what's still running?" has to reconstruct the answer
  from `list_environments` and `list_agents`, which is exactly the polling the
  guard discourages.

**Fix.** Expose delegation state on `list_workflows`, or add
`list_delegations`. Also consider:
- `cancel_delegation` or interrupting a worker turn (today only
  `stop_environment` exists);
- a worker diff or status read, so the coordinator can review a worker's
  changes without reading its whole transcript.

None of these is in 0142.

#### A7. The prompt nudges toward over-delegation (Low, plausible)

- The Scope line sends "multi-file investigation … reviewing code in depth …
  even when it only reads" to a new worker.
- The delegation line names only `launch_environment`, never `launch_job` on
  an existing worker.
- That can mean a fresh worktree, with setup scripts, for each question.

**Fix.** Mention `launch_job` and `send_prompt_to_tab` on an idle existing
worker first. Soften "even when it only reads" to apply when the read is
expected to be long.

**Related.** When a platform is held back by the safety-level setting, the
reason shown is the platform caveat rather than "raise the safety level in
Settings" (`coordinator-providers.ts:204-212`).

### 4.4 UI and UX

#### U1. No path from "waiting on workers" or a mail tile to the worker (High for UX, verified)

- The chip at `CoordinatorPanel.tsx:780-803` is a `<span>`. Worker names live
  only in its `title` tooltip, which keyboard and touch users cannot reach.
- `awaitingWorkers` already computes each `environmentId` (`:433,443`) but
  nothing uses it.
- Mail tiles (`chat/MailTile.tsx:233-243`) carry
  `notice.resource.environmentId` and `tabId`, but offer only "open mail
  thread".
- The human-prompt banner says "answer it in the worker's tab" with no link.

**Fix (cheap and high value).**
- Turn the chip into a popover listing each worker with its state and an
  **Open** button (`useUIStore.selectEnvironment` exists), with "needs you"
  rows first and an **Answer** button on those.
- Add **Open environment** and **Open tab** to notice tiles and to the banner.

#### U2. Changing provider is hidden, and closing the main is unconfirmed (High for UX, verified)

- The only explanation of how to change provider is the close button's
  `aria-label` (`CoordinatorPanel.tsx:1000-1004`). `TabShell` renders no
  `title`.
- The X appears only on hover.
- Closing the main settles approvals and revokes the credential, but asks for
  no confirmation, even mid-turn.

**Fix.**
- Add a **Change agent…** item on the main tab (a context menu or a chevron by
  the agent icon). It explains "This closes the current conversation; open
  delegations move to the new one" and lets the user pick the new platform
  straight away.
- Confirm a close while a turn is running or delegations are open.
- Mark the main tab visibly, for example with a crown or "Main" pill.

#### U3. One conversation's startup failure takes over every pane (High for UX, verified)

- `commands-servers.ts:1281` writes `lifecycleState: "error"` on the
  **workspace** when any conversation's bridge fails.
- `CoordinatorPanel.tsx:683-699` then replaces every pane, the main's
  transcript included, with "Coordinator startup failed".
- The message does not say which conversation failed.
- Retry re-runs `ensure` with no progress indicator, and offers no "close this
  conversation".

**Fix.**
- Record the startup error on the conversation.
- Render the card only in that conversation's pane, with **Retry**,
  **Close conversation** and **Copy error**.
- Keep a workspace-level error only for failures that really are
  workspace-wide.

#### U4. Action errors are hidden behind Git errors (Medium, verified)

- `CoordinatorPanel.tsx:923-929` shows
  `git?.lastError?.stderr ?? git?.lastError?.message ?? error`. A retained Git
  error therefore masks every failure from create, close, select, pause or
  resume.
- Even alone, the error sits in a collapsed `<details>` labelled "Repository
  or coordinator error", with no `role="alert"`.

**Fix.** Show coordinator action errors separately: an inline alert or a toast
with `role="alert"`, cleared on the next successful action. Keep Git's retained
error in its own disclosure.

#### U5. Branch switch and Sync are gated on the wrong turn (Medium, verified)

- The UI gates on the **selected** conversation's turn
  (`coordinatorTurnActive`, `CoordinatorPanel.tsx:507-511`).
- The backend refuses while **any** coordinator turn in the project is active
  (`project-git-service.ts:825-827`).
- If Side 1 is focused while the main is running, the picker is enabled. The
  user confirms "Discard and switch", and the backend rejects it into the
  hidden error from U4.

**Fix.** Gate on any active turn in the workspace, and name the busy
conversation in the disabled-state tooltip.

#### U6. Pausing hides the transcript (Medium, verified)

- `CoordinatorPanel.tsx:700-709` replaces every pane with "Coordination is
  paused", so the user cannot reread the analysis they paused to think about.
- The Pause button does not say that it is project-wide or what waits.

**Fix.** Keep the transcript, disable the composer, and show a slim "Paused:
mail and new turns are held. Resume" bar.

#### U7. The worker chip disappears depending on focus (Medium, verified)

- `awaitingWorkers` filters on `association.conversationId === selected.id`
  (`:421`), but only the main delegates.
- Focusing a side agent, or the gap after closing the main, hides running
  workers entirely.
- The tooltip always says "Coordinator is idle", even mid-turn.

**Fix.** Compute from the workspace's main (or all conversations), and phrase
the tooltip from the real turn phase.

#### U8. Side agents are never explained (Medium, verified)

- "+ New side agent" has no tooltip or explanation.
- Nothing in the UI says a side agent can read and mail the main but cannot
  launch workers, or why someone would want one.

**Fix.**
- Add a tooltip and an empty-composer hint, for example "Side agents can read
  the project and talk to the main coordinator, but can't launch workers.
  Good for a second opinion or a parallel investigation."
- Use a distinct placeholder in the side composer.

#### U9. Dead-end states (Medium, verified/reported)

These states tell the user what to do but give no way to do it:
- **"Provider unavailable"** (`:668-681`) offers no action at all: no Settings
  link, no Close, and no "start a new conversation".
- **`emptyPlatformsMessage`** says to "lower the coordinator safety level in
  Settings" but gives no link.
- **"Connect a local checkout"** explains Repository settings but has no
  button.
- **Coordinator settings are scattered**: the safety level and web research
  are under Agent platforms, status updates under Messaging.

**Fix.**
- Every state card should end in a button that performs its own advice.
- Add a **Coordinator** settings section, or at least deep links, that
  gathers the safety level, web research, status updates and the messaging
  prerequisites.

#### U10. First sends in two groups at once can drop the first prompt (Medium, reported)

- `pendingLaunch` is a single slot (`CoordinatorPanel.tsx:127,348,712`).
- Send in Side 1, then in Side 2 before Side 1's first projection arrives:
  Side 1's `initialPrompt` vanishes. Its conversation is bound to the platform
  but nothing was sent.

**Fix.** Key pending launches by conversation id.

#### U11. Accessibility (Medium, reported)

- **Nested interactive controls.** The tab strip uses `useSortable` attributes
  (`role="button"`, `tabIndex=0`) on the TabShell div, which also contains a
  `<button>`. That gives nested controls and two tab stops per tab.
- **No tab semantics.** There are no `tablist`, `tab` or `aria-selected`
  roles.
- **No keyboard drag.** The keyboard sensor is removed with no replacement, so
  keyboard users cannot move a tab to another group or split.
- **Silent spinner.** The loading spinner has no `role="status"` or text.

**Fix.**
- Use proper tab roles.
- Offer "Move to new group / Move to group N" in a context menu as the
  keyboard path.
- Label the spinner.

#### U12. Re-render cost (Medium, performance, reported)

- The panel subscribes to the entire `environments` array (all projects) and
  to portal `nodes` (`:398-400`). Any status change anywhere re-renders the
  1,150-line panel.
- That re-render reaches the transcript controller (about 2,500 lines) in
  every group. An inline `data={{…}}` object and a fresh `onAssignPlatform`
  closure defeat `memo` on `AgentNativeTab`.

**Fix.**
- Select only the environment names the chip needs.
- Memoize `data` and the callbacks.
- Memoize the pane-tree context value.

#### U13. Smaller UX items (Low)

- **Jargon.** `Context rN` means nothing to a user. Replace it with
  "Checkout changed since last turn" when it matters, or hide it.
- **`!` commands.**
  - They are undiscoverable, and the placeholder does not mention them.
  - The footer says commands run in workers, which `!` contradicts.
  - A first message that starts with `!` produces only a toast.
- **Leaf-mode gate** (`LeafModeCoordinatorGate.tsx:55-61`):
  - it can flash the coordinator (and call `ensure`) before portal status
    loads;
  - "Open anyway" resets on every visit despite saying "for this session";
  - an empty controller list renders "controlled by .".
- **Prompt subscriptions** (`:456-470`):
  - `useHumanPrompts` subscribes for every environment ever associated, so the
    set only grows;
  - remote workers are excluded, so their sign-in prompts never reach the
    banner.
- **Picker caveats** can repeat "cannot verify" (`:319-322`). The tier name
  (Enforced, Provider-configured, Advisory) is never shown as a label.
- **Clicking a tab in an unfocused group** writes the selection twice.
  Capture-phase pointerdown runs before `stopPropagation`.
- **Narrow screens.** The toolbar wraps to two or three rows, and
  "New side agent" never collapses to an icon.
- **Web research settings:**
  - Add is silently disabled at the server limit;
  - Enter does not add;
  - the duplicate-name check is case-sensitive.

---

## 5. Toward a better user experience

The individual fixes above are mostly local. Taken together they point to a few
product-level changes.

### 5.1 Make delegated work a first-class, visible object

Today the user learns what the coordinator delegated by reading its prose and
the mail tiles. The backend already has a precise model of each delegation
(`state`, `workerTabId`, `waiting`, `wakeKind`, `selection`).

**Recommendation.** Add a collapsible **Work** rail (or a drawer from the
chip) in the coordinator page. It would list, for the main:

| Worker | What it was asked | Agent / model | State | Since | Actions |
| --- | --- | --- | --- | --- | --- |
| api-fix | "Fix the 500 on /users…" | Codex · default | running | 4 m | Open · Stop |
| docs | "Update README…" | Claude · default | **needs you** (approval) | 1 m | Answer |
| Multi Review #12 | review of api-fix | 2 reviewers | ready to address | — | Open · Address |

- This is the same data as U1 and A6, so the agent tool and the UI can share
  one projection.
- It also makes the launch selection (agent, model, default or requested)
  visible. `coordinator.md` already lists "no marker for overrides" as a
  follow-up.

### 5.2 Explain the model once, in the product

The coordinator has a mental model that is different from any other tab: it
is read-only, delegates, has one main and side agents, the platform is fixed
per conversation, and it is woken by mail.

**Recommendation.** Add a first-run card in the empty main composer, which can
be dismissed and reopened from a "?" in the toolbar, with four lines:
1. *I can read and search this checkout but never change it.*
2. *I hand changes to worker environments and get woken when they finish.
   You don't need to wait.*
3. *Side agents are extra read-only chats that can talk to me.*
4. *To switch AI provider, use **Change agent**. Your workers carry over.*

Add a few starter prompts below it, for example "Explain this codebase", "Plan
a fix for…", "Review my open PR" and "Run a Multi Review on…".

### 5.3 Make the read-only tier legible

The tier is the most important safety fact the user chooses, and today it
appears only as amber caveat text.

**Recommendation.**
- Show a tier pill next to each platform in the picker and in the toolbar
  badge ("Read-only · Enforced" or "Read-only · Provider-configured").
- Give the pill a popover with the one-sentence meaning from the tier table in
  `coordinator.md`.
- Link the safety-level setting from the popover.

### 5.4 Errors that name what failed, and offer the next step

The pattern across U3, U4 and U9 (and the silent view-read failures below) is the same: an error is either global
when it should be local, or hidden. Use one rule for every coordinator surface.
Each error names the conversation or resource it belongs to, renders where that
thing renders, and carries a button for the action it recommends. Pair this
with a stale indicator when a background view read fails
(`useCoordinatorPanelData.ts:224-255` currently ignores error and stale
states).

### 5.5 Feedback while the coordinator is idle but work is running

The async contract is right: the coordinator should end its turn and not poll.
But from the user's side, an idle chat with workers running can look stuck.

- The Work rail (5.1) and a live "next wake expected when api-fix finishes"
  line under the last message would close that gap without adding any agent
  turns.
- Desktop notifications already exist for human prompts. Offering one for
  "coordinator woke with a report" would let users leave the page.

---

## 6. Maintainability

- **`CoordinatorPanel.tsx` (1,150 lines) does too much.** It holds the
  toolbar, Git actions, a hand-rolled selection serializer, the first-launch
  hold, layout bridging, five state cards and two dialogs. Suggested split:
  `CoordinatorToolbar`, `useCoordinatorSelection`, `useCoordinatorLaunches`
  (which also fixes U10), `CoordinatorConversationPane` and
  `CoordinatorStateCard`.
- **Repeated action handling, one busy flag.** The
  `setOperation/setError/try/finally` pattern appears five times; a `runAction`
  helper would remove it. A single `operation` flag disables unrelated
  controls, so a branch fetch blocks "New side agent".
- **"Is this delegation finished?" is decided in three places**:
  `settleWorkerDelegations`, `reconcileWorkerDelegations` and
  `reconcileRemoteDelegation`. Each checks undelivered, grace, background and
  stopped in a different order. Extract one pure `decideDelegation(state,
  observations)` function with a transition table. That also documents the
  state machine, which today is spread over five persisted fields and three
  in-memory maps.
- **Reads that write.** `snapshot()` and `get()` perform adoption and mail
  moves, which ties UI read latency and load to repair logic (see B7).
- **Partial serialization.** `serialize` covers create, ensure and assign, but
  not close, select or pause (see B6).
- **`control-mcp-tools.ts` is 2,002 lines.**
  - The own-mailbox authorization block is copied three times
    (`:1830-1851, 1876-1895, 1962-1983`) even though `ownConversationMailbox`
    exists at `:310`.
  - The `coordinator:${id}:${conv}` runtime id is built by hand in about six
    places instead of calling `coordinatorRuntimeId`.
- **Duplicated request-alias lookup** in `coordinator-review-actions.ts:26-39`
  and `storage-coordinators.ts:343-365`.
- **Context prompt built inline.** The prompt lives as a string concatenation
  inside `NativeAgentService.trustedInput`
  (`native-agent-service.ts:929-960`). Moving it to a pure
  `buildCoordinatorContext(...)` in `packages/protocol` would make it
  unit-testable for size and content, and would let the 0024 live suite
  assert on it.

---

## 7. Suggested roadmap

**Now (safety and availability, about 1–2 days):**
- S1: project-home guard on `send_message` and `list_environments`, with a
  test.
- B2: per-item error handling in the wake and reconcile loops.
- B3: rerun flag on wake delivery.
- A1: gate delegation on messaging being enabled.
- U4: separate action-error alert.
- U5: gate Git actions on any active turn.

**Next (the UX lift, about 1 week):**
- U1 and 5.1: an actionable worker chip, then the Work rail.
- U2: **Change agent…** and a main-tab marker.
- U3: per-conversation startup errors.
- U6: paused but readable.
- U7: chip independent of focus.
- U8 and 5.2: side-agent explanation and first-run card.
- U9: actionable state cards and a Coordinator settings section.
- A2: optional `agent`.
- A3: request-id guidance.
- A6: delegation state exposed to the agent.

**Then (scale and structure):**
- B1: association retention and a per-project cap.
- B4: node-forget cleanup.
- B5: backfill cutover.
- B6: serialize close.
- B7: sweep and snapshot cost.
- A4: semantic poll guard.
- A5: trim the tool surface and drop the legacy node tools.
- U10–U12.
- The section 6 refactors.

**Existing qualification work** (0024, 0026, 0172) stays as ranked in
`docs/todo/coordinator-and-multi-review/0000-index.md`. Nothing here changes
it, except that S1 deserves a live `read-only` scenario step: "mail the
project home and check that the checkout digest is unchanged".

---

## 8. Notes on this report

- The repository's own
  convention (`docs/README.md` § Layout) is that dated review notes do not
  live under `docs/`, and that remaining work goes into numbered
  `docs/todo/` files. If this report is accepted, the findings should be
  moved into a new todo file under `docs/todo/coordinator-and-multi-review/`
  (or into 0142 for the product items), and this report deleted.
- Line numbers are from `1aabf049` and will drift.
