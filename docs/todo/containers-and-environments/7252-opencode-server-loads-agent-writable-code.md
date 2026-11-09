# OpenCode's server still loads code the agent can write, and gives its password to any listener

Carried from to-do 4980 tasks 1 and 2 when that file was closed (2026-11-06).

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`.

### Tasks

1. **Start OpenCode without reading agent-writable plugins or configuration**: a container's `opencode serve` loads plugins and the `plugin` key from paths `node` owns, and a plugin runs inside the server with a client that needs no password. Status: open.
2. **Stop an imposter on port 4096 catching the password**: OpenCode has no bridge of ours, so the signed-authority work does not cover it, and the backend sends the plain password to whatever answers its port. Status: open.

### 1. Start OpenCode without reading agent-writable plugins or configuration

**Problem.** The five bridges now start through the root-owned launcher with a fixed environment (`bridge-launch=1`). OpenCode's server is still started from the `node` login shell, and loads, at every instance start, plugins in `~/.config/opencode/plugins` (the credential plugin's own file among them), `/workspace/.opencode/plugins` and the `plugin` key of `opencode.json`. `opencode` itself lives in `/home/node/.opencode/bin`, which `node` owns.

**Context.** `startContainerOpenCodeServer` (`apps/backend/src/core/commands-containers.ts`); the credential plugin is `buildOpenCodeCredentialPluginSource` (`agent-credential-files.ts`). On a `bridge-launch=1` image OpenCode keeps the verifier image's hardened start: the plugin keeps the password from tools, as `apps/backend/tests/bridge-credential-docker.test.ts` shows on Docker Desktop. The backend does not set `OPENCODE_DISABLE_PROJECT_CONFIG` for container servers.

**Investigation.** Plugin loading was read from behaviour on 2026-11-05 (to-do 4980). No planted plugin has been run.

**Decisions.**

- **How should OpenCode start?**
  - **Set `OPENCODE_DISABLE_PROJECT_CONFIG`, point `OPENCODE_CONFIG_DIR` at a root-owned directory holding only the credential plugin, and run a root-owned `opencode` (recommended).**
    - Pros: closes the planted-plugin path the same way the launcher closed it for bridges.
    - Cons: a user's own OpenCode plugins and project `opencode.json` stop loading in containers unless copied in by the backend; the binary needs a root-owned install in the image.
  - **Keep the plugin as the only defence.**
    - Pros: no change.
    - Cons: any planted plugin is a second plugin with the same reach.

### 2. Stop an imposter on port 4096 catching the password

**Problem.** OpenCode takes the plain password (Basic auth). An agent that kills the server and listens on 4096 reads it from the backend's next request and can answer every permission on a server started with it.

**Context.** The bridges' signatures (`bridge-authority.ts`) need a verifier in the server, which OpenCode does not have; the credential plugin cannot add one to the server's own routes. The listener check from to-do 7250 was built for the five bridges on 2026-11-09 (`apps/backend/src/core/container-bridge-listener.ts`, described in [agent-approvals.md](../../architecture/agent-approvals.md#a-replaced-bridge-is-refused)): a start records the port's listening socket (inode and cookie) as root once the bridge answers, and `readContainerBridgeToken` refuses the token to any other socket. It deliberately skips `opencode` and `opencode2`. Extending it here means recording in `startContainerOpenCodeServer` and `opencode2-container-server.ts` after their health wait, dropping the `isContainerBridgeKind` guard in `readContainerBridgeToken` and `writeContainerBridgeCredential` for OpenCode's kinds and its port, and stopping the listener in `replaceRunningServer`. It does not stop the password reaching an imposter that is already listening when a request is made between two checks.

**Investigation.** Reasoned from the routes; not exercised.

**Decisions.**

- **How should the backend stop giving the password to an imposter?**
  - **Use 7250's listener check before sending the password (recommended).**
    - Pros: one mechanism for bridges and OpenCode.
    - Cons: the same race between check and request; OpenCode sends the password on every SDK request and event stream, so the window is wider than a bridge's.
  - **Proxy OpenCode behind a small signed front of ours.**
    - Pros: the same signature guarantees as the bridges.
    - Cons: a new process in every container, in the path of every SDK request and event stream.

## Related

- `4980-agent-uid-process-control.md` (deleted 2026-11-06)
- `4981-opencode-password-readable-by-agent.md` (deleted 2026-11-06)
- `7250-bridge-replaced-by-an-agent-process.md` (deleted 2026-11-09; the bridges' listener check it built is in [agent-approvals.md](../../architecture/agent-approvals.md#a-replaced-bridge-is-refused))
- [`docs/architecture/agent-approvals.md`](../../architecture/agent-approvals.md)
