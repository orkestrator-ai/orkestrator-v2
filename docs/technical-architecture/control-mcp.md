# Orkestrator control MCP

Orkestrator exposes its core controls to Codex, Claude Code, and other MCP
clients through a local Streamable HTTP server.

## Connect a client

1. Keep Orkestrator running.
2. Open **Settings → MCP**.
3. Copy the setup for your client.

That is the whole setup. The server URL and access token stay the same when
Orkestrator restarts.

### Codex

In **Settings → MCP**, choose **Copy setup** under Codex and paste the block into
`~/.codex/config.toml`:

```toml
[mcp_servers.orkestrator]
url = "http://127.0.0.1:34122/mcp"
http_headers = { Authorization = "Bearer YOUR_TOKEN" }
```

Restart Codex, then ask it to use the `orkestrator` MCP server. Codex documents
these fields in its
[MCP guide](https://learn.chatgpt.com/docs/extend/mcp#streamable-http-servers).

### Claude Code

In **Settings → MCP**, choose **Copy setup** under Claude Code and paste the
copied command into a terminal. It has this form:

```bash
claude mcp add --scope user --transport http orkestrator http://127.0.0.1:34122/mcp --header "Authorization: Bearer YOUR_TOKEN"
```

Start a new Claude Code session. Run `/mcp` if you want to check the connection.
Claude Code documents this command in its
[MCP guide](https://code.claude.com/docs/en/mcp).

## Rotate access

Use **Settings → MCP → Rotate** when you want to invalidate the existing token.
The server URL does not change. Copy the updated setup into each client after
rotation.

The endpoint listens only on `127.0.0.1`. Treat the token like a password: it
can create environments, launch jobs, read transcripts, and update tickets.

## What an agent can do

- See projects, environments, tabs, tab state, and bounded transcripts.
- Create and update Kanban tickets and add comments.
- Create a validated environment with an initial agent prompt.
- Launch a new job in an existing running environment.
- Send a new prompt to an existing native-agent tab.
- Discover durable agent mailboxes with `list_mailboxes`.
- Send an inbox-only external message to one mailbox with `send_message`.

Control-MCP messages are always classified as external and are never injected
into an agent turn. The destination's user can inspect and acknowledge them in
the global inbox. `send_message` requires a stable `requestId`; retrying the
same request with different content is rejected.

Agent launches, prompt dispatches, agent messages, ticket creation, and comment
appends use a caller-provided `requestId`. Reuse the same ID only when retrying
the same action after an ambiguous response. Ticket field updates are naturally
idempotent because they replace the specified values.

## First prompt

```text
Use the Orkestrator MCP to list my projects, environments, and tabs. Do not make
any changes yet.
```

The control MCP can be disabled before startup with
`ORKESTRATOR_CONTROL_MCP_DISABLED=1`.
