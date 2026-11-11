# Suborks

Status: living. Owner modules:
[`suborks.ts`](../../packages/protocol/src/suborks.ts) (limits, views, target
resolution, carrier, delivery body),
[`native-agent-suborks.ts`](../../apps/backend/src/core/native-agent-suborks.ts)
(the service),
[`native-agent-subork-host.ts`](../../apps/backend/src/core/native-agent-subork-host.ts)
(the branch host),
[`agent-tools-suborks.ts`](../../apps/backend/src/core/agent-tools-suborks.ts)
(the tool on native tabs),
[`control-mcp-coordinator-suborks.ts`](../../apps/backend/src/core/control-mcp-coordinator-suborks.ts)
and [`coordinator-subork-actions.ts`](../../apps/backend/src/core/coordinator-subork-actions.ts)
(the same tool in coordinator conversations) and
[`storage-suborks.ts`](../../apps/backend/src/core/storage-suborks.ts) (the store).
Outstanding live checks:
[4340](../todo/agent-engines/4340-suborks-live-qualification.md).

From any native agent tab, an environment's or a coordinator conversation, the
active agent asks one or several other agents and gets their answers back. A subork runs on Orkestrator's own agent machinery
(`AgentBranchRunner`), not the provider's sub-agent framework, so it behaves the
same whichever agent is asking and whichever is asked.

```text
/subork ask codex to review this index.html
/subork ask opus 5.5 and grok 4.7 to rate this code change out of 10
ask opus 5.5 and grok 4.7 to rate this code change out of 10
```

## How a call moves

```text
person --/subork or plain text--> caller agent
caller agent --ask_agents--> backend: resolve targets, store one row, return a handle
caller agent ends its turn
backend --AgentBranchRunner, in parallel--> read-only session per target
every target settled --> one mail to the caller's mailbox, on the system route
mail drain --new turn when idle--> caller continues with the answers
```

`/subork <request>` is an instruction to the current agent. The backend rewrites
it into a carrier (`renderSuborkRequestCarrier`) that always opens with a tag, so
no provider reads it as its own command, and asks the agent to call `ask_agents`.
The agent names the targets and writes a self-contained prompt. The backend never
parses natural language. The plain-text form works because the tool is offered to
every tab and its description says when to use it. A real OpenCode 1.x process
showed the path from a plain-text request to the tool (see
[Real-process evidence](#real-process-evidence)), but what a real model does with the
description is [not yet qualified](../todo/agent-engines/4340-suborks-live-qualification.md).

Retention keeps compact call receipts until environment deletion. A retry of a pruned
request returns its original handle and an expiry notice, without starting targets
or sending another message. Receipts retain identity, outcome and session usage
counts, but no prompts, answers or transcript references.

## Results delivery

**`ask_agents` returns a handle at once, and the answers come back in one agent
mail on the system route, which wakes the caller.** The two options were:

| | A tool call that waits | A handle, then mail (chosen) |
| --- | --- | --- |
| Provider tool timeouts | Fails where a provider's MCP client gives up first. Those limits differ per provider and are not all configurable, while a subork legitimately runs for many minutes | Not exposed: the call returns in moments |
| The caller's turn | Held open, showing as working, with a long-lived HTTP request behind it | Ends normally. The caller is idle and interruptible while suborks work |
| Backend restart | Severs the request, so the caller loses the answer and may retry the billed work | The row and the mail are durable. The next process resumes the turns, and the mail is idempotent on the call's id |
| Stop | Must interrupt a call parked inside a provider's tool runtime | Stops the row directly |
| Waking the agent | Implicit | Uses the mail drain, its presence gate, dispatch journal and automatic retry, already qualified on every provider |
| Reader's view | Answers in one provider tool result | Answers arrive as a new turn, so the agent continues in the next turn, not the same one |

A waiting call cannot meet "the result must reach the caller even if its turn
ended or the backend restarted", and mail can. So every provider behaves the same
way, and the tool's description and its result tell the agent to end its turn.
The caller receives the answers as a new turn, not as a continuation of the turn
that called the tool.

Mail details that follow from this:

- One message per call, sent once every target has settled, so answers arrive
  together. `requestId` is `subork:<batchId>`, so a crash between settling and
  recording the send repeats the same mail, which the store deduplicates.
- The sender is `system`, whose route wakes the recipient whatever the default
  inject policy is and sits outside the wake budgets. Waking still respects an
  explicit per-tab **Off**: the mail is stored, the tool's result warns the agent,
  and the group says the answers did not wake it. A muted inbound tab is refused
  up front. With messaging turned off in settings, the tool refuses the call.
- If the mail cannot be placed, the group reports it. The answers stay readable
  on the rows and in the transcripts.

## The tool

`ask_agents`, with the same name, shape and behaviour on every provider. An
environment's tabs get it from the general agent tools server; a coordinator
conversation, which has no agent tools server, gets it from its control MCP
(`ask_coordinator_suborks` behind it). Both register the one schema and
description in `agent-tools-subork-schema.ts`. It is listed for every tab because
a provider may cache its tool list, and like `report_goal` it never prompts for
approval: it writes only to Orkestrator's own store and starts read-only sessions. Its
description (`SUBORK_TOOL_DESCRIPTION`) is what the plain-text form depends on, so
it says when to use the tool, that it replaces the agent's own sub-agents for these
requests, that a subork sees only the prompt, and to end the turn after calling.

```jsonc
{
  "targets": [
    {
      "agent": "codex",        // an agent: alone, its saved default
      "model": "opus 5.5",     // a model as the person said it
      "name": "Opus review",   // optional: the row's title
      "prompt": "..."          // optional: replaces the shared prompt
    }
  ],
  "prompt": "...",             // what every target receives
  "requestId": "...",          // optional: repeating it repeats nothing
  "tabId": "..."               // only on a shared, environment-wide credential
}
```

**Targets** (`resolveSuborkTarget`). `codex` means that agent's saved default,
resolved as a launch resolves it. `opus 5.5` and `grok 4.7` match the catalogue's
ids, labels, resolved models and aliases, word by word, so `opus 5.5` finds
`claude-opus-5-5`. A model's own agent wins over a harness that also offers it:
Cursor, OpenCode and Pi are searched only when no other agent matches. An unknown,
ambiguous or disabled target fails on its own with a message listing close options,
and never guesses.

## What a subork is

- **Only its prompt.** The session is new, with a key of its own, and nothing about
  the caller reaches it. `renderSuborkPrompt` adds fixed instructions and the
  branch adds the attempt's result instruction; there is no other input.
- **Same environment, read-only.** It runs in the caller's environment and
  working directory as a plan turn with `readOnly: true`, the same boundary a
  goal's verifier and a reviewer use, and interactions are declined unattended.
  A coordinator's working directory is the project's own checkout, so its
  suborks run in the project home, the environment for that checkout
  (`runEnvironmentId` on the row).
- **It answers once.** The result is `submit_subork_answer` (result kind
  `subork-answer`). A turn that ends without submitting gets the runner's one
  reminder; if it replies in prose after that, the prose is the answer, because a
  subork's result is text. Provider rollouts that exclude this kind fail that
  target rather than falling back, since a structured-output turn would keep the
  environment's tool connection.

Read-only is held as strongly as each provider holds it, and each row records the
tier. Below `enforced`, Orkestrator adds its own check, the workspace read-only
guard (`workspace-read-only-guard.ts`, the one build pipeline reviews and graph
nodes use), so on every provider a subork that changed the workspace does not
return an answer:

| Provider | Tier | What the provider holds | Orkestrator's guard |
| --- | --- | --- | --- |
| Claude | `enforced` | The Agent SDK's sandbox and read-only allowlist | Only where the sandbox cannot run commands, which makes it `provider-configured` |
| Codex | `enforced` | Its read-only sandbox | None needed |
| Pi | `enforced` | The bridge's tool gate | None needed |
| Cursor | `provider-configured` | Sandbox and tool restrictions, which the SDK offers no way to verify | Yes |
| OpenCode | `provider-configured` | Its permission rules; it always loads the checkout's project configuration | Yes |
| Grok | `advisory` | Write, edit and shell tools are removed and permission requests denied; a tool that does not ask is not stopped | Yes |

The guard, for a call with any guarded subork:

1. **Before anything is sent**, it records HEAD and the Git-visible uncommitted
   paths of the environment the suborks run in, once per call
   (`workspaceBaseline` on the row), because they share the workspace. If that
   state cannot be read (not a Git worktree, a failing probe), the guarded
   targets fail on their own with that reason and never start; the others run.
2. **When a guarded subork submits**, a change since the baseline is refused as a
   correctable `worktree_changed` error naming the paths, so the subork can put
   the tree back within its own turn.
3. **When its answer is consumed**, the tree is compared again. A change fails
   that subork with the paths named, its answer is dropped, and the delivery says
   so. Nothing is reset: the workspace is the evidence. `certified` on the branch
   makes this happen once, also when a restart falls between the answer and the
   check.

What remains, named: the guard **detects; it does not prevent**. A guarded subork
can still write, and what it wrote stays until a person removes it. It sees only
what `git status` sees plus HEAD: ignored files, `.git/` internals and paths
outside the worktree are invisible, and so is a further edit to a path that was
already uncommitted at the baseline. It cannot tell who changed the tree, so
anything else writing the workspace while a guarded subork runs (the caller, a
person, another tab) fails it too; the tool's result tells the caller not to
change files until the answers arrive. The tier comes from the shared enforcement
matrix (`agentPolicyEnforcement`) and is unchanged by the guard; the transcript
dialog names an advisory tier and says when a change fails the answer.

## Limits

`SUBORK_LIMITS`, all enforced at the backend:

| Limit | Value | Over it |
| --- | --- | --- |
| Targets per call | 4 | Extra targets fail on their own |
| Running at once per session | 8 | New targets fail on their own |
| Started per session, ever | 64 | New targets fail on their own. It survives retention and restarts through each row's running total |
| Prompt | 64 KiB | That target fails: name files rather than pasting them |
| Response kept | 64 KiB | Kept from the start; the delivery marks the cut |
| Answers in the mail | 30 KiB in total | Shared fairly after reserving frames, UTF-8 labels and cut notices within the 32 KiB mail limit; each cut points to the transcript |
| Calls retained per session | 16 | The oldest finished call loses its payload and transcripts; a compact retry receipt remains |
| Running time | 45 minutes | Fails that target; the runner's stall and idle bounds usually end it sooner |

**Depth is 1.** A subork's turn runs on a result-only credential that lists
`ask_agents` as a refusal, so the attempt gets a clear answer. On OpenCode a subork
runs in a reviewer session, which takes no per-turn tool map, so its session
permission rules (`openCodeWorkflowResultPermissionRules` in
`opencode2/policy-rules.ts`, translated by `opencode2/permissions.ts`) deny
`orkestrator_ask_agents` on every workflow turn, and on a subork's turn deny the
whole `orkestrator` server (`orkestrator_*`) apart from its own result tools. That
leaves an OpenCode subork the same Orkestrator tools as a subork elsewhere. The
real-process test on OpenCode 1.x, whose `orkestrator` connection was
environment-wide, found that without these rules OpenCode offered the subork
`ask_agents` and the ticket tools. The
`ask_agents` rule is not lifted when the turn settles. Only sessions Orkestrator runs
itself take workflow turns, and those cannot start suborks anyway. An
environment-wide credential is refused for any other platform's tab: only an
OpenCode tab could be the caller on one, and since 1.x was retired an OpenCode tab
connects with its own tab credential (`opencode2/turn-connections.ts`).

## Lifecycle

- **Durable.** `native-agent-suborks` holds one row per call, with each target's
  runner record. `init` resumes running rows, and the runner's dispatch journal
  and proof-based recovery mean a restart never sends a turn twice.
- **Stop.** Stopping the caller, the group's Stop button (a turn that has ended has
  no other Stop to press) and closing its tab all stop the session's running calls.
  The row is committed first, so a pass in flight is fenced by its next read or
  save, and a turn it had just sent is aborted once more. Pending admissions, including queued calls, are fenced when the caller stops.
  Waiting deliveries are durably stopped, and mail publication and injection
  check that fence. A stopped call sends no
  mail, and Stop withdraws answers that have not reached the caller yet. A sweep
  stops a call whose caller's session has gone.
- **Environment.** A call whose environment stops resolves its running targets as
  failed. Deleting an environment removes its calls and transcripts.
- **Metering.** Each target's token count is on its row, and its turns are recorded
  in the usage history in the caller's environment.
- **Coordinators.** `/subork` and `ask_agents` work in main and side
  conversations alike. The control MCP tool's command revalidates the
  conversation's scope, runs the suborks in the project home (created on first
  use, as the toolbar does) and sends the answers to the conversation's own
  mailbox; its session's rows and Stop find them under the conversation's session
  key. Closing the conversation stops its calls, because mail to a closed
  conversation is redirected to the coordinator's current main. A project with no
  local checkout has no project home, so the call is refused with that reason.
  Deleting the project home removes the calls that ran in it.

## Where `/subork` does not apply

`/subork` is a composer command of native agent tabs, and it works in every one,
on all six providers. Two kinds of session are not native agent tabs, and each
gives its reason:

- **Sessions Orkestrator runs itself**: pipeline workers, reviewers, goal
  verifiers and suborks. Nobody types into them, and their turns are driven by
  their owner, so a mail that woke one would start a turn its owner never asked
  for. `/subork` sent to one is refused before anything reaches the provider
  ("This session is run by Orkestrator itself…"), `ask_agents` refuses a pipeline
  tab's credential ("a pipeline tab cannot be woken with the answers"), and a
  subork's own credential refuses the tool (depth 1).
- **Terminal tabs.** A provider's CLI in a terminal reads `/subork` as its own
  input; Orkestrator does not see it. `ask_agents` refuses a terminal tab's
  credential for the same reason as a pipeline's.

## Transcript

`projection.suborks` carries a bounded view of each call, read from the service's
index, so a session with none costs nothing and a reload shows the same rows. The
web derives one client-only row per call and places it by time
(`withSuborkGroupRows`), so it looks the same whichever provider made the call.

`SuborkGroup` shows stacked provider marks, `3 suborks`, a status line such as
`1 working · 2 done`, the group's clock and a chevron, then one button per subork:
its provider mark with a status dot, its name, one line (the latest action, the
start of its response, or why it failed), its clock and a chevron. A row opens
`SuborkTranscriptDialog`, which reads the stored transcript with
`native_agent_subork_transcript`. Transcripts live in the content-addressed store a
graph step's do, captured at most every 15 seconds and at the end, and reading them
touches no provider. Reads are bounded to 4 MiB per page. The dialog labels partial
transcripts and offers **Next page** and **Back to start**, using the stored
message index; it retains only the current page. A message larger than the page
limit is identified and can be skipped to reach later messages.

The `/subork` row shows the person's words (`withSuborkRequestText`), not the carrier.

## Local and container environments

Both use the same path: the bridge is reached through `graphAgentBridgeConnection`
and the tool connection names `host` or `container`, with the reachability check a
container turn needs. The guard's probe is the backend's
`get_environment_uncommitted_paths` command, which answers for both kinds. Provider
fakes cover both paths. A local environment has real-process evidence on OpenCode
2 (below), as it had on OpenCode 1.x. No container run with a real provider has been done yet
([4340](../todo/agent-engines/4340-suborks-live-qualification.md)).

## Real-process evidence

`opencode2/opencode2-suborks.live.test.ts` runs the pinned OpenCode 2
`opencode2 serve` (2.2.6) against a scripted OpenAI-compatible model on loopback,
with a throwaway `HOME`, XDG directories and database (`startOpenCode2Fixture`), so
it makes no billed turn and needs no login. It is part of `mise run
verify:opencode2:live`. Everything else is real: the agent tools server, the subork
service, the branch runner and the mail drain. It passed on 2026-11-11 and shows,
in a local environment:

- The plain-text request *"Please ask codex and opencode to review this
  index.html"* reaches a model that is offered the caller tab's `ask_agents` (on
  its per-tab MCP server, `orkestrator_tab_<hash>_ask_agents`) with the shared
  description. OpenCode 2's own MCP client carried the call on the tab's
  credential and got the handle back.
- The real OpenCode 2 subork ran as a read-only result turn: it was offered
  neither `edit`, `write` nor 2.x's own `subagent`, no `ask_agents` and no tab
  tool, only Orkestrator tools of its result connection; it saw the prompt and not
  the caller's words, and answered through `submit_subork_answer`.
- Both answers (the second from a Codex fake) arrived labelled in one mail, and the
  real mail drain continued the real caller session with them.

The same run on OpenCode 1.x (`native-agent-suborks-opencode.live.test.ts`,
2026-11-04, removed with 1.x on 2026-11-11: `git show
5f4e27b1c:apps/backend/src/core/native-agent-suborks-opencode.live.test.ts`) showed
the same on the environment-wide credential.

The script, not a model, decided to call the tool. Whether real models choose
`ask_agents` for plain text, and how the other five providers behave against a live
model, still needs live evidence.
