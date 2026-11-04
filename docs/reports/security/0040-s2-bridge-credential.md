# S2: Bridge credential

This file combines 3 reports into one batch to build together. `0120` says to do it with or after `0040`. `0250` changes how those tokens look. The options for `0040` are in todos 3930 and 4210.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0040](#0040-keep-the-bridge-control-credential-away-from-the-agent-it-controls) | High | H4: credential out of the agent's uid, widening, self-answered approvals, `readOnly` |
| [0120](#0120-take-bridge-and-agent-tools-tokens-off-the-docker-exec-command-line) | Medium | L2: bridge and agent-tools tokens in `docker exec` argv |
| [0250](#0250-give-internal-tokens-a-recognisable-prefix) | Low | I7: `okb_` prefix and redaction rule |

## 0040: Keep the bridge-control credential away from the agent it controls

### Task analysis

#### Tasks

1. **Move the credential out of the agent's uid**: the token file and `/proc/<bridge pid>/environ` are still readable by the agent. Status: open.
2. **Authorise a user's widening through the backend**: a live session on any bridge only takes a wider policy after a bridge restart. Status: open (depends on 1).
3. **Stop self-answered approvals**: any token holder can answer a pending approval. Status: open (depends on 1).
4. **Decide whether `readOnly` follows the narrow-only rule**: a token holder can clear a session's read-only review boundary. Status: open.

#### 1. Move the credential out of the agent's uid

**Problem.** On a hardened environment (`approvals: "ask"` or a sandbox), an agent that reads the token can still undo the human approval step.

**Context.** Tracked as [todo 3930](../../todo/containers-and-environments/3930-bridge-credential-out-of-agent-uid.md) task 1.

**Investigation.** The start script still writes the token as `node` (`apps/backend/src/core/commands-containers.ts:951`) and exports it (`:970`).

**Decisions.** None here: todo 3930 task 1 holds the options.

#### 2. Authorise a user's widening through the backend

**Problem.** A wider policy from the user is refused with 403 until the bridge restarts.

**Context.** Tracked as todo 3930 task 3.

**Investigation.** Not re-traced here; the refusal is `POLICY_WIDENING_REFUSED_CODE` (`packages/protocol/src/execution-policy-narrowing.ts:140`).

**Decisions.** None here: todo 3930 task 3 holds the options.

#### 3. Stop self-answered approvals

**Problem.** The narrow-only rule does not cover an answer, which is a decision rather than a policy.

**Context.** Tracked as todo 3930 task 4.

**Investigation.** Not re-traced here; todo 3930 lists the routes.

**Decisions.** None here: todo 3930 task 4 holds the options.

#### 4. Decide whether `readOnly` follows the narrow-only rule

**Problem.** `readOnly` is a separate request field, outside the policy comparison.

**Context.** Tracked as [todo 4210](../../todo/containers-and-environments/4210-read-only-boundary-from-a-token-holder.md).

**Investigation.** Pi still applies the body's value (`bridges/pi-bridge/src/http.ts:428-435`).

**Decisions.** None here: todo 4210 holds the options.

### Current state

Done, so not in Tasks:

- Every bridge deletes its token from `process.env` at startup: `bridges/claude-bridge/src/index.ts:70`, `bridges/codex-bridge/src/index.ts:230`, `bridges/pi-bridge/src/config.ts:23`, `bridges/cursor-bridge/src/config.ts:21`, `bridges/acp-bridge/src/acp-context.ts:703`.
- Every route that takes a policy refuses a wider one (`packages/protocol/src/execution-policy-narrowing.ts`; commits `2d4528dc5`, `a2bba9d80`), for example `bridges/claude-bridge/src/routes/session.ts:266`, `:515`, `bridges/codex-bridge/src/index.ts:193`, `bridges/pi-bridge/src/http.ts:284`, `bridges/cursor-bridge/src/http.ts:216`, `bridges/acp-bridge/src/acp-server.ts:49`.

## 0120: Take bridge and agent-tools tokens off the `docker exec` command line

### Task analysis

#### Tasks

1. **Pass the tokens on stdin**: they are in the argv of `docker exec` while the CLI runs. Status: open.

#### 1. Pass the tokens on stdin

**Problem.** While `docker exec` runs, any local user can read the bridge token and agent-tools token through `ps` or `/proc`.

**Context.** `syncContainerCursorApiKey` already sends a secret on stdin (`apps/backend/src/core/commands-files.ts:2481-2498`), as does the GitHub credential sync (`:2402`), so the pattern exists. `redactValues` only keeps these values out of the backend's logs.

**Investigation.** The start scripts embed the values with `quoteShell`: Claude (`apps/backend/src/core/commands-containers.ts:951`, `:970`, `:977`), Codex (`apps/backend/src/core/commands-registry-servers.ts:434`, `:440`), Cursor and ACP (`:594`, `:602`) and Pi (`:728`). The whole script is one argument of `docker exec -d ... bash -lc` (`apps/backend/src/core/commands-server-health.ts:31-36`).

**Decisions.**

- **How should the script get the values?**
  - **Write them to a mode 600 file through a separate stdin `docker exec`, then have the start script read that file and remove it (recommended).**
    - Pros: `docker exec -d` has no stdin to read from, so this keeps detached starts; reuses the existing credential pattern.
    - Cons: one more exec per bridge start, and a brief file on disk unless it is removed.
  - **Attach stdin to the start script, with a wait for the bridge to detach.**
    - Pros: nothing written twice.
    - Cons: changes `dockerExecDetached` and how every bridge backgrounds itself.

### Constraints and rationale

- Do this with, or after, the design choice in [0040](#0040-keep-the-bridge-control-credential-away-from-the-agent-it-controls). If the bridge credential moves to an inherited descriptor or a separate uid, how the token reaches the bridge changes again.

### Needs verification

- Whether Docker Desktop exposes the `docker` client's argv to other local users in the same way as a Linux host. The report's scenario is a local co-tenant.

## 0250: Give internal tokens a recognisable prefix

### Task analysis

#### Tasks

1. **Prefix internal tokens and add a redaction rule**: redaction cannot recognise a bridge, gateway or MCP token by its shape. Status: open.

#### 1. Prefix internal tokens and add a redaction rule

**Problem.** Log redaction works by shape, and these tokens are bare base64url, so one in a log line without `Bearer` or a `key=` form passes through.

**Context.** Client grants already have a prefix, `okg_` (`apps/backend/src/core/nodes/client-grants.ts:21`). The rules are in `packages/protocol/src/secret-redaction.ts:19-50`, and the bridge output adds its own (`apps/backend/src/core/bridge-output-redaction.ts:36`).

**Investigation.** Unprefixed tokens are minted at `apps/backend/src/core/commands-containers.ts:941`, `apps/backend/src/core/commands-registry-servers.ts:412`, `:575`, `apps/backend/src/core/agent-tools.ts:1058`, `:1101`, `:1182`, with fallbacks in each bridge (for example `bridges/claude-bridge/src/index.ts:66`). The gateway token is `apps/backend/src/gateway-support-extra.ts:173`, and browser sessions `apps/backend/src/gateway-sessions.ts:144`. `BRIDGE_TOKEN_PATTERN` is exactly 43 base64url characters (`apps/backend/src/core/local-server-runtime.ts:51`), and persisted tokens are checked against it (`apps/backend/src/core/commands-containers.ts:914`), so an `okb_` token fails today's check. The agent-tools bearer pattern admits `_` and the length (`apps/backend/src/core/agent-tools.ts:172`).

**Decisions.**

- **Which tokens first?**
  - **Bridge and agent-tools tokens, with `BRIDGE_TOKEN_PATTERN` accepting both forms for a running bridge (recommended).**
    - Pros: these reach container logs, the case in the report; both are minted by the backend, so no user sees a change.
    - Cons: a pattern with two forms until no old bridge is running.
  - **All, including the gateway token.**
    - Pros: complete.
    - Cons: a gateway token can be user-chosen and existing ones must keep working, so a prefix cannot cover them; its format is part of the client contract.

### Current state

Done, so not in Tasks: `boundDiagnosticTail` runs each line through `redactBridgeLogLine`, so every container log tail is scrubbed (`apps/backend/src/core/container-log-bounds.ts:2`, `:29-31`; commit `20e2863e5`). [Todo 4030](../../todo/cross-cutting/4030-secret-redaction-quadratic-rules.md), which made those rules linear, is done.

### Constraints and rationale

- A token that `tail -c` cut through has lost its prefix, so a prefix does not catch it (the report's note).

## Related

- [Security report, H4](../2-26-10-27-security.md#h4-an-agent-can-read-its-own-bridge-control-token-then-self-approve-or-widen-its-execution-policy)
- [Todo 3930](../../todo/containers-and-environments/3930-bridge-credential-out-of-agent-uid.md)
- [Todo 4210](../../todo/containers-and-environments/4210-read-only-boundary-from-a-token-holder.md)
- [0120](#0120-take-bridge-and-agent-tools-tokens-off-the-docker-exec-command-line): the same token on the `docker exec` command line
- [Security report, §5 Low severity](../2-26-10-27-security.md#5-low-severity) (L2)
- [Security report, §6 Informational](../2-26-10-27-security.md#6-informational) (I7)
- [Todo 4030](../../todo/cross-cutting/4030-secret-redaction-quadratic-rules.md)
