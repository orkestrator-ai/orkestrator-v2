# The OpenCode server password was readable by the agent

Carried from security report S2, part `0040` tasks 1 and 3, when that report was closed (2026-11-04). OpenCode has no bridge of ours, so S2's verifier cannot reach it. Done the same day by a verification rework of S2: what it leaves is in [`4980-agent-uid-process-control.md`](4980-agent-uid-process-control.md).

## Task analysis

Analysed 2026-11-05 against `main` at `48d2ed40c`.

### Tasks

1. **Decide how OpenCode's approvals are protected from the agent**: a process as `node` could read the server password and answer OpenCode's own permission requests. Status: done.

### 1. Decide how OpenCode's approvals are protected from the agent

**Problem.** The container's OpenCode server took its password from `OPENCODE_SERVER_PASSWORD`, so it was in `/proc/<pid>/environ` of a process as `node`, in the environment of every tool, and the backend read it from `/tmp/opencode-server-password` as `node`. An agent that read it could call OpenCode's own permission route for its own requests.

**Context.** Part `0120` had taken this password off `docker exec` argv. OpenCode compares a plain password in its own code, so it cannot be given a hash, and it runs tools in the same uid. `exec` resets the non-dumpable flag, so a launcher cannot set it. OpenCode runs its plugins inside the server process under Bun, and loads them before the first tool of an instance can run.

**Investigation.** Exercised on the pinned OpenCode 1.19.5 on 2026-11-05. A plugin can call `prctl(PR_SET_DUMPABLE, 0)` through `bun:ffi`. OpenCode keeps the password it read at startup, so deleting `process.env.OPENCODE_SERVER_PASSWORD` leaves authentication on (no password and a wrong one 401, the right one 200) and removes it from a shell tool's environment. A bare `Bun.spawn` with no `env` would still pass the original variable on (Bun 1.4.4); strings in the OpenCode binary show only Bun's own uses of `Bun.spawn`, and its tools spawn with an explicit environment. Recheck on an OpenCode bump.

**Decisions.**

- **How should OpenCode be protected?**
  - **Root-only password file plus an in-process plugin that marks the server non-dumpable and removes the variable (recommended).**
    - Pros: the same boundary as a bridge holding a verifier, on the same image capability; no new process; a real permission raised by a real tool call is refused to the agent and works for the user.
    - Cons: the server holds a plain password in its memory and, until the plugin loads, in its readable environment; a process already running as `node` during a start can catch it. The plugin file is `node`-writable. Both are in 4980.
  - **State the limit where the environment's approvals are configured, and leave OpenCode as it is.** The recommendation before this was tried.
    - Pros: true at the time, no new code.
    - Cons: S2's acceptance requires that an approval cannot be answered from the agent's credentials alone; it would leave one platform open to `env | grep`.
  - **Put a bridge in front of `opencode serve`,** holding a verifier, with OpenCode bound to a private socket and its permission answers relayed through the bridge.
    - Pros: the password never reaches the agent's reach through the bridge.
    - Cons: a sixth bridge; the agent still shares a uid with OpenCode, so it can reach a private socket, and the password is still in its environment.

## Assumptions and decisions

### Where the password lives (task 1)

On a `bridge-credential=1` image it is in `/run/orkestrator-bridge/opencode-token`, and `readContainerBridgeToken` reads root's file first. A server an older backend started, and an older image's server, keep `/tmp/opencode-server-password`, counted under `bridge-credential.token-file`, and keep working until restarted or rebuilt.

### How the server gets it (task 1)

`boundedLaunchWithPrivateEnv` un-exports the variable and hands it to `opencode serve` alone. `boundedBackgroundLaunch`'s `sh -c` wrapper and log writer live as long as the server and are not protected, so each would have kept a readable copy. Checked on a real container: exactly one process matches `opencode serve`, and the token appears in no `environ` or `cmdline` the agent can read.

### When hardening fails (task 1)

In a container, a Linux server the plugin could not harden refuses tools (`tool.execute.before` throws): the binary is pinned, so this should never fire, and running tools there would hand them the password. On a host it logs and carries on, like a bridge, because a host's OpenCode can be any build and the host promises no boundary (4980 task 3).

### Host servers (task 1)

A local OpenCode server gets the plugin through `OPENCODE_CONFIG_DIR`, in `opencode-host-config` under the data directory, which adds to the user's configuration rather than replacing it. A user who set `OPENCODE_CONFIG_DIR` themselves keeps it, and that server goes without the plugin (`credential-plugin.skipped`). OpenCode installs its plugin SDK in that directory once, which took about 4.5 seconds on the first instance.

## Related

- `apps/backend/src/core/agent-credential-files.ts` (`buildOpenCodeCredentialPluginSource`), `apps/backend/src/core/commands-containers.ts` (`startContainerOpenCodeServer`), `apps/backend/src/core/opencode-host-credential.ts`
- `apps/backend/tests/bridge-credential-docker.test.ts` (a real permission, parked by a fake model in the container), `apps/backend/src/core/opencode-credential-plugin.test.ts`
- [`3930-bridge-credential-out-of-agent-uid.md`](3930-bridge-credential-out-of-agent-uid.md)
- [`4980-agent-uid-process-control.md`](4980-agent-uid-process-control.md)
