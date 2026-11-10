# OpenCode's hardened container start: what it does not cover yet

## Task analysis

Analysed 2026-11-09 against `main` at `c6de4733c`, with the branch that
finished to-do 7252 applied (see Replaces). That branch starts a container's
OpenCode 1.x server through the root-owned launcher (`opencode-launch=1`):
root's binary, configuration only from a root-owned directory, and the
password withheld unless the port's listening socket is the one the backend
recorded. What it found but did not cover is below.

Reworked 2026-11-10 against `main` at `c98b20e6f` by the branch that built
tasks 1, 3 and 4 and most of task 2 behind a new image capability,
`opencode2-launch=1`. The living description is
[agent-approvals.md](../../architecture/agent-approvals.md#opencode-2x-the-package-cache-and-project-configuration-opencode2-launch1).

### Tasks

1. **Start the OpenCode 2.x container server the same way**: done 2026-11-10 (root's binary, root's configuration, a recorded socket; `opencode2-container-launch.ts`). Status: done.
2. **Decide what to do about packages OpenCode installs into node's cache**: 1.x now uses a root-owned cache root fills before each start; 2.x a root-owned cache that stays empty. What remains is filling 2.x's cache, so a provider 2.x does not bundle loads in a container. Status: open.
3. **Decide whether a container should read the project's OpenCode configuration again**: done 2026-11-10 (a filtered copy, with instruction files copied too; `opencode-project-config.ts`). Status: done.
4. **Narrow the two windows the socket check leaves**: done 2026-11-10 (a re-check after a failed or unexpected answer; the 2.x warm request now really loads its plugins). Status: done.

### 1. Start the OpenCode 2.x container server the same way

**Problem.** `buildOpenCode2ContainerStartScript`
(`apps/backend/src/core/opencode2/container-server.ts`) ran
`/home/node/.opencode/bin/opencode2`, which node owned, from node's login
shell, with `OPENCODE_CONFIG_DIR` pointing at a directory node writes, and
the checkout's `.opencode/` and `opencode.json` loaded. Nothing checked who
listened on port 4102.

**Context.** The 1.x start is in `apps/backend/src/core/opencode-container-launch.ts`
and the launcher's `opencode` branch in `docker/orkestrator-bridge-launch.sh`;
the socket check is `apps/backend/src/core/opencode-listener-identity.ts`.

**Investigation.** On 2026-11-10 the pinned 2.2.6 binary (downloaded with
`scripts/download-agent.ts opencode2`) was run outside a container with
plugins planted in the checkout's `.opencode/plugins` and `.opencode/plugin`,
`~/.config/opencode/plugins`, `~/.opencode/plugins` and `OPENCODE_CONFIG_DIR`.
2.2.6 reads `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_TEST_HOME` and the
XDG variables (read from the binary), and `OPENCODE_CONFIG_DIR` replaces its
global directory: with the launcher's environment only the
`OPENCODE_CONFIG_DIR` plugin loaded, the directory could be read-only, and
plugins load on the first request that needs the instance's agents
(`/api/agent`), not on `/api/session/active`, which the old warm request
used. `apps/backend/src/core/opencode2/opencode2-launch.live.test.ts` repeats
this against the binary.

**Decisions.**

- **How should the 2.x server start?**
  - **A second launcher kind, `opencode2`, with the same root-owned binary, configuration directory and socket record, behind a new capability version (recommended, built).**
    - Pros: one mechanism for both servers; the tests and the record code are reused.
    - Cons: an image rebuild.
  - **Leave 2.x as it is until it replaces 1.x.**
    - Pros: no work on a server that is still being built.
    - Cons: a container that runs 2.x sessions has the hole 7252 closed for 1.x.

### 2. Decide what to do about packages OpenCode installs into node's cache

**Problem.** OpenCode installs packages into `$XDG_CACHE_HOME/opencode`
(node's `~/.cache/opencode`) and imports them into the server: npm plugins
named by the `plugin` key of the user's configuration (1.x), and the AI SDK
package of a provider it does not bundle. The agent's uid could write that
directory, so it could replace such a package's code before the server
imported it.

**Context.** On an `opencode-launch=1` image the configuration that names the
packages is root's copy of the user's host configuration, so the agent cannot
add a package; it can only change one the user's configuration already uses.

**Investigation.** Confirmed on 2026-11-10 against both pinned binaries,
outside a container, with an unbundled provider (`ollama-ai-provider-v2`):
1.19.5 installs into `packages/<npm>` (a plugin given without a version into
`packages/<spec>@latest`), 2.2.6 into `npm/<spec>@<tag>/<generation>`, and
code planted in the cached package ran inside the next server of either
version. Both start with a read-only cache once `opencode/bin` exists, and
import a package already in it without installing again; 1.19.5 imported a
package installed there by `bun add --exact --ignore-scripts`. 2.2.6 chose
the tag itself (`@ai-sdk/elevenlabs@ai-v6`), so its directory names cannot be
predicted from the configuration.

**Decisions.**

- **What should the server import from?**
  - **A root-owned cache populated by a root exec before start (recommended; built for 1.x).**
    - Pros: closes the path the same way as configuration.
    - Cons: packages need network as root at start; 2.x's layout is internal.
  - **Document it as a limit for users with npm plugins or unbundled providers.**
    - Pros: no work.
    - Cons: the boundary depends on what the user configured.
- **How should 2.x's cache be filled (open)?**
  - **Run a throwaway 2.x install step under a uid that is neither node nor root, then hand the result to root (recommended).**
    - Pros: 2.x lays out its own cache, so its internal names stay right across bumps.
    - Cons: needs a third uid in the image and a way to make 2.x install without starting a session.
  - **Reproduce 2.x's layout with Bun as 1.x's is.**
    - Pros: small.
    - Cons: depends on 2.x's tag choice, which is not in the configuration and can change with any bump.
  - **Leave it empty.**
    - Pros: nothing to maintain; no package the agent can touch.
    - Cons: an unbundled provider does not load in a container's 2.x server.

### 3. Decide whether a container should read the project's OpenCode configuration again

**Problem.** With `OPENCODE_DISABLE_PROJECT_CONFIG=1`, a checkout's
`opencode.json`, MCP servers, agents, commands and permission rules no longer
applied in a container.

**Context.** The project's configuration is node-writable, so any part copied
in is as trustworthy as the agent.

**Investigation.** Confirmed on 2026-11-10 that both pinned binaries load
`OPENCODE_CONFIG` with project configuration off, instructions included. The
same day showed that naming an instruction file by its checkout path is not
safe: OpenCode reads it in the server's own process when it builds a prompt,
and a checkout `AGENTS.md` linked to `/proc/self/environ` put the 2.2.6
server's password into the model request. `{env:}` references are
substituted from the server's environment, which holds the password, and
`{file:}` references are read by the server, so both are filtered too.

**Decisions.**

- **What of the project's configuration should a container read?**
  - **Copy a filtered project `opencode.json` into root's directory before each start (recommended, built).** No `plugin`/`plugins` key, no `{env:}` reference, `{file:}` only inside the checkout and inlined from a read as `node`, and instruction files (the checkout's `AGENTS.md` first) copied as `node` and named by root's copy.
    - Pros: projects keep their agents, commands and MCP servers; nothing the server reads by path can be pointed at its own environment.
    - Cons: a filter to maintain; an edit to an instruction reaches the server at its next start; globbed instruction paths and the checkout's `.opencode/` directories are not read.
  - **Read none of it.**
    - Pros: nothing the agent writes shapes the server.
    - Cons: project configuration silently stops working in containers.

### 4. Narrow the two windows the socket check leaves

**Problem.** The backend checks the listening socket when it reads the
password, then sends requests for as long as it keeps the connection. A
process that replaces the server after the check catches whatever is sent
before the next read. Separately, the server is dumpable until its credential
plugin runs on the first instance load.

**Context.** The check runs at start, status and peek
(`readContainerBridgeToken`).

**Investigation.** On 2026-11-10 the 2.x warm request (`/api/session/active`)
was found not to load plugins on 2.2.6, so a 2.x server stayed dumpable until
its first session; `/api/agent` loads them (probed, and the live test reads
`/proc/<pid>/environ` before and after).

**Decisions.**

- **How should the windows narrow?**
  - **Re-check the socket on a failed or unexpected response from the server, and load an instance immediately after the first health check (recommended, built).** `opencode-listener-recheck.ts` wraps the 1.x SDK client's and the 2.x client's fetch: after a refused connection, a 401 or a 403 it asks root which socket listens, and once it is not the recorded one nothing more is sent on that connection (it asks again at most every five seconds, so a fresh start's own server is reached again).
    - Pros: small; matches the bridges' plan in [agent-approvals.md](../../architecture/agent-approvals.md#a-replaced-bridge-is-refused).
    - Cons: a window remains by design: requests before the first failure, and a replacement that answers like OpenCode.
  - **Proxy OpenCode behind a small signed front of ours.**
    - Pros: the bridges' signature guarantees.
    - Cons: a new process in the path of every SDK request and event stream.

## Current state

- Code: `apps/backend/src/core/opencode2-container-launch.ts`,
  `opencode-package-cache.ts`, `opencode-project-config.ts`,
  `opencode-listener-recheck.ts`; the launcher's `opencode2` branch and the
  1.x branch's cache and project file in `docker/orkestrator-bridge-launch.sh`;
  `/opt/opencode/bin/opencode2` and `/run/orkestrator-opencode2` in
  `docker/Dockerfile`.
- Tests: the unit tests beside each module run the real launcher script and
  root scripts with their paths moved into a temporary directory;
  `apps/backend/tests/opencode2-container-server.test.ts` covers the launcher
  start, reuse and replacement against fake Docker;
  `opencode2-launch.live.test.ts` runs the pinned 2.2.6 binary
  (`RUN_LIVE_OPENCODE2=1`); `apps/backend/tests/bridge-credential-docker.test.ts`
  has the real-container cases (`RUN_LIVE_DOCKER_TESTS=1`).

## Outstanding work

- Task 2: fill 2.x's root-owned cache (decision above).

## Constraints and rationale

What 7252 built, and why (2026-11-09):

- **XDG_CONFIG_HOME, not `OPENCODE_CONFIG_DIR`, moves 1.x's global
  configuration.** OpenCode 1.19.5 adds `OPENCODE_CONFIG_DIR` to the
  directories it reads rather than replacing `~/.config/opencode`; a planted
  plugin there still loaded. `OPENCODE_TEST_HOME` moves the home whose
  `.opencode` it reads. 2.2.6 is the other way round: `OPENCODE_CONFIG_DIR`
  replaces its global directory, which is why the 2.x launch writes there.
- **The user's configuration comes from the host input.** Root copies
  `/opencode-config` (read-only, the staged host `~/.config/opencode`), never
  node's copy of it, without `node_modules`, symlinks or special files. For
  2.x it copies only what 2.x reads and merges the configuration files without
  a `plugin` key, because 2.x would install one.
- **A socket, not a process.** The container's root lacks `CAP_SYS_PTRACE`
  and cannot map a socket to a `node` process, so the record is the listening
  socket's inode from `/proc/net/tcp`; stopping a listener runs as `node`.
- **Root's binaries.** `/opt/opencode/bin/opencode` and `opencode2` are
  root-owned and node's `~/.opencode/bin` entries are symlinks to them.

Added 2026-11-10:

- **An `opencode-launch=1` image without `opencode2-launch=1` keeps three
  gaps** until it is rebuilt: the checkout's `AGENTS.md` named by path, node's
  package cache, and the 2.x login-shell start. The backend writes the root
  cache and project file there too, harmlessly; that launcher ignores them.
- **XDG_CACHE_HOME is resolved once.** Both binaries read it when their
  global paths load (read from the binaries), so the credential plugin can
  remove it from the tools' environment afterwards without moving the cache.

## Related

- 7250 (done and deleted; see [agent-approvals.md](../../architecture/agent-approvals.md#a-replaced-bridge-is-refused))
- [`docs/architecture/agent-approvals.md`](../../architecture/agent-approvals.md#opencode-under-the-launcher-opencode-launch1)
- [0008-opencode-v2.md](../agent-engines/0008-opencode-v2.md): the 2.x provider these servers serve.

## Replaces

- `7252-opencode-server-loads-agent-writable-code.md` (done and deleted
  2026-11-09): both its tasks, the hardened start and the listener check, were
  built and qualified on a real container.

## Assumptions and decisions

### Task 1: the capability is a new name, not `opencode-launch=2`

The backend greps the launcher for `opencode-launch=1` exactly
(`readContainerOpenCodeCredential`), and the 1.x mode check asks for version
1, so bumping that marker would have needed both changed and would have said
nothing about 2.x. `opencode2-launch=1` names what the backend checks before
the 2.x launch and before filling the 1.x cache.

### Task 1: the 2.x warm request is `/api/agent`

2.2.6 loaded its plugins for `/api/agent`, `/api/command`, `/api/config` and
`/api/provider` but not for `/api/session/active` or `/api/session` (probed
2026-11-10). `/api/agent` is read-only and small; the socket is recorded only
after it, as for 1.x. The login-shell 2.x start uses the same warm request,
which narrows its pre-plugin window too.

### Task 2: 1.x installs as root with the image's Bun

`bun add --exact --ignore-scripts` from `/` with no Bun configuration or
`.env`, so no package code runs as root; at most 16 packages per start, each
bounded to 120 seconds; a failure is reported on stderr and never fails the
start. Only plain registry specs from root's copy of the user's configuration
are installed, never one named by the project.

### Task 3: instruction files are copies, and `AGENTS.md` is one of them

The probe that showed `AGENTS.md` linked to `/proc/self/environ` reaching the
prompt made naming any instruction by its checkout path unsafe, so the new
launcher stops naming `/workspace/AGENTS.md` and the backend always stages the
project file when the checkout has an `AGENTS.md`. The trade-off is that an
edit is read at the next start rather than the next turn.

### Task 4: the re-check covers 401, 403 and refused connections only

A 404 or 5xx is ordinary server behaviour and would cost a root exec on every
such answer; an imposter that answers with a password of its own refuses the
backend's (401), and one that is not listening refuses the connection. A
replacement that accepts any password is not caught by this re-check; it is
caught at the next start, status or peek read.
