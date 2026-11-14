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
requests until it is rebuilt (`containerCredentialMode`).

### OpenCode under the launcher (`opencode-launch=1`)

OpenCode has no bridge of ours, so it has no verifier and no signatures: it
compares a plain password (HTTP Basic), and its plugins run inside the server
beside it. `opencode-launch=1` started OpenCode 1.x this way on port 4096
(`git show 5f4e27b1c:apps/backend/src/core/opencode-container-launch.ts`). It
was retired with 1.x on 2026-11-11 and the backend no longer asks for it; the
2.x start on an `opencode2-launch=1` image ([below](#opencode-2x-the-package-cache-and-project-configuration-opencode2-launch1))
follows the same design, recorded here as the 1.x launcher had it:

- **Root's binary, root's configuration.** `orkestrator-bridge-launch opencode`
  runs the root-owned `/opt/opencode/bin/opencode` (node's
  `~/.opencode/bin/opencode` is only a symlink to it) under `env -i`, in
  `/workspace`, with `OPENCODE_DISABLE_PROJECT_CONFIG=1`,
  `XDG_CONFIG_HOME=/run/orkestrator-opencode/config` and
  `OPENCODE_TEST_HOME=/run/orkestrator-opencode/home`, so it reads no
  `/workspace/.opencode`, no project `opencode.json`, no `~/.config/opencode`
  and no `~/.opencode`. Before every start a root exec rebuilds that directory:
  the user's own configuration, copied from the read-only host input
  `/opencode-config` (never from node's copy) without `node_modules`, symlinks
  or special files, and Orkestrator's two plugins. Project configuration off
  also drops the checkout's `AGENTS.md` from the instructions, so the launcher
  of this image names it back in (`OPENCODE_CONFIG_CONTENT`). Named by its
  checkout path it can be a link to the server's own environment; an
  `opencode2-launch=1` image passes a copy instead (below).
- **The password never passes an argument.** The launcher re-runs itself under
  `env -i`, exports the backend's values (the password, `OPENCODE_DB`) and
  starts the server and a log writer fed through a FIFO, so no long-lived
  process but the server holds it. The credential plugin then removes it from
  `process.env`, marks the server non-dumpable and applies the start script's
  environment snapshot for the server's tools, refusing every `OPENCODE_`
  variable (OpenCode reads its flags from `process.env` when it uses them) and
  dropping `XDG_CONFIG_HOME`.
- **The backend checks the socket before it sends the password.** After the
  server answers the fresh password and has loaded its plugins, a root exec
  records the inode of the socket listening on port 4096 in
  `/run/orkestrator-bridge/opencode-listener` (`opencode-listener-identity.ts`).
  Every read of the password (start, status, peek) lists the port's listening
  sockets from `/proc/net/tcp` in the same root exec and withholds the password
  unless that socket is the only one. A process the agent puts on the port, even
  root's binary started with a password it caught, has a new socket; the next
  start stops it (as `node`, see below) and mints a new password.

The container's root has no `CAP_SYS_PTRACE`, so it cannot read another uid's
`/proc/<pid>/fd` (nor a non-dumpable process's `exe`): it cannot tell which
process holds a socket, only which socket listens. Stopping a listener is done
as `node`, which can read its own dumpable processes' descriptors; a
non-dumpable imposter is out of reach, and the start then fails with an error
asking for a restart rather than sending anything. Qualified on beelink (Linux
Engine 29.9.2) on 2026-11-09 by `apps/backend/tests/bridge-credential-docker.test.ts`,
and on a rootless daemon on 2026-11-14, where the same suite also showed the
agent's ptrace of every bridge refused and nothing inside the container
differing from rootful; the one difference, outside it, is that the daemon's
host user owns the container's root and its user namespace, so it can list the
bridge directory and open a bridge's memory without the Docker socket
([evidence](../development/container-qualification.md#bridge-credential-suite-on-rootless-docker-2026-11-14)).

An image without `opencode2-launch=1` starts the 2.x server from node's login
shell, with the password in root's file and the server's environment alone on
a `bridge-credential=1` image; an image that would leave the password where
`node` reads it is refused (`containerOpenCode2Mode`,
`opencode2-container-server.ts`).

### OpenCode 2.x, the package cache and project configuration (`opencode2-launch=1`)

To-do 7550 (done 2026-11-10) extended the same start to the rest of what a container's OpenCode
servers load. On an `opencode2-launch=1` image:

- **The 2.x server starts the same way** (`opencode2-container-launch.ts`):
  `orkestrator-bridge-launch opencode2` runs the root-owned
  `/opt/opencode/bin/opencode2` (node's `~/.opencode/bin/opencode2` is a
  symlink) under `env -i` on port 4102, with project configuration off. 2.2.6
  reads its global directory from `OPENCODE_CONFIG_DIR`, which replaces the
  XDG one, so a root exec rebuilds `/run/orkestrator-opencode2/opencode` before
  every start: Orkestrator's two 2.x plugins and the user's configuration,
  copied from the read-only host input and merged into one document without a
  `plugin` key (`opencode2/user-config.ts`); `XDG_CONFIG_HOME` and
  `OPENCODE_TEST_HOME` point at empty root-owned directories. Once the server
  answers its fresh password and has loaded its plugins (the warm request is
  `/api/agent`: 2.2.6 does not load them for `/api/session/active`), its
  socket is recorded in `/run/orkestrator-bridge/opencode2-listener`, and
  every read of the 2.x password checks it, as the 1.x launcher did. Checked against the
  pinned 2.2.6 binary outside a container on 2026-11-10
  (`opencode2-launch.live.test.ts`): plugins planted in the checkout's
  `.opencode/plugins`, `~/.config/opencode/plugins` and `~/.opencode/plugins`
  did not load, the server read a read-only configuration directory, its
  `/proc/<pid>/environ` stopped being readable after the warm request, and its
  shells got the start environment but not the password. Qualified on a real
  container on beelink (Linux Engine 29.9.2) on 2026-11-10 by
  `apps/backend/tests/bridge-credential-docker.test.ts`, with the root caches
  and project copies below.
- **Root's package cache.** OpenCode installs the npm package of a provider it
  does not bundle (and, on 1.x, an npm plugin) into `$XDG_CACHE_HOME/opencode`
  and imports it into the server. Code planted in such a package in node's
  `~/.cache` ran inside the next 1.19.5 and 2.2.6 server (2026-11-10). The
  launcher points the server's `XDG_CACHE_HOME` at
  `/run/orkestrator-opencode2/cache`, root-owned and read-only to it. Root
  installs the providers the user's configuration names before each start
  (the image's Bun, `--ignore-scripts`; `opencode-package-cache.ts`) into the
  directory 2.2.6 imports from, `npm/<name>@<tag>/1`: the tag is the configured
  version or `latest`, except that 2.2.6 always asks for a bare
  `@ai-sdk/<name>` as its `ai-v6` dist-tag (read from 2.2.6's npm service,
  2026-11-10). That rule belongs to the binary, not the configuration, so it is
  pinned to `OPENCODE2_PACKAGE_LAYOUT_VERSION` and a unit test fails when the
  pinned `opencode2` moves; `opencode2-package-cache.live.test.ts` re-checks it
  against the binary (2.2.6 imported both kinds of package from a read-only
  cache, and did not import an `@ai-sdk` package placed under `@latest`), and a
  real `bun add` of `ollama-ai-provider-v2` loaded there and reached its
  (dead) loopback endpoint. Installs run with `--ignore-scripts`, at most 16
  packages per start and 120 seconds each; a failure is reported on stderr,
  never fails the start and leaves that provider unavailable. Only plain
  registry specs from root's copy of the user's configuration are installed.
  A provider package named only by the project's configuration never is, and
  neither is the package of a provider the user signed in to without naming it
  in their configuration (OpenCode would install that one at the first prompt,
  and cannot in a read-only cache).
- **A filtered project configuration.** Before each start the backend reads
  the checkout's `opencode.json` and `opencode.jsonc` as `node` (bounded),
  removes `plugin`/`plugins`, every `{env:}` reference (the server's own
  environment holds the password) and every `{file:}` reference outside the
  checkout, inlines those inside it, and root writes the result where the
  launcher passes it as `OPENCODE_CONFIG` (`opencode-project-config.ts`), which
  2.2.6 honours with project configuration off (as 1.19.5 did). MCP servers,
  agents, commands and permission rules from the checkout apply again; they
  are the agent's to change, as before 7252. The checkout's `.opencode/`
  directories are still not read.
- **Instructions are copies.** OpenCode reads an instruction file by path, in
  the server's own process, each time it builds a prompt, so a checkout
  `AGENTS.md` linked to `/proc/self/environ` put the 2.2.6 server's password in
  its prompt (2026-11-10). The launcher no longer names `/workspace/AGENTS.md`:
  the backend reads it and each project instruction inside the checkout as
  `node` before the start, and the filtered document names root's copies. An
  edit reaches the server at its next start. An image without
  `opencode2-launch=1` starts the server from node's login shell, which reads
  the checkout itself; rebuild it.
- **A failed answer re-checks the socket** (`opencode-listener-recheck.ts`).
  After a refused connection, a 401 or a 403 from the server, the backend
  asks root which socket listens; once it is not the recorded one, the
  connection sends nothing more until a fresh start records its own server.

Why it is built this way (decisions recorded when 7252 and 7550 were done):

- **1.x moves its global directory with `XDG_CONFIG_HOME`, 2.x with
  `OPENCODE_CONFIG_DIR`.** 1.19.5 adds `OPENCODE_CONFIG_DIR` to the
  directories it reads rather than replacing `~/.config/opencode` (a plugin
  planted there still loaded); 2.2.6 replaces its global directory with it.
  `OPENCODE_TEST_HOME` moves the home whose `.opencode` either reads.
- **A new capability name, not `opencode-launch=2`.** The backend matches
  `opencode-launch=1` exactly and the 1.x mode check asks for version 1, so
  `opencode2-launch=1` names what is checked before the 2.x launch and before
  filling either cache.
- **The 2.x warm request is `/api/agent`.** 2.2.6 loads its plugins for
  `/api/agent`, `/api/command`, `/api/config` and `/api/provider`, not for
  `/api/session/active` or `/api/session` (probed 2026-11-10). The socket is
  recorded only after it, so the server is non-dumpable by then.
- **`XDG_CACHE_HOME` is resolved once.** Both binaries read it when their
  global paths load, so the credential plugin can drop it from the tools'
  environment without moving the cache.
- **The re-check covers refused connections, 401 and 403 only.** A 404 or 5xx
  is ordinary server behaviour and would cost a root exec each; a replacement
  that accepts any password is caught at the next start, status or peek read
  instead, and a fresh start's own server is reached again after at most five
  seconds.
- **An image without `opencode2-launch=1`** keeps node's package cache and
  the 2.x login-shell start until it is rebuilt.

Since 1.x was retired (2026-11-11) the decisions above that name 1.x are
history: only the 2.x start runs.

### Code a bridge loads itself

The launcher keeps out what a shell would run before the bridge starts. It
cannot keep out what the bridge loads once running. Pi's SDK runs in the Pi
bridge's own process, and with project resources on (the container default)
it runs the repository's extensions there: arbitrary TypeScript under
`/workspace/.pi/`, or a package the project's settings name, evaluated while
the session is built and before any model call. Code there sees every later
`Authorization` header and holds the in-process approval gate, so it could
resolve a parked call without the signature the approval routes require.
Being non-dumpable does not isolate code already inside the process.

Pi therefore loads no discovered extensions under **any** approval policy.
Every session shares the bridge process: code loaded under auto-approve or deny
could leave timers or process-wide hooks that survive disposal and affect a
later ask session. Deny refuses tool calls; it does not constrain arbitrary
extension code. Refusal must apply from process startup, including before a
policy narrows to ask. Restart an older bridge to obtain this boundary.

Configured packages in both user and project settings are excluded in memory
before the SDK's first resource reload. Package resolution can install missing
npm/git sources and execute lifecycle scripts before `noExtensions` filters
extension paths. Local project skills and prompt templates still load when
project resources are enabled; packaged resources do not. The bridge's own
inline extensions (approvals, MCP and command-change measurement) remain.
The reported policy keeps project resources on with a note explaining the
restriction. Separate extension processes would preserve more features but
require an RPC shim for Pi's in-process extension API.

`project-extensions-bridge.test.ts` plants a persistent process hook, then
attaches auto-approve, narrows to ask and attaches a separate ask session.
It verifies that the hook never enters the process. SDK tests cover configured
npm/git packages, both settings scopes and repeated reloads without installs.

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
already do. OpenCode has its own socket check on `opencode2-launch=1` images
([above](#opencode-under-the-launcher-opencode-launch1)); its remaining windows
are described [above](#opencode-2x-the-package-cache-and-project-configuration-opencode2-launch1).

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

- OpenCode: the session permission rules and saved rules in its database
  (`OPENCODE_DB`, `opencode2.db` under
  `~/.local/share/opencode/orkestrator-db`), and, on an image without
  `opencode2-launch=1`, the `permission` key of `opencode.json` (user or
  `/workspace`).
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
- **Reach OpenCode's password, narrowly.** On an `opencode2-launch=1` image
  the server loads no plugin, package or instruction file the agent writes,
  and the password is withheld from any other listener. Two windows remain by
  design: requests sent between a replacement and the first failed answer (or
  to a replacement that answers like OpenCode), and the server's first seconds
  before the warm request loads the plugin that makes it non-dumpable. An
  image without it keeps node's package cache and the 2.x login-shell start
  ([above](#opencode-2x-the-package-cache-and-project-configuration-opencode2-launch1)).
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

Project instruction staging supports literal files inside the checkout only.
Glob patterns and remote instruction URLs are deliberately omitted: they are
never passed to the credential-bearing server or fetched during staging.
The `opencode.project-config-filtered` diagnostic reports their counts separately
as `instructionGlob` and `instructionUrl`, as well as in the total dropped
`instructions` count. Use explicit checkout-relative instruction paths instead.
