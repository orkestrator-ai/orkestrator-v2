# The backend cannot tell the bridge it started from one the agent started

Carried from to-do 4980 task 1 when that file was closed (2026-11-06).

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`.

### Tasks

1. **Check the listener on a bridge's port is the process the backend started**: an agent's background process can kill its bridge and start a bridge of its own on the same port, from the verifier and public key it can read, and the backend keeps using it. Status: open.

### 1. Check the listener on a bridge's port is the process the backend started

**Problem.** On a `bridge-launch=1` image every request that changes an agent's authority carries the backend's Ed25519 signature, so a token caught by an imposter on the bridge's port answers no approval, sends no prompt and widens no policy on the bridge the backend started (`packages/protocol/src/node/bridge-authority.ts`). But the agent's uid can still replace that bridge. The verifier and the public key are not secret (both are in the launcher wrapper's argv), so the agent can start `bun /opt/<kind>-bridge/dist/index.js` itself, with a preload of its choosing, or run `orkestrator-bridge-launch` with its own values. The backend reads the same token from root's file, the new bridge accepts it, and every later session runs in a process the agent controls, where an `ask` approval means nothing. The user still sees an `ask` session.

**Context.** `apps/backend/tests/bridge-credential-docker.test.ts` ("a token an imposter on the bridge's port catches answers nothing") does exactly this on a real container: it kills the Pi bridge, catches the token from the backend's next request, starts a bridge through the launcher with the same verifier and key, and shows the caught token is refused while the backend's signed calls work. It does not, and cannot, show the backend noticing the swap. Getting there needs a persistent process the agent can already run, which on an `ask` environment is a command the user approved, and it ends the agent's own session and every approval parked on the old bridge. A process that can do this can already run any agent CLI with any permissions as `node`, so what it gains is the integrity of what the user sees, not a new capability in the container.

**Investigation.** Read from the start paths (`startContainerServer`, `peekContainerAgentBridge`, the `start_*_server` handlers): a running listener is accepted after an unauthenticated health check, and a reused one after `/global/auth-check` with the token, which an agent-run bridge passes. Nothing records which process the backend started. The launcher runs as `node`, so it cannot write a root-only record itself; the backend's own root exec can. Found on 2026-11-09 while building the same check for OpenCode (7252, done): the container's root has no `CAP_SYS_PTRACE`, so `ss -ltnp` and `/proc/<pid>/fd` cannot name the process holding a `node` uid's socket, nor can root read a non-dumpable process's `exe`; the recommended pid check below does not work as written. OpenCode records the inode of the listening socket from `/proc/net/tcp` instead (`apps/backend/src/core/opencode-listener-identity.ts`), which an imposter cannot reuse, and stops a listener as `node`.

**Decisions.**

- **How should the backend tell its bridge from a replacement?**
  - **Record the bridge's pid and start time with a root exec after launch, and compare the port's listener before trusting a running bridge (recommended).** `ss -ltnpH` (or `/proc/net/tcp` plus `/proc/<pid>/fd`) as root gives the listener's pid; `/proc/<pid>/stat` field 22 gives its start time. Check on reuse and on a failed or unexpected response, not on every request.
    - Pros: small; root is already used to read the token; a swapped bridge is refused and replaced rather than trusted.
    - Cons: one root exec per reuse; a race between the check and the next request; the agent can still kill the bridge (a denial of service it can already cause).
  - **Run the bridge under its own uid.**
    - Pros: the agent can neither kill nor replace it.
    - Cons: not possible for Pi and Cursor, whose SDKs run tools in the bridge process; for Claude, Codex and Grok the bridge reads state the CLI writes mode 600 under a mode 700 home (to-do 3930's decision record).
  - **Accept it and state it.**
    - Pros: no code.
    - Cons: an `ask` session can silently stop meaning `ask` after one approved background process.

## Related

- `4980-agent-uid-process-control.md` (deleted 2026-11-06)
- [`docs/architecture/agent-approvals.md`](../../architecture/agent-approvals.md)
- `3930-bridge-credential-out-of-agent-uid.md` (deleted 2026-11-06)
