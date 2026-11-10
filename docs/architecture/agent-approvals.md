# What an approval promises

An `ask` session parks a tool call until a person answers. This page says what
stops the agent answering for itself, where that holds, and where it does not.
The credential layout it builds on is in
[container-lifecycle.md](container-lifecycle.md#bridge-credential-bridge-credential1);
the bridge rules are in [`bridges/AGENTS.md`](../../bridges/AGENTS.md).

## Signed authority

A bridge's bearer token proves only that a caller once received it. An agent
that can run a background process as the bridge's uid can kill its bridge,
listen on the same port and read the token from the backend's next request:
the activity sweep sends one within seconds. So a bearer token alone may not
change what an agent is allowed to do.

The backend mints an Ed25519 key pair for every bridge it starts. The bridge
gets only the public key, as `<TOKEN_ENV>_AUTHORITY_KEY`, and removes it from
its environment at start (`loadBridgeAuthority`,
`packages/protocol/src/node/bridge-authority.ts`). The private key stays with
the backend: in memory for a host bridge, and beside the token in the
root-only `/run/orkestrator-bridge/<kind>-authority` for a container's
(`container-bridge-credential.ts`). The backend keeps the key by token
(`bridge-authority-keys.ts`), so whatever reads a token back reads its key with
it.

| | |
| --- | --- |
| What is signed | Every `POST`, `PUT`, `PATCH` and `DELETE` except the routes that only narrow or read: `/session/:id/close`, `/sessions/activity`, `/debug/log-policy`. Approval answers, prompts, session create and config, and policy changes are all signed. |
| What a signature covers | Method, path and query, the SHA-256 of the body, the time it was made and a 16-byte nonce (`x-orkestrator-authority: v1 t=… n=… s=…`). |
| Replay | Accepted within five minutes of when it was made, and only once: the bridge remembers each nonce for that long, up to 8,192, and refuses anything no newer than a nonce it had to forget. |
| Where it is added | `bridgeFetch` (`http-bridge-transport.ts`), which every backend call that changes a session already goes through. A string body is signed as sent. |
| Where it is checked | Before routing, after the token: the Hono middleware of the Claude and Codex bridges (`admitFetchBridgeRequest`) and the `node:http` routers of the Cursor, Pi and Grok bridges (`admitNodeBridgeRequest`). The checked body is the one the handler parses. A refusal is 403 `authority-signature-required` with a content-free `reason`. |
| Without a key | Nothing is checked. A bridge an older backend or image started, and every test harness, keeps working. A key that does not parse refuses every request that needs one. |

A token caught in flight therefore still reads transcripts, but answers no
approval, sends no prompt and widens no policy on the bridge the backend
started. A signature the agent catches can be replayed only as the exact
request the user made, and only once per bridge process.

## Fixed launch (`bridge-launch=1`)

A start script runs as `node` in a login shell, so it reads `~/.bash_profile`,
`~/.profile` and the `/tmp/orkestrator-ai` runtime snapshot, all of which `node`
can write. A function, `BUN_OPTIONS` or `LD_PRELOAD` planted there used to run
inside the next bridge and see each token presented to it.

On an image with `bridge-launch=1` the start script only prepares: it runs to
completion and records the environment it built with `env -0` in a snapshot
file. The backend then starts the bridge with its own exec:

```
docker exec -i --user node --workdir / --env PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  <container> /usr/local/bin/orkestrator-bridge-launch <kind> <snapshot>
```

`orkestrator-bridge-launch` (`docker/orkestrator-bridge-launch.sh`) is
root-owned and runs under `/bin/sh`, which reads no startup file. It takes the
backend's values on stdin, one checked `NAME=VALUE` per line (the verifier, the
public key, the port), refuses `PATH`, `HOME` and its own names, and starts
`/usr/local/bin/bun --config=/dev/null --no-env-file /opt/<kind>-bridge/dist/index.js`
under `env -i`, from `/`, detached in its own session. The first import of
every bridge entry point (`bridge-launch-environment.ts`) applies the snapshot
to `process.env` once Bun is already running, where a loader variable has
nothing left to load, and changes into `/workspace`. The agents the bridge
spawns get the environment the start script built. The snapshot never supplies
a value the launcher set, a bridge credential or authority key, a process
authority (`ORKESTRATOR_BRIDGE_EXECUTION_POLICY`, `ORKESTRATOR_COORDINATOR_*`)
or `NODE_PATH`; it is opened without following a link and removed after one
read.

An image without the capability keeps the login-shell start and unsigned
requests until it is rebuilt (`containerCredentialMode`). OpenCode has no bridge
of ours: on a launcher image it starts as on a `bridge-credential=1` image.

## A replaced bridge is refused

The verifier and the public key are not secret (both are in the launcher
wrapper's argv), so a process running as the agent's uid can kill its bridge and
start one of its own on the same port, through the launcher or not. That bridge
accepts the token the backend reads from root's file. So the token belongs to a
socket, not to a port (`container-bridge-listener.ts`):

- **Writing a new token marks the record pending.** Beside the token,
  `/run/orkestrator-bridge/<kind>-listener` holds `pending` from the moment a
  start writes a fresh token.
- **Once the bridge answers, its socket is recorded.** `startContainerServer`
  reads the port's listening sockets as root with `ss -Hltne` and writes the one
  socket's inode and cookie to the record. The kernel never reuses a socket
  cookie while it runs, and the agent cannot obtain the bridge's socket: the
  bridge is non-dumpable, so `pidfd_getfd` is refused, and it opens the socket
  close-on-exec. A port with no socket or several, or a scan that could not
  run, refuses the start and attempts listener cleanup. Cleanup is not reported as confirmed.
- **Initial recording verifies ownership in the launch session.** The launcher
  prints `orkestrator-bridge-session=<id>`. A fixed root scan checks that a
  non-stopped, non-zombie `bun` in that session holds the exact listening
  socket in `/proc/<pid>/fd`, checking state and start time again afterwards.
  Session liveness alone cannot establish ownership: an unrelated listener
  must be refused even while the launched Bun remains alive.
  This one scan uses privileged Docker exec to read non-dumpable processes'
  descriptors. It runs only trusted system programs from `/` with the fixed
  root PATH; it never runs bridge or workspace code. Bridge processes and
  ordinary token reads gain no capabilities. If descriptor access is denied,
  recording fails closed. Older launchers without a session report and
  verifier-only images retain their compatibility behavior without this check.
- **Every read of a running bridge's token compares the socket.**
  `readContainerBridgeToken` scans in the same root exec that reads the token,
  so it costs no extra exec. Start reuse, the `get_*_server_status` commands,
  `peekContainerAgentBridge`, connection refreshes before a session or a
  dispatch, and log-policy discovery all go through it. A different socket,
  a second socket beside the recorded one, a pending record or an unfinished
  scan returns no token and logs `docker` `bridge.listener-refused`; the start
  path then replaces the bridge with a new token the agent never saw. An empty
  port returns the token, because nothing can receive it there. A bridge an
  older backend started has no record and is recorded as it stands
  (`bridge.listener-adopted`): it is the process that backend already trusted.
- **Replacing stops what listens, whatever its command line.** Besides the
  usual `pkill` of the bridge's pattern, the start runs a scan as `node`, with a
  fixed PATH and no login shell, that stops every process whose descriptors hold
  the port's socket. Ordinary root exec cannot do this: it has no
  `CAP_SYS_PTRACE`, so root cannot read another uid's `/proc/<pid>/fd`. A
  process that made itself non-dumpable hides its descriptors from `node` too;
  if it does not match the bridge's pattern either, it survives and the start
  fails with "did not stop" rather than trusting it.

The check is on reuse, not on every request. A process that replaces the bridge
between a check and the next request still gets that request, until the next
refresh or start. The agent's uid can still kill the bridge, which it could
already do. OpenCode has no bridge of ours and is not covered: to-do
[7252](../todo/containers-and-environments/7252-opencode-server-loads-agent-writable-code.md).

## Where an approval is a boundary

| Where | What an `ask` approval means |
| --- | --- |
| A container on a `bridge-launch=1` image | Only the backend can answer it. The agent's uid cannot read the token or the private key, cannot answer with a caught token, and cannot plant code in the next bridge the backend starts. What it can still do is below. |
| A container on an older image | Only a holder of the token can answer it. An agent that can run a background process can catch the token on the bridge's port. |
| A host environment with a sandbox | The OS sandbox holds the agent (Codex, Claude where its sandbox runs, Pi). What the sandbox allows, the agent can do; what it denies, an approval cannot be forged to allow. |
| A host environment without a sandbox | **A prompt, not a boundary.** The agent runs as the user, who owns the backend, its data directory and its memory, and on macOS a bridge cannot even mark itself non-dumpable. A host bridge takes a verifier and an authority key like a container's, which keeps a careless process from answering, but nothing separates a determined agent from the backend. Separate OS users for host agents would need an installer and privileges the app does not have. |

On a shared uid, an approval also does not stop the agent changing what it is
asked about. Every CLI provider keeps its standing rules in files the agent's
uid owns, and a tool that can write them (on an `ask` environment, one the user
approved) can widen them without answering anything:

- OpenCode: the `permission` column of `session` and the `permission` table in
  `~/.local/share/opencode/opencode.db`, and the `permission` key of
  `opencode.json` (user or `/workspace`).
- Claude: `settings.json` under `~/.claude` and `.claude/settings*.json` in the
  checkout.
- Codex: `CODEX_HOME/rules/*.rules`.
- Pi and Grok: their settings files under the agent's home.

Orkestrator's own "always allow" rules ([permission-rules.md](permission-rules.md))
live in the backend's store and are out of the agent's reach. A provider's
files are not, and running OpenCode's state somewhere `node` cannot write would
need its own uid, and then its tools would too.

## What the agent's uid can still do

- **Kill the bridge, or replace it between two checks.** A replacement is
  refused at the next start, status read or connection refresh
  ([above](#a-replaced-bridge-is-refused)), but a request made before then
  reaches it, and killing the bridge ends the agent's own session.
- **Load code into Pi's bridge.** With project resources on, Pi runs repository
  extensions inside the bridge process. To-do
  [7251](../todo/containers-and-environments/7251-pi-project-extensions-in-the-bridge-process.md).
- **Reach OpenCode's password.** Its server loads agent-writable plugins, and
  takes the plain password from whatever listens on its port. To-do
  [7252](../todo/containers-and-environments/7252-opencode-server-loads-agent-writable-code.md).
- **Stop being asked.** Through the provider rule files above.

Each needs a process or a tool the user already let run. Qualified on a real
container by `apps/backend/tests/bridge-credential-docker.test.ts`: on Docker
Desktop (Engine 29.9.2, arm64) on 2026-11-06, a token caught by an imposter on
the Pi bridge's port was refused on a bridge started from the same verifier
and key while the backend's signed calls worked, a replayed signature was
refused, and a `BUN_OPTIONS` preload and a `bun` function planted in
`~/.bash_profile` ran in the agent's own login shell but not in the next bridge.
On Linux Engine (beelink, x86_64) on 2026-11-09, with an image built from the
listener check's branch, every bridge's socket was recorded at start under the
launcher's session check, and the backend refused the token both to a plain
`bun` server the agent's uid started on the Pi bridge's port and to a real Pi
bridge it started through the launcher with the same verifier and key
(`bridge.listener-refused reason=different-socket`). The next `start_pi_server`
replaced that bridge with a new token, which the backend then read back, and
the caught token was refused there.
