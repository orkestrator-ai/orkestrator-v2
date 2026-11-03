# Keep the bridge-control credential away from the agent it controls

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Move the credential out of the agent's uid**: the token file and `/proc/<bridge pid>/environ` are still readable by the agent. Status: open.
2. **Authorise a user's widening through the backend**: a live session on any bridge only takes a wider policy after a bridge restart. Status: open (depends on 1).
3. **Stop self-answered approvals**: any token holder can answer a pending approval. Status: open (depends on 1).
4. **Decide whether `readOnly` follows the narrow-only rule**: a token holder can clear a session's read-only review boundary. Status: open.

### 1. Move the credential out of the agent's uid

**Problem.** On a hardened environment (`approvals: "ask"` or a sandbox), an agent that reads the token can still undo the human approval step.

**Context.** Tracked as [todo 3930](../../todo/containers-and-environments/3930-bridge-credential-out-of-agent-uid.md) task 1.

**Investigation.** The start script still writes the token as `node` (`apps/backend/src/core/commands-containers.ts:951`) and exports it (`:970`).

**Decisions.** None here: todo 3930 task 1 holds the options.

### 2. Authorise a user's widening through the backend

**Problem.** A wider policy from the user is refused with 403 until the bridge restarts.

**Context.** Tracked as todo 3930 task 3.

**Investigation.** Not re-traced here; the refusal is `POLICY_WIDENING_REFUSED_CODE` (`packages/protocol/src/execution-policy-narrowing.ts:140`).

**Decisions.** None here: todo 3930 task 3 holds the options.

### 3. Stop self-answered approvals

**Problem.** The narrow-only rule does not cover an answer, which is a decision rather than a policy.

**Context.** Tracked as todo 3930 task 4.

**Investigation.** Not re-traced here; todo 3930 lists the routes.

**Decisions.** None here: todo 3930 task 4 holds the options.

### 4. Decide whether `readOnly` follows the narrow-only rule

**Problem.** `readOnly` is a separate request field, outside the policy comparison.

**Context.** Tracked as [todo 4210](../../todo/containers-and-environments/4210-read-only-boundary-from-a-token-holder.md).

**Investigation.** Pi still applies the body's value (`bridges/pi-bridge/src/http.ts:428-435`).

**Decisions.** None here: todo 4210 holds the options.

## Current state

Done, so not in Tasks:

- Every bridge deletes its token from `process.env` at startup: `bridges/claude-bridge/src/index.ts:70`, `bridges/codex-bridge/src/index.ts:230`, `bridges/pi-bridge/src/config.ts:23`, `bridges/cursor-bridge/src/config.ts:21`, `bridges/acp-bridge/src/acp-context.ts:703`.
- Every route that takes a policy refuses a wider one (`packages/protocol/src/execution-policy-narrowing.ts`; commits `2d4528dc5`, `a2bba9d80`), for example `bridges/claude-bridge/src/routes/session.ts:266`, `:515`, `bridges/codex-bridge/src/index.ts:193`, `bridges/pi-bridge/src/http.ts:284`, `bridges/cursor-bridge/src/http.ts:216`, `bridges/acp-bridge/src/acp-server.ts:49`.

## Related

- [Security report, H4](../2-26-10-27-security.md#h4-an-agent-can-read-its-own-bridge-control-token-then-self-approve-or-widen-its-execution-policy)
- [Todo 3930](../../todo/containers-and-environments/3930-bridge-credential-out-of-agent-uid.md)
- [Todo 4210](../../todo/containers-and-environments/4210-read-only-boundary-from-a-token-holder.md)
- [0120](0120-l2-tokens-in-docker-exec-argv.md): the same token on the `docker exec` command line
