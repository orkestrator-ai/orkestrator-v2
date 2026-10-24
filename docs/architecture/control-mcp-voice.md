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

The voice profile lists twelve tools, about 7 KB of `tools/list` (the budget is
8,000 bytes, enforced by `control-mcp-voice.test.ts`). Its default capabilities
leave out project and settings edits, destructive environment actions and
`exec`. Create a `custom` credential, or grant `exec` explicitly, for more.

## The tools

| Tool | What it does |
| --- | --- |
| `overview` | Counts of projects, environments and sessions, and the top five things needing attention. Answers "what's going on?" in one call. |
| `resolve_target` | Turns a spoken name ("the auth environment", "the first Codex tab" within an environment) into an ID. One exact match wins; anything else is `ambiguous-target` with up to five candidates to ask about, or `not-found`. It never guesses. |
| `read_session` | The last 3 messages, about 600 characters each (`detail: "full"`: the last 10). |
| `prompt_session` | A new prompt to an idle session. A busy session is refused with a hint to use `steer_session`; it never turns into a steer. |
| `steer_session` | Guidance added to the running turn. |
| `stop_session` | Stops the running turn, optionally only while `expectedOperationId` is still current. |
| `answer_question` | Resolves a pending question or approval at its revision. |
| `start_work` | A new environment with a first prompt (`projectId`), or a new session in a ready environment (`environmentId`); the agent defaults to the configured one. |
| `find_actions`, `describe_action`, `run_action`, `run_status` | The gateway to every other public action. |

Sessions are addressed by their `ses_…` handle or by `environmentId` with
`tabId`. Every mutation needs a new `requestId`; reuse one only to retry the
same request after an ambiguous response. Report that work started and check
back with `run_status` rather than waiting on it.

Each result's text is speakable: a `say` sentence, the IDs the next call
needs, and on errors a `next` hint (`busy` → `steer_session`, a pending
interaction → `answer_question`, `not-ready` → `run_status`). It is at most
2 KB. The structured envelope is the same one the CLI prints with `--json`.

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
a test profile. Misresolved spoken targets and session-handle copy errors need
a speaking model and a person, so a full qualification also runs the same
script through a real voice runtime.
