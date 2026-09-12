# Project Coordinator

Status: Living — product coordinator guide.

Select a project to open **Coordinator**, the default project page. Coordinator
can read and discuss the configured local checkout, search the code, and use
Orkestrator controls to delegate implementation to isolated worker environments.
It cannot edit the project checkout itself.

The repository toolbar shows the canonical path, branch, upstream freshness,
ahead/behind state, local changes, and any retained Git error. **Refresh** fetches
remote state. **Sync** performs only a fast-forward pull. Branch switching and
sync are disabled for dirty/conflicted repositories, an ongoing merge/rebase,
an occupied worktree branch, or an active coordinator turn. These buttons are
explicit user actions; the coordinator agent cannot invoke them.

Conversations and workflow links are durable. Leaving the page, switching to an
environment, reloading the renderer, or restarting the backend does not discard
them. Closing a conversation revokes its orchestration credential and closes its
mailbox without deleting provider history. If all conversations are closed, use
**New conversation**; Orkestrator does not silently recreate one.
Removing the project stops its Coordinator and deletes the isolated Coordinator
runtime, including retained Codex rollouts and attachments.

## Choosing an agent

A conversation has no agent until its first prompt. The composer offers every
platform this machine qualifies, with the repository default preselected, and
the first send binds the conversation to whichever was chosen. That binding is
one-way: the transcript and rollout belong to that platform, so a different one
means a new conversation. Re-assignment is allowed only while the first send has
not yet reached a provider, so a failed start does not strand the conversation.

A valid project local path is required. Control MCP may be disabled globally;
chat remains read-only and usable, while the page shows that delegation
controls are unavailable.

## Provider qualification

Coordinator runs against the project's real checkout, so how strongly a
platform holds the read-only boundary is a property worth naming rather than
flattening to available/unavailable. Each platform is offered at one of three
tiers, shown in the picker when it carries a caveat:

| Tier | Meaning | Platforms |
| --- | --- | --- |
| `enforced` | The provider or the OS blocks the mutation whatever the agent attempts | Codex; Claude where its command sandbox is available; Pi |
| `provider-configured` | The SDK is told to deny, and exposes no way to verify it | OpenCode, Cursor |
| `advisory` | The agent is asked to request permission first; a tool that does not ask is not stopped | Grok |

**Settings → Agent platforms → Coordinator safety level** chooses the weakest
tier this installation will offer. It defaults to `provider-configured`, which
is also the recommended level: `enforced` and `provider-configured` platforms
are offered, and `advisory` stays opt-in.

What each enforced platform actually does:

- **Codex** runs under a permission profile that denies the filesystem and the
  network inside the child process, with `sandbox: read-only`,
  `approvalPolicy: never`, and a private `CODEX_HOME` holding only `auth.json`.
  The bridge refuses to run a turn unless app-server echoes the profile back.
- **Claude** runs with the SDK command sandbox on and `allowUnsandboxedCommands`
  off, `permissionMode: dontAsk`, an allowlist that excludes every writing tool,
  `settingSources: []`, a private `CLAUDE_CONFIG_DIR` holding only the
  credential, and a bridge-owned `PreToolUse` hook. The hook is the real
  boundary for shell: it allows a fixed list of reading commands and refuses
  pipes, redirection, substitution and chaining, because a composed command is
  not the one that was checked. Where the host has no command sandbox — Windows
  — Claude drops to `provider-configured` automatically.
- **Pi** blocks every tool outside its read-only set in its own `tool_call`
  gate, which runs in the bridge process and cannot be switched off by the
  workspace.

OpenCode denies through its own permission rules and runs its `plan` agent, but
always loads the checkout's project configuration, including any MCP servers it
declares. Cursor applies the sandbox and a tool ban but exposes no approval
callback, and is refused outright if its sandbox cannot be enabled.

Every coordinator bridge is launched with
`ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only`. That is process
authority: the bridge replaces whatever policy a request body or a persisted
record carries, so a permissive record cannot survive a restart and widen a live
conversation.

## Attachments

Pasted images and other prompt attachments are staged under application data, in
a per-conversation directory, never in the checkout a coordinator may not write
to. A bridge otherwise confines an attachment path to its session's workspace,
so each coordinator bridge is launched with
`ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT` naming that one directory as a second
readable root; Codex additionally grants it `read` in the conversation's
permission profile. Like the execution policy, this is process configuration —
a request body cannot name a root of its own — and it is scoped to the one
conversation, so a bridge cannot read another's attachments. Deleting the
project removes them with the rest of the coordinator runtime.

## Worker delegation

Delegation is a round trip, not one outbound call. `launch_environment` goes out
over MCP, and the worker's result comes back as agent mail — so a platform needs
both an MCP client and a native mailbox that can pull, ack, and be injected
into.

**Delegation is available on every native platform** that has an MCP client
and `{canPull,canSend,canInject}=true`: Claude, Codex, OpenCode, Pi, Cursor,
and Grok. Cursor and Grok receive a per-tab `agentMcp` on create/prompt;
the process-env token is only the fallback. Grok still needs the host
safety setting to admit `advisory`.

A platform's caveat is carried on its qualification `reason` and shown in the
picker, so the limitation is readable when the platform is chosen rather than
discovered when a worker never reports back.

Worker delegation records an explicit base branch and commit. Uncommitted root
changes are not copied, stashed, or committed into a worker. A container worker
can start only from a commit published to a remote branch; unpublished commits
remain available to local workers. Coordinator mail, worker replies, and workflow
completion notices are durable and can wake an idle participant, but stored,
injected, acknowledged, and completed remain distinct states. Pause or mute
messaging, or set a mailbox's injection policy explicitly to **Off**, to hold
automatic delivery.

## Complete application actions

Use `launch_multi_review` for an environment's **Multi Review** button. Pass a
stable `requestId`, the environment ID, and the same `reviewers` and `fixModel`
rows accepted by the launch dialog (`agent`, `model`, optional
`reasoningEffort`). `get_launch_options` supplies available model choices.
The caller chooses the rows explicitly; this API does not invent reviewer
defaults. Omitted `targetBranch` and `reviewInstruction` use the repository's
PR base branch (falling back to `main`) and the global review instruction.
An empty instruction explicitly clears the instruction for this launch.

This action has no build-pipeline prerequisite. It reopens an active review
regardless of the new selections, or reserves an immutable workflow ID and
starts one review. It then creates or focuses the root Multi Review tab in the
environment's selected pane. It does not change the global project/environment
navigation: an inactive environment receives the durable tab and selection,
which its renderer adopts when the user returns.

`open_multi_review` reopens/focuses that root without starting work.
`open_multi_review_fix` opens/focuses the authoritative Fix provider session
without sending a turn. `address_multi_review` now opens the root first and
records the backend's idempotent fix handoff; the supervisor publishes and
selects Fix after confirmed dispatch when the foreground action initiated that
attempt. A background retry or backend-restart resume publishes Fix without
changing the current tab or pane. A repeated address call returns the existing
interactive handoff. An unassociated workflow started from the renderer remains
available within its project. When an association exists, these controls require
it to belong to the current coordinator conversation; use `adopt_workflow` for
an orphaned or closed conversation's association before opening it.

Read the result before reporting success:

- `outcome: "opened"` and `ui.status: "opened"` confirm durable presentation;
  `ui` names the tab, pane, and layout revision. `reused` distinguishes reattach
  from a new launch. MCP returns a bounded workflow summary; backend commands
  return the workflow snapshot with controller fences removed.
- `outcome: "pending"` on address confirms a durable intent, not prompt delivery.
  Inspect `get_multi_review` for `addressPromptPending`, `presentationError`, and
  `fixTabId`. Do not send another fix prompt manually.
- `outcome: "partial"` is an MCP error result with the saved workflow and an
  actionable `recovery` message. A new launch whose tab cannot be published
  requests cancellation. Cancellation may still be in progress or unconfirmed;
  the result says which. An already active review is never cancelled because
  reattachment failed. Completed cancellation records are retained as retry and
  recovery evidence, rather than deleted as the renderer's older handler did.

Retry launches with the same request ID and payload. The durable coordinator
receipt and reserved workflow identity survive backend restarts, including the
gap between workflow persistence and receipt completion. Reusing a key with a
different payload is rejected. If the associated workflow was explicitly
deleted, retry fails instead of silently starting fresh work. Change the key
only when deliberately asking for a new action.

Tab writes recompute their semantic intent against the latest layout after a
CAS conflict. They preserve concurrent pane structure, moves, and tabs, enforce
the tab limit on each attempt, and announce the existing `pane-layout` resource.
Workflow writes announce `multi-review`. Both initial restoration and live
authoritative reconciliation load referenced workflows before installing tabs.
Initial restoration handles a pane snapshot newer than the workflow-list
snapshot; default terminal seeding checks current store state so a stale render
cannot take focus from a newly published tab.
Older pane schema versions require the normal renderer migration before these
controls modify them; container generations are never silently replaced.

### Exposed-action audit

| Existing control / button family | Durable consequences and disposition |
| --- | --- |
| `start_multi_review` / Multi Review | Backend-only and build-gated; retained for diagnostics/recovery. Its metadata explicitly prefers `launch_multi_review`, which adds root-tab publication, focus, readiness checks, reattachment, and truthful recovery. |
| Multi Review open / Open fix session | Added `open_multi_review` and `open_multi_review_fix`; operate entirely through backend snapshots and pane persistence. No additional provider turn. |
| `address_multi_review` / Address findings | Upgraded to the complete action above. Existing backend handoff already owns session adoption, turn idempotency, and eventual Fix publication; it now selects that tab when published and reports queued/partial outcomes. |
| `start_build_pipeline` / Build | Already complete: `BuildPipelineService` owns environment provisioning, workflow persistence, Kanban/feature ownership, root-tab creation and selection, with supervisor repair. Reuse it; no duplicate wrapper added. |
| `pause_build_pipeline`, `resume_build_pipeline`, `cancel_build_pipeline`, `cancel_multi_review` | Backend transitions already durable; these buttons have no required new pane or tab consequence. |
| `launch_environment` / New environment | Existing backend operation owns creation, startup tab/initial-prompt state, and background start. Its accepted/created/error distinction already reports partial startup. |
| `launch_job` / Agent action | Already creates a durable native tab, binds a provider session, and dispatches an idempotent initial turn. Now requests tab activation, matching the button. Later binding/retry writes preserve focus so slow launch completion cannot steal a user's newer selection. |
| `send_prompt_to_tab` | Existing durable intent dispatcher; targets an existing native tab and creates no additional tab. |
| Start/stop environment, ticket edits, adoption, mail | Existing backend mutations; no renderer-only workflow launch step. Mail preserves separate stored/injected/acknowledged outcomes. |

Terminal/tmux launch already has a backend `launch_terminal_job` command with
stable tabs, process ownership and bootstrap journaling, but it is not currently
exposed by coordinator MCP. Browser launch/navigation, arbitrary pane editing,
custom-fix model switches, reviewer subtabs, looped review and feature-plan
launch are likewise not exposed coordinator controls. New APIs for those buttons
are deferred to their own authority and idempotency designs; this change does
not add speculative surfaces. Repository checkout mutation controls remain
unavailable to coordinators.

## Delegation is asynchronous

A coordinator turn ends when it has delegated. It does not wait for the worker,
so the composer stays open and the next thing you type runs as the next turn —
before any worker mail, which is held behind a queued prompt on purpose.

Each launch, job, or message to a worker opens one **delegation**, and each
delegation wakes the conversation exactly once, when that worker's turn ends.
Nothing the worker does in between reaches the coordinator: progress mail is
stored and readable, but held, and released together with the final report so
one delegation produces one turn rather than one per message. A worker that
finishes without reporting still wakes its coordinator, with a notice saying so.
A worker blocked on an approval or a question has not finished — that needs a
person. The toolbar keeps showing that the selected conversation is waiting on
the worker without inferring tab-level attention from an environment-wide
status.

Because a coordinator is woken rather than waiting, it has no reason to poll.
Repeatedly reading an unchanged mailbox returns the page with the delegation
contract attached, and the platforms hold the same line at the tool
level: Claude's read-only shell has no `sleep`, `watch` or `timeout`, and its
scheduling and monitoring tools are refused with an explanation rather than a
bare denial.
