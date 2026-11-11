# Control MCP for voice clients

Status: Living — setup and behaviour of the Control MCP `voice` profile.

A realtime voice agent can drive Orkestrator through Control MCP with a small,
always-loaded tool list, and reach every other public action on demand. This
guide covers setting one up; [control-mcp.md](control-mcp.md) describes
credentials, profiles, confirmation and authority for every client.

## Set up a voice client

1. Open **Settings → MCP**, create a credential named for the client and pick
   the **Voice** profile.
2. Choose **Copy setup** under **Other or voice client**. It copies:

   ```json
   {
     "url": "http://127.0.0.1:34122/mcp",
     "transport": "streamable-http",
     "headers": { "Authorization": "Bearer YOUR_TOKEN" }
   }
   ```

3. Give the voice runtime that URL and header. It must run on the same
   machine as Orkestrator, or reach it through a local relay (below).

The voice profile lists sixteen tools, about 9.6 KB of `tools/list` (the budget
is 10,240 bytes, enforced by `control-mcp/voice.test.ts`). Its default capabilities
leave out project and settings edits, destructive environment actions and
`exec`. Create a `custom` credential, or grant `exec` explicitly, for more.

## The tools

| Tool | What it does |
| --- | --- |
| `overview` | Counts of projects, environments and sessions, and the top five things needing attention. Answers "what's going on?" in one call. |
| `resolve_target` | Turns a spoken name ("the auth environment", "the first Codex tab" within an environment) into an ID. One exact match wins; anything else is `ambiguous-target` with up to five candidates to ask about, or `not-found`. It never guesses. |
| `read_session` | The last 3 messages, about 600 characters each (`detail: "full"`: the last 10). When the newest is delivered mail, `messages` keeps the stored text and the spoken line names its sender and subject, plus any trailing user text (excluding the structured-prompt transport suffix). A cut transcript reports that the latest sender and batch size cannot be determined. |
| `prompt_session` | A new prompt to an idle session. A busy session is refused with a hint to use `steer_session`; it never turns into a steer. |
| `steer_session` | Guidance added to the running turn. If that turn has ended or another has started, the guidance becomes the next turn (sent now, or queued behind the running one) and the spoken line says which; with `expectedOperationId` it is refused instead. |
| `stop_session` | Stops the running turn, optionally only while `expectedOperationId` is still current. |
| `answer_question` | Resolves a pending question or approval at its revision. |
| `start_work` | A new environment with a first prompt (`projectId`), or a new session in a ready environment (`environmentId`); the agent defaults to the configured one. |
| `agent_voice_chat_say`, `agent_voice_chat_listen`, `agent_voice_chat_end` | A short two-way [agent voice chat](#agent-voice-chat) about a project, apart from its coordinator. |
| `agent_voice_chat_interrupt` | Interrupts the project's main coordinator with the person's words, or stops its turn. |
| `find_actions`, `describe_action`, `run_action`, `run_status` | The gateway to every other public action. |

Sessions are addressed by their `ses_…` handle or by `environmentId` with
`tabId`. Every mutation needs a new `requestId`; reuse one only to retry the
same request after an ambiguous response. Report that work started and check
back with `run_status` rather than waiting on it.

Each result's text is speakable: a `say` sentence, the IDs the next call
needs, and on errors a `next` hint (`busy` → `steer_session`, a pending
interaction → `answer_question`, `not-ready` → `run_status`). It is at most
2 KB. The structured envelope is the same one the CLI prints with `--json`.

## Agent voice chat

An agent voice chat is a quick back-and-forth between the voice agent and
Orkestrator about one project. It is kept apart from the main coordinator's
conversation, so asking "what is the coordinator doing?" neither waits for the
coordinator's turn nor adds to its transcript. It is not a coordinator side
agent: it opens no conversation tab, does not count toward a project's
conversation limit and has no composer. It belongs to the MCP credential that opened it;
another credential gets `not-found` for its ID.

```text
voice agent --agent_voice_chat_say {projectId, text}--> chatId + spoken reply
voice agent --agent_voice_chat_say {chatId, text}-----> next reply (history kept)
voice agent --agent_voice_chat_interrupt {chatId, text}--> coordinator steered now
voice agent --agent_voice_chat_say {chatId, "what did it say?"}--> reply from its latest message
voice agent --agent_voice_chat_end {chatId}
```

- **Replies are short and fast.** Each reply is one tool-free, one-shot model
  run (Claude Haiku through `claude --print`, else Codex's background model
  through `codex exec`; the same isolated runs as session titles, in an empty
  temporary directory with no tools, MCP, settings or session left behind). It
  is prompted for one or two spoken sentences, at most 40 words, and the
  result is stripped of markdown and capped at 600 characters. The run gets a
  digest read under the caller's own credential: the main coordinator's state
  and its latest four messages, the project's working or waiting agents and
  up to five attention items. So the model sees only what that credential may
  read, and it cannot change anything. Registry-derived state is omitted unless
  both `session.list` and `session.get` are allowed. Failed context reads are
  omitted. The replier is handed to the Control
  MCP listener directly rather than registered as a backend command, because
  every command-bridge client can call any registered command, and none of
  them needs a model run on the user's login over a prompt of its choosing.
- **`agent_voice_chat_say` waits** for the reply, 15 s by default and at most
  25 s (`waitMs`). When the reply takes longer it answers "Still thinking" with
  the `turnId`; `agent_voice_chat_listen` with `afterTurnId` waits for it and
  returns the turns since. A message is idempotent on its `requestId`: a retry
  repeats the reply without a second model run, and retries a reply that
  failed. This also covers concurrent opening calls before the client knows
  `chatId`: the key binds the credential, node, project and text. Another intent
  under the same ID is `request-conflict`. Blank input is refused before any
  chat can be opened or evicted. Opening keys (including ended-chat tombstones)
  are retained for the listener lifetime, capped at 1,024; new keys are refused
  at capacity rather than allowing a retry to open a second chat.
- **Talking over a reply.** A new message while a reply is being written
  cancels its queued or running model work and the new one answers both. Ending
  a chat or stopping the listener cancels its work too. Listening while the
  newest reply is pending or failed reports that state instead of speaking an
  older answer. The complete framed prompt is capped at 64 KiB in UTF-8,
  dropping oldest history first and, for many unanswered messages, retaining
  the newest utterance.
- **Interrupting the coordinator.** `agent_voice_chat_interrupt` (with `chatId`
  or `projectId`) finds the project's main coordinator in the agent registry.
  `mode: "message"` (the default) steers its running turn with the person's
  words, framed so it knows they came from an agent voice chat and should be
  answered briefly; when it is idle the words arrive as a new message instead.
  `mode: "stop"` stops its turn. Each is exactly one public action
  (`session.steer`, `session.prompt` or `session.stop`) under the caller's
  `requestId`, so the receipt, key and confirmation rules are the CLI's. A
  refusal is returned without automatically switching actions. A durable,
  content-free binding of the request fingerprint, public session and action
  is committed to SQLite before dispatch; retries use that same target and
  action even after listener or backend restarts. Bindings are never evicted
  and new keys are refused at 8,192 entries or a 4 MiB store budget. This keeps
  bindings at least as long as public receipts, including ambiguous runs. The
  chat notes the initial successful interrupt once, so the
  next reply knows about it, and since the digest carries the coordinator's
  latest messages, asking the chat what the coordinator answered works.
- **Bounds.** A chat keeps 24 turns and ends after 30 minutes idle. A
  credential has at most 8 open chats (its least recently used one ends to make
  room) and the listener 64. Chats live in memory only: a backend restart, or
  stopping Control MCP, ends them, and nothing a person said is stored or
  logged. The reply run is refused under the test runner and when
  `ORKESTRATOR_AGENT_VOICE_CHAT_REPLIES=0`.
- **Who sees the tools.** Every operator credential that may run
  `session.prompt` and `session.transcript` lists the three chat tools (a reply
  spends a model run, the same bar as prompting); the interrupt also needs
  `session.steer` and `session.stop`. A read-only credential lists none.

## Confirming risky actions

In the voice profile, approving a command or file change, stopping an
environment and running a command in one need explicit spoken confirmation;
deleting or recreating an environment, creating or removing a project and
discarding a run need it in every profile. The first call returns
`confirmation-required` with a `description` to read aloud ("This approves
Run rm -rf dist: rm -rf dist.") and a `confirmToken`. After an explicit yes,
repeat the identical call with `confirmToken`. The token lasts two minutes and
is tied to the credential, action, request ID and exact input. Denials, cancels
and answers to questions run directly.

## Hearing about work without asking

MCP tools cannot push. A voice runtime that should say "Claude is asking to run
`rm -rf dist`" unprompted polls `attention.list` from its own code, outside the
model, and injects new items into the conversation as context.
[`packages/cli/examples/voice-attention-relay.ts`](../../packages/cli/examples/voice-attention-relay.ts)
is a reference relay:

```bash
ORKESTRATOR_MCP_TOKEN=YOUR_TOKEN \
  bun packages/cli/examples/voice-attention-relay.ts --interval 3
```

It prints one JSON line per new item (`{"type":"attention","say":"…","item":{…}}`)
or POSTs it to `--webhook URL`, and never calls a mutation. The same feed is
`orkestrator attention --follow --jsonl` for clients that use the CLI.

`attention.list` returns pending questions and approvals (always), the
caller's own runs that settled or ended unknown since the cursor, and
environments whose setup finished or failed since it, blocking interactions
first. Pass each response's `cursor` back. When `more` is nonzero, continue
immediately to drain the current window; only the final page advances the polling
watermark. Pending interactions repeat on the next polling window, rather than
occupying every continuation page. Equal-time events have a stable tie breaker.

There is no conditional read: each poll receives the pending items again and the
poller drops the repeats, as `attention --follow` does with its `seen` set. A
scripted-provider measurement found 1,352 bytes for three pending approvals and
76,401 bytes for fifty items with three-byte names and 36-character interaction
IDs. `public-api-attention.test.ts` pins 32/80 KiB budgets for default/maximum
pages of that fixture, compared with a transcript page's 1 MiB cap. These are
fixture budgets: JSON-escaped names and longer provider IDs can exceed them.
A real follower's typical size has not been measured (the sampling run is on
the [manual-test checklist](../todo/manual-test/7568-manual-test-checklist.md)).
Add a conditional read only if a real follower's typical non-empty page is
above about 10 KiB (a full default page of ASCII titles): an optional
`knownToken` on `attention.list`, advertised as a feature as
`session transcript` does, which the CLI checks in the capabilities first and
sends through the same `--node` routing as the read.

## Hosted voice platforms: a local relay

The Control MCP listener is loopback-only, and this design adds no public
listener. A hosted voice platform that calls MCP from its own cloud cannot
reach it. Use a relay that runs on the Orkestrator machine and holds the
outbound connection to the platform: the platform's local client SDK, or a
small process that receives the platform's tool calls over its own
authenticated channel and forwards them to `http://127.0.0.1:34122/mcp` with
the voice credential's token. Keep the token on the local machine, give the
relay a voice (not full) credential, and revoke it in Settings → MCP when the
relay is retired. Exposing the remote (Tailscale) gateway to Control MCP was
considered and declined; see the decisions in
[0041-control-mcp-voice-surface.md](../todo/mcp/0041-control-mcp-voice-surface.md#assumptions-and-decisions).

## Qualifying a voice runtime

[`packages/cli/examples/voice-qualify.ts`](../../packages/cli/examples/voice-qualify.ts)
runs the qualification script (overview, start work, answer an approval, stop,
read the result) against a running Orkestrator with a voice credential and
reports per-tool p50/p95 latency, the tool list's size and each result's size
with rough token counts:

```bash
ORKESTRATOR_MCP_TOKEN=YOUR_TOKEN \
  bun packages/cli/examples/voice-qualify.ts --environment ENV_ID --agent claude
```

It spends one short prompt on a real provider; use a disposable environment of
a test profile. Host and container sessions approve commands automatically by
default, so to exercise the approval step set the environment's **Settings →
Execution policy → Approvals** to **Ask** first and pass `--expect-approval`:
the harness then exits 1 unless a command or file approval was raised,
confirmed (`confirmation-required`, then the call with `confirmToken`) and
answered.

Misresolved spoken targets and session-handle copy errors need a speaking
model and a person. To count them, put
[`packages/cli/examples/voice-mcp-relay.ts`](../../packages/cli/examples/voice-mcp-relay.ts)
between the voice runtime and Control MCP, speak the script, then score the
recording:

```bash
bun packages/cli/examples/voice-mcp-relay.ts --record voice.jsonl
# Give the runtime http://127.0.0.1:34199/mcp and its usual Authorization header.
bun packages/cli/examples/voice-qualify.ts --score voice.jsonl --environment ENV_ID
```

The relay listens on loopback only, forwards each request with the runtime's
own header (it holds no token) and records, per call, only the tool, latency,
outcome, the IDs it targeted and the IDs its result returned; prompts, answers
and result text are not written. Scoring assumes the script's single
environment and the latest session `start_work` started in it, so one
recording can hold several repeats: a targeted ID that no
earlier result returned (or a malformed `ses_` handle) is a copy error, and a
returned ID that is not the script's environment, project or session is a
misresolution. The scripted harness writes the same recording with `--record`
and reports its own score as `selfCheck`, which is zero because it copies
handles exactly.
