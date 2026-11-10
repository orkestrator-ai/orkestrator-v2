# OpenCode's hardened container start: what it does not cover yet

## Task analysis

Analysed 2026-11-09 against `main` at `c6de4733c`, with the branch that
finished to-do 7252 applied (see Replaces). That branch starts a container's
OpenCode 1.x server through the root-owned launcher (`opencode-launch=1`):
root's binary, configuration only from a root-owned directory, and the
password withheld unless the port's listening socket is the one the backend
recorded. What it found but did not cover is below.

### Tasks

1. **Start the OpenCode 2.x container server the same way**: it still starts from node's login shell, runs node's own binary and loads node-writable configuration. Status: open.
2. **Decide what to do about packages OpenCode installs into node's cache**: npm plugins named by the user's configuration and providers OpenCode does not bundle are installed into `~/.cache/opencode` and imported inside the server. Status: open.
3. **Decide whether a container should read the project's OpenCode configuration again**: `opencode.json` and `.opencode/` in the checkout no longer apply on an `opencode-launch=1` image. Status: open.
4. **Narrow the two windows the socket check leaves**: the moment between the check and the requests after it, and the server's first seconds before its plugin makes it non-dumpable. Status: open.

### 1. Start the OpenCode 2.x container server the same way

**Problem.** `buildOpenCode2ContainerStartScript`
(`apps/backend/src/core/opencode2/container-server.ts`) runs
`/home/node/.opencode/bin/opencode2`, which node owns, from node's login
shell, with `OPENCODE_CONFIG_DIR` pointing at a directory node writes. OpenCode
adds that directory to the ones it already reads, so `~/.config/opencode`,
`~/.opencode`, `/workspace/.opencode` and the project's `opencode.json` still
load, and any plugin there runs beside the 2.x password. Its password is
handed over by the private-environment launch (`boundedLaunchWithPrivateEnv`)
and nothing checks who listens on port 4102.

**Context.** The 1.x start is in `apps/backend/src/core/opencode-container-launch.ts`
and the launcher's `opencode` branch in `docker/orkestrator-bridge-launch.sh`;
the socket check is `apps/backend/src/core/opencode-listener-identity.ts`.
The 2.x server is beside 1.x until the 2.x provider replaces it
(`docs/todo/agent-engines/0008-opencode-v2.md`).

**Investigation.** Read from the start script on 2026-11-09; not exercised.
OpenCode 1.19.5 was shown to read `OPENCODE_TEST_HOME` for its home and
`XDG_CONFIG_HOME` for its global configuration; whether 2.2.6 does the same
has not been checked.

**Decisions.**

- **How should the 2.x server start?**
  - **A second launcher kind, `opencode2`, with the same root-owned binary, configuration directory and socket record, behind a new capability version (recommended).**
    - Pros: one mechanism for both servers; the tests and the record code are reused.
    - Cons: an image rebuild; 2.x's configuration flags must be confirmed first.
  - **Leave 2.x as it is until it replaces 1.x.**
    - Pros: no work on a server that is still being built.
    - Cons: a container that runs 2.x sessions has the hole 7252 closed for 1.x.

### 2. Decide what to do about packages OpenCode installs into node's cache

**Problem.** OpenCode installs packages into `$XDG_CACHE_HOME/opencode`
(node's `~/.cache/opencode`) and imports them into the server: npm plugins
named by the `plugin` key of the user's configuration, and the AI SDK package
of a provider it does not bundle. The agent's uid can write that directory, so
it can replace such a package's code before the server imports it.

**Context.** On an `opencode-launch=1` image the configuration that names the
packages is root's copy of the user's host configuration, so the agent cannot
add a package; it can only change one the user's configuration already uses.
A fresh server with only Orkestrator's plugins installed nothing there
(probe on 2026-11-09).

**Investigation.** Where OpenCode 1.19.5 installs and imports these packages
was read from the cache directory's contents, not from its source; no planted
package has been run.

**Decisions.**

- **What should the server import from?**
  - **First confirm with a planted package in a provider the user configures, then point the cache at a root-owned directory populated by a root exec before start (recommended).**
    - Pros: closes the path the same way as configuration.
    - Cons: packages must be installed before start, with network access as root; OpenCode may expect to write the cache at run time.
  - **Document it as a limit for users with npm plugins or unbundled providers.**
    - Pros: no work.
    - Cons: the boundary depends on what the user configured.

### 3. Decide whether a container should read the project's OpenCode configuration again

**Problem.** With `OPENCODE_DISABLE_PROJECT_CONFIG=1`, a checkout's
`opencode.json`, `.opencode/agents`, `.opencode/commands`, MCP servers and
permission rules no longer apply in a container. The checkout's `AGENTS.md` is
named back in as instructions; nothing else is.

**Context.** The 7252 decision accepted this loss ("unless copied in by the
backend"). The project's configuration is node-writable, so any part copied in
is as trustworthy as the agent.

**Investigation.** Confirmed on 2026-11-09 that the flag drops the project's
`AGENTS.md` from the system prompt and that `OPENCODE_CONFIG_CONTENT`
instructions restore it (a local OpenCode 1.19.5 against a fake model). The
other keys were not checked one by one.

**Decisions.**

- **What of the project's configuration should a container read?**
  - **Copy a filtered project `opencode.json` into root's directory before each start: no `plugin` key, no `{file:}` references outside the checkout (recommended).**
    - Pros: projects keep their agents, commands and MCP servers.
    - Cons: a parser and a filter to maintain; MCP servers and permission rules from the checkout are the agent's to change.
  - **Read none of it.**
    - Pros: nothing the agent writes shapes the server.
    - Cons: project configuration silently stops working in containers.

### 4. Narrow the two windows the socket check leaves

**Problem.** The backend checks the listening socket when it reads the
password, then sends requests for as long as it keeps the connection. A process
that replaces the server after the check catches whatever is sent before the
next read. Separately, the server is dumpable until its credential plugin runs
on the first instance load (the backend's warm request, right after the first
health check), so for that moment its environment and memory are readable by
the agent's uid.

**Context.** The check runs at start, status and peek
(`readContainerBridgeToken`). Replacing the server already requires a process
the user let run; the agent can stop the server at any time either way.

**Investigation.** Reasoned from the code on 2026-11-09; not exercised.

**Decisions.**

- **How should the windows narrow?**
  - **Re-check the socket on a failed or unexpected response from the server, and load an instance immediately after the first health check (already done) (recommended).**
    - Pros: small; matches the bridges' plan in the bridge listener check in [agent-approvals.md](../../architecture/agent-approvals.md#a-replaced-bridge-is-refused).
    - Cons: a window remains by design.
  - **Proxy OpenCode behind a small signed front of ours.**
    - Pros: the bridges' signature guarantees.
    - Cons: a new process in the path of every SDK request and event stream.

## Constraints and rationale

What 7252 built, and why (2026-11-09):

- **XDG_CONFIG_HOME, not `OPENCODE_CONFIG_DIR`, moves the global
  configuration.** OpenCode 1.19.5 adds `OPENCODE_CONFIG_DIR` to the
  directories it reads rather than replacing `~/.config/opencode`; a planted
  plugin there still loaded. `OPENCODE_TEST_HOME` moves the home whose
  `.opencode` it reads. The compiled binary read no `bunfig.toml` preload and
  no `.env` from its working directory.
- **The user's configuration comes from the host input.** Root copies
  `/opencode-config` (read-only, the staged host `~/.config/opencode`), never
  node's copy of it, without `node_modules`, symlinks or special files.
- **A socket, not a process.** The container's root lacks `CAP_SYS_PTRACE`
  and cannot map a socket to a `node` process, so the record is the listening
  socket's inode from `/proc/net/tcp`; stopping a listener runs as `node`.
- **Root's binary.** `/opt/opencode/bin/opencode` is root-owned and node's
  `~/.opencode/bin/opencode` is a symlink to it, which keeps terminal use and
  `OPENCODE_CLI_PATH` unchanged.

## Related

- 7250 (done and deleted; see [agent-approvals.md](../../architecture/agent-approvals.md#a-replaced-bridge-is-refused))
- [`docs/architecture/agent-approvals.md`](../../architecture/agent-approvals.md#opencode-under-the-launcher-opencode-launch1)

## Replaces

- `7252-opencode-server-loads-agent-writable-code.md` (done and deleted
  2026-11-09): both its tasks, the hardened start and the listener check, were
  built and qualified on a real container.
