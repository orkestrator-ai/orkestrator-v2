# The OpenCode server password is still readable by the agent

Carried from security report S2, part `0040` tasks 1 and 3, when that report was closed (2026-11-04). OpenCode has no bridge of ours, so S2's verifier cannot reach it.

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`.

### Tasks

1. **Decide how OpenCode's approvals are protected from the agent**: a process as `node` can read the server password and answer OpenCode's own permission requests. Status: open.

### 1. Decide how OpenCode's approvals are protected from the agent

**Problem.** The container's OpenCode server takes its password from `OPENCODE_SERVER_PASSWORD`, so it is in `/proc/<pid>/environ` of a process as `node`, and the backend reads it from `/tmp/opencode-server-password` as `node`. An agent that reads it can call OpenCode's own permission route for its own requests.

**Context.** Part `0120` did take this password off `docker exec` argv (`startContainerOpenCodeServer`, on stdin). `readContainerBridgeToken` reads OpenCode's password only from `/tmp`, on purpose. OpenCode compares a plain password in its own code, so it cannot be given a hash, and it runs tools in the same uid. Bridges mark themselves non-dumpable through `bun:ffi`; OpenCode is a third-party binary, and `exec` resets the flag, so a launcher cannot do it either.

**Investigation.** Read from code on 2026-11-04. The permission route was not exercised as an attack.

**Decisions.**

- **How should OpenCode be protected?**
  - **State the limit where the environment's approvals are configured, and leave OpenCode as it is (recommended).**
    - Pros: true today, no new process; OpenCode users are told what `ask` means there.
    - Cons: the boundary stays clearable on OpenCode.
  - **Put a bridge in front of `opencode serve`,** holding a verifier, with OpenCode bound to a private socket and its permission answers relayed through the bridge.
    - Pros: the same boundary as every other platform.
    - Cons: a sixth bridge; the agent still shares a uid with OpenCode, so it can reach a private socket, and the password is still in its environment.

## Related

- [`3930-bridge-credential-out-of-agent-uid.md`](3930-bridge-credential-out-of-agent-uid.md)
- [`4980-agent-uid-process-control.md`](4980-agent-uid-process-control.md)
