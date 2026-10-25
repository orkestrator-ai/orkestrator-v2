---
name: orkestrator
description: Connect to and drive a user's Orkestrator installation (projects, environments, agent sessions, Kanban tickets) through its local MCP server or the `orkestrator` CLI. Use when asked to control, inspect or automate Orkestrator, or when an Orkestrator token is rejected.
---

# Driving Orkestrator from an agent

Orkestrator is a desktop app (and standalone backend) that runs coding agents
in isolated environments. You can control it in two ways:

- **Control MCP:** a Streamable HTTP MCP server, for MCP clients running on
  the **same machine** as Orkestrator.
- **`orkestrator` CLI:** a command-line client that works on the same machine
  or **remotely** over Tailscale.

Both reach the same actions with the same error codes. Read the table below
before you try anything: most failed connections come from using the wrong token.

## Two surfaces, two different tokens

| | Control MCP | CLI (remote) |
| --- | --- | --- |
| Address | `http://127.0.0.1:34122/mcp` | `https://<machine>.<tailnet>.ts.net` (the Tailscale address) |
| Reachable from | **Loopback only.** Never listens on the network | Any device on the user's tailnet |
| Token | An **MCP credential** from **Settings → MCP** | The **Gateway token** from **Settings → Web client** |
| Sent as | `Authorization: Bearer <token>` | `orkestrator connection add … --credential-file <file>` |

The tokens are not interchangeable:

- The Gateway token signs in the web client and the CLI. The Control MCP
  rejects it with `401 {"error":"Invalid control MCP credential"}`.
- An MCP credential only works on the Control MCP.

Other ports you may find:

- The backend gateway, normally `34121`, serves the web app. Paths such as
  `/api/session` don't exist: an unknown path returns the web app's HTML, not
  an API. The only client endpoint is `POST /__orkestrator/invoke`, which the
  CLI calls for you. Do not call it by hand.
- Ports such as `55120` are agent-tools endpoints for agents running inside
  Orkestrator. They are not for outside clients.

## Option A: Control MCP (same machine)

1. Ask the user to open **Settings → MCP** in Orkestrator on the machine you
   are working on. Have them create a credential for you (**New credential**)
   or pick an existing one. Then they choose **Copy setup** under one of:
   - **Codex**: a block for `~/.codex/config.toml`
   - **Claude Code**: a `claude mcp add …` command
   - **Other or voice client**: the URL and `Authorization` header as JSON
2. Profiles:
   - `full`: everything except updating Orkestrator itself
   - `read-only`: same tools, but every change is refused
   - `voice`: a small set of tools with short, speakable results
   - `custom`: capabilities the user picks

   Prefer `read-only` until the user asks you to change things.
3. Configure your MCP client with that URL and header. A typical config:

   ```json
   {
     "mcpServers": {
       "orkestrator": {
         "type": "http",
         "url": "http://127.0.0.1:34122/mcp",
         "headers": { "Authorization": "Bearer <MCP credential>" }
       }
     }
   }
   ```

   If you run on another machine, the server is out of reach. Either run your
   client on the Orkestrator machine (over SSH, for example), or forward the
   port first with `ssh -N -L 34122:127.0.0.1:34122 <machine>` and use the
   same URL. Or use the CLI (option B).
4. Start with reads. Call the `overview` tool, or `find_actions` to search what
   you can do. Then call `describe_action` for an action's input schema and
   its CLI equivalent.

How tools work:

- **Changes** take a `requestId`. Reuse it only to retry the same call after
  an unclear response.
- **Risky actions** (delete an environment, create or remove a project) first
  return `confirmation-required` with a description and a `confirmToken`.
  Show the description to the user. Repeat the identical call with the token
  only if the user agrees. The token expires after 120 seconds.
- **Results:** `structuredContent` is `{ok, error.code, exitCode, receipt, …}`,
  and `isError` is set exactly when `ok` is false.
- **Long-running work** returns an operation. Poll it with
  `run_status(operationId, waitSeconds≤20)`.
- **Other machines.** If Orkestrator controls other machines (leaf nodes),
  `list_nodes` names them. Pass a `nodeId` to any tool to act on that machine;
  `nodeId: "all"` on `overview`, `list_projects` or `list_environments` covers
  every machine and tags each item with its `nodeId`. IDs and session handles
  belong to their machine, so keep passing the same `nodeId`. Errors:
  `node-not-found`, `node-unavailable` (offline; nothing was sent),
  `node-unsupported` (that machine needs an update), `node-outcome-unknown`
  (retry with the same `requestId`).
- **Reviews and PRs.** `launch_multi_review` runs an environment's Multi Review
  (saved defaults when you omit reviewers and models; `get_multi_review` to
  check on it). `create_pr` opens the Create PR agent tab and
  `resolve_conflicts` the Resolve Conflicts tab; both return a run for
  `run_status`. They never merge.

## Option B: the `orkestrator` CLI (same machine or remote)

The CLI is the npm package `orkestrator` and needs [Bun](https://bun.sh). The
desktop app does **not** put it on `PATH`. Run it with `bunx`:

```bash
bunx orkestrator@latest --help        # or: npm i -g orkestrator
```

If Orkestrator is on the beta channel, use `orkestrator@beta`. The client
refuses actions the backend doesn't support.

Client commands never start a backend. Orkestrator must already be running,
and you must save a connection first.

**Same machine:** the CLI reads the running backend's descriptor:

```bash
# macOS. On Linux use "${XDG_CONFIG_HOME:-$HOME/.config}/orkestrator-v2".
bunx orkestrator connection add local \
  --data-dir "$HOME/Library/Application Support/orkestrator-v2" --default
bunx orkestrator connection check
```

**Remote, over Tailscale:**

1. The user turns on **Settings → Web client → Allow web access** on the
   Orkestrator machine.
2. They give you the Tailscale HTTPS address shown there and the **Gateway
   token**.
3. Store the token in a private file. Never pass it as an argument:

```bash
umask 077; printf '%s' "$GATEWAY_TOKEN" > ~/.orkestrator-token
bunx orkestrator connection add mini \
  --url https://<machine>.<tailnet>.ts.net \
  --credential-file ~/.orkestrator-token --default
bunx orkestrator connection check
```

First commands (all of them only read):

```bash
orkestrator project list --json
orkestrator environment list --json
orkestrator session list --environment <ENV_ID> --json
orkestrator attention --json
orkestrator node list --json                      # machines this one controls
orkestrator --node <NODE_ID> environment list --json
orkestrator --node all environment list --json    # every machine, tagged by node
```

Review and PR commands (changes; pass `--request-id`):

```bash
orkestrator review launch <ENV_ID> --request-id review-1   # Multi Review with saved defaults
orkestrator review get <REVIEW_ID>
orkestrator pr create <ENV_ID> --request-id pr-1 --wait     # Create PR tab; never merges
orkestrator pr resolve <ENV_ID> --request-id resolve-1      # Resolve Conflicts tab
```

- **Output:** `--json` prints exactly one envelope:
  `{schemaVersion, action, ok, result | error, receipt?}`.
- **Exit codes:**
  - 0: ok
  - 1: failed
  - 2: invalid input
  - 3: not found
  - 4: connection or authentication
  - 5: deadline
  - 6: interaction needed
  - 7: outcome unknown
  - 8: conflict or unsupported
- **Changes:** pass `--request-id KEY` with every change so a retry is safe.
- **Paths:** paths given to `project` commands are on the backend machine.
- **Help:** `orkestrator <group> --help` lists every command.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Invalid control MCP credential` on `:34122` | A Gateway token or an old MCP token | Copy a credential from **Settings → MCP**. **Rotate token** replaces a token |
| Connection refused on `:34122` from another machine | The Control MCP is loopback-only | Run on that machine, forward the port over SSH, or use the CLI |
| `Authentication required` on the gateway | Missing or wrong Gateway token | Use the token from **Settings → Web client** |
| HTML instead of JSON from the gateway | Not an API path | Use the CLI, not hand-made HTTP requests |
| `orkestrator: command not found` | The CLI isn't installed | `bunx orkestrator …` (needs Bun) |
| `connection-not-configured` (exit 4) | No saved connection | `orkestrator connection add …` |
| `confirmation-required` | A risky MCP action | Confirm with the user, then repeat the call with `confirmToken` |
| `capability-unavailable` | The credential's profile doesn't allow it | Ask the user for a credential with that capability |
| `node-unavailable` (exit 4) | That machine is offline or disabled | Ask the user to reconnect it in **Settings → Machines**; nothing was sent |
| `node-unsupported` (exit 8) | That machine runs an older Orkestrator, or you are connected to a leaf | Ask the user to update it, or connect to its command node |

## Safety

- Treat every token like a password. A `full` MCP credential or a Gateway token
  can create and delete environments, run commands and read transcripts.
- Don't write tokens into repositories, logs or chat transcripts.
- Ask before deleting, recreating or discarding anything.

## Reference

- Control MCP guide: https://github.com/orkestrator-ai/orkestrator-v2/blob/main/docs/architecture/control-mcp.md
- Voice clients: https://github.com/orkestrator-ai/orkestrator-v2/blob/main/docs/architecture/control-mcp-voice.md
- CLI reference: https://github.com/orkestrator-ai/orkestrator-v2/blob/main/docs/architecture/public-cli.md
- CLI package README: https://github.com/orkestrator-ai/orkestrator-v2/blob/main/packages/cli/README.md
