# Suborks

Status: living. Owner modules:
[`suborks.ts`](../../packages/protocol/src/suborks.ts) (limits, views, target
resolution, carrier, delivery body),
[`native-agent-suborks.ts`](../../apps/backend/src/core/native-agent-suborks.ts)
(the service),
[`native-agent-subork-host.ts`](../../apps/backend/src/core/native-agent-subork-host.ts)
(the branch host),
[`agent-tools-suborks.ts`](../../apps/backend/src/core/agent-tools-suborks.ts)
(the tool) and
[`storage-suborks.ts`](../../apps/backend/src/core/storage-suborks.ts) (the store).
Outstanding live checks:
[4340](../todo/agent-engines/4340-suborks-live-qualification.md).

From any native agent tab, the active agent asks one or several other agents and
gets their answers back. A subork runs on Orkestrator's own agent machinery
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
every tab and its description says when to use it: live model behaviour for that
form is [not yet qualified](../todo/agent-engines/4340-suborks-live-qualification.md).

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

`ask_agents`, on the general agent tools server, with the same name, shape and
behaviour on every provider. It is listed for every tab because a provider may
cache its tool list, and like `report_goal` it never prompts for approval: it
writes only to Orkestrator's own store and starts read-only sessions. Its
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
  "tabId": "..."               // only for OpenCode's shared credential
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
- **It answers once.** The result is `submit_subork_answer` (result kind
  `subork-answer`). A turn that ends without submitting gets the runner's one
  reminder; if it replies in prose after that, the prose is the answer, because a
  subork's result is text. Provider rollouts that exclude this kind fail that
  target rather than falling back, since a structured-output turn would keep the
  environment's tool connection.

Read-only is held as strongly as each provider holds it, and each row records the
tier:

| Provider | Tier | What holds it |
| --- | --- | --- |
| Claude | `enforced` | The Agent SDK's sandbox and read-only allowlist. `provider-configured` where the sandbox cannot run commands |
| Codex | `enforced` | Its read-only sandbox |
| Pi | `enforced` | The bridge's tool gate |
| Cursor | `provider-configured` | Sandbox and tool restrictions, which the SDK offers no way to verify |
| OpenCode | `provider-configured` | Its permission rules; it always loads the checkout's project configuration |
| Grok | `advisory` | Write, edit and shell tools are removed and permission requests denied; a tool that does not ask is not stopped |

A subork on Grok is therefore not a hard boundary. The tier comes from the shared
enforcement matrix (`agentPolicyEnforcement`), and the transcript dialog says so
when it is advisory.

## Limits

`SUBORK_LIMITS`, all enforced at the backend:

| Limit | Value | Over it |
| --- | --- | --- |
| Targets per call | 4 | Extra targets fail on their own |
| Running at once per session | 8 | New targets fail on their own |
| Started per session, ever | 64 | New targets fail on their own. It survives retention and restarts through each row's running total |
| Prompt | 64 KiB | That target fails: name files rather than pasting them |
| Response kept | 64 KiB | Kept from the start; the delivery marks the cut |
| Answers in the mail | 30 KiB in total | Shared fairly, so short answers stay whole, and each cut is marked with where the full text is |
| Calls retained per session | 16 | The oldest finished call is removed with its transcripts |
| Running time | 45 minutes | Fails that target; the runner's stall and idle bounds usually end it sooner |

**Depth is 1.** A subork's turn runs on a result-only credential that lists
`ask_agents` as a refusal, so the attempt gets a clear answer. OpenCode's connection
is environment-wide, so a workflow turn's tool map also removes the tool there. An
environment-wide credential is refused for any other platform's tab: only OpenCode's
own tab can be the caller on one.

## Lifecycle

- **Durable.** `native-agent-suborks` holds one row per call, with each target's
  runner record. `init` resumes running rows, and the runner's dispatch journal
  and proof-based recovery mean a restart never sends a turn twice.
- **Stop.** Stopping the caller, the group's Stop button (a turn that has ended has
  no other Stop to press) and closing its tab all stop the session's running calls.
  The row is committed first, so a pass in flight is fenced by its next read or
  save, and a turn it had just sent is aborted once more. A stopped call sends no
  mail, and Stop withdraws answers that have not reached the caller yet. A sweep
  stops a call whose caller's session has gone.
- **Environment.** A call whose environment stops resolves its running targets as
  failed. Deleting an environment removes its calls and transcripts.
- **Metering.** Each target's token count is on its row, and its turns are recorded
  in the usage history in the caller's environment.
- **Coordinators.** A coordinator conversation has no agent tools, so `/subork`
  there is refused with that reason. Pipeline workers and terminal tabs are not
  offered a way to be woken, so the tool refuses them too.

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
touches no provider.

The `/subork` row shows the person's words (`withSuborkRequestText`), not the carrier.

## Local and container environments

Both use the same path: the bridge is reached through `graphAgentBridgeConnection`
and the tool connection names `host` or `container`, with the reachability check a
container turn needs. Provider fakes cover both paths. Neither has live evidence yet
([4340](../todo/agent-engines/4340-suborks-live-qualification.md)).
