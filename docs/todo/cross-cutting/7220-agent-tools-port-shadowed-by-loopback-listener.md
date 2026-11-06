# Agent tools port shadowed by another process's loopback listener

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab7`. Found while running
`e2e/agent-testing/mcp-ui-matrix.spec.ts` for
[0039](../mcp/0039-mcp-management.md) task 14 on a restarted `dev:test`
profile beside another worktree's profile.

### Tasks

1. **Stop a restarted backend from sharing its agent tools port with another process's loopback listener**: on macOS the wildcard bind of a saved port succeeds while another process holds the same port on `127.0.0.1`, so host agents send their agent tools bearer token to that process and get 401. Status: open.

### 1. Stop a restarted backend from sharing its agent tools port with another process's loopback listener

**Problem.** After a restart, host agents of a backend can lose every
Orkestrator tool: the CLI reports the injected `orkestrator` server `failed`
with "Server rejected the configured Authorization header (HTTP 401)". Their
requests, bearer token included, go to a different process. Seen on
2026-11-06 with two `dev:test` profiles on one Mac, and the same code path
runs in production.

**Context.** `AgentToolsServer` listens on `0.0.0.0`, because container agents
reach it through `host.docker.internal`, and asks first for the port it
used last time (`preferredPort = port ?? workflowResults.capabilityPort()` in
`apps/backend/src/core/agent-tools.ts`, saved by `recordCapabilityPort` in
`workflow-result-service.ts`). Only `EADDRINUSE` makes it fall back to an
ephemeral port. Host agents are handed `http://127.0.0.1:<port>/mcp`
(`connection()`). The port is saved so that workflow-result capabilities stay
valid across restarts ([container-lifecycle.md](../../architecture/container-lifecycle.md)
covers the container side).

**Investigation.** Profile `mcp0039-t14` first ran at 03:43 and its agent
tools server took the ephemeral port 49745, which was saved. The profile
stopped at 03:59, freeing the port. At 04:10 another worktree's `dev:test`
backend took `127.0.0.1:49745` for a loopback-only listener. At 04:12
`mcp0039-t14` restarted and asked for 49745 on `0.0.0.0`. macOS (BSD socket
rules, with the `SO_REUSEADDR` Node and Bun set on listeners) lets a wildcard
bind coexist with another socket's specific-address bind, so the listen
succeeded. `lsof -iTCP:49745 -sTCP:LISTEN` then showed `*:49745` (this
backend) and `127.0.0.1:49745` (the other one). The kernel gives a loopback
connection to the more specific bind, so every host agent's MCP request reached
the other backend, which does not know the token and answered 401. A third
start of the same profile picked 49745 again and failed the same way. After
`dev:reset` cleared the saved port, an ephemeral port worked. Linux is expected
to refuse the second bind with `EADDRINUSE`, which would make this macOS only;
that was not checked.

Effects:

- Host agents (Claude, Codex, OpenCode, Cursor, Grok, Pi) lose agent mail,
  tickets, artifacts and every other Orkestrator tool until the backend
  restarts on another port. Container agents still reach the right server,
  because `host.docker.internal` is not loopback.
- The bearer token, scoped to one environment and tab, is sent to whatever
  process holds the loopback port. Normally that is another Orkestrator
  backend, but it could be any local process that took the port first.
- The failure looks like a bad token, not a port clash, and nothing logs it.

**Decisions.**

- **How to make the bind exclusive?**
  - **Also listen on `127.0.0.1:<port>` for the server's lifetime, with the
    same handler, and treat `EADDRINUSE` on either bind as "taken" (fall back
    to an ephemeral port for both) (recommended).**
    - Pros: detects the clash at start and also stops a process from taking
      the loopback port later; the token never leaves the backend; no change
      to the saved-port rule or to containers.
    - Cons: two listeners to start, close and test; on Linux the second bind
      of the same port inside one process needs checking (the wildcard bind
      may already cover it, and the code must accept that answer).
  - **Briefly bind `127.0.0.1:<port>` before the wildcard bind and close it.**
    - Pros: smallest change.
    - Cons: a race between the check and the listen; does not stop a later
      process from taking the loopback port.
  - **Stop saving the port and always take an ephemeral one.**
    - Pros: no stale port to clash on.
    - Cons: breaks workflow-result capabilities and container firewall rules
      across restarts, which is why the port is saved.
- **What to verify after the fix?**
  - **A macOS unit test that holds `127.0.0.1:P` in a second server, starts the
    agent tools server with preferred port `P`, and asserts it moved to another
    port, plus one rerun of `mcp-ui-matrix.spec.ts` on a restarted profile
    (recommended).**
    - Pros: reproduces the exact clash without a second backend.
    - Cons: the test is only meaningful on macOS (Linux is expected to refuse
      the bind already).
  - **Only rerun the browser spec.**
    - Pros: no new test.
    - Cons: depends on another process happening to take the saved port.

## Constraints and rationale

- Never stop or signal the other backend to clear a clash: it belongs to
  another worktree or to production. Reset only your own profile.

## Related

- [0244-second-backend-on-one-host.md](0244-second-backend-on-one-host.md)
  and
  [0996-second-backend-takes-default-gateway-port.md](0996-second-backend-takes-default-gateway-port.md):
  other port clashes between backends on one host.
- [0039-mcp-management.md](../mcp/0039-mcp-management.md) task 14, where it
  was found.
