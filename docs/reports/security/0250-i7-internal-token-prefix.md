# Give internal tokens a recognisable prefix

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Prefix internal tokens and add a redaction rule**: redaction cannot recognise a bridge, gateway or MCP token by its shape. Status: open.

### 1. Prefix internal tokens and add a redaction rule

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

## Current state

Done, so not in Tasks: `boundDiagnosticTail` runs each line through `redactBridgeLogLine`, so every container log tail is scrubbed (`apps/backend/src/core/container-log-bounds.ts:2`, `:29-31`; commit `20e2863e5`). [Todo 4030](../../todo/cross-cutting/4030-secret-redaction-quadratic-rules.md), which made those rules linear, is done.

## Constraints and rationale

- A token that `tail -c` cut through has lost its prefix, so a prefix does not catch it (the report's note).

## Related

- [Security report, §6 Informational](../2-26-10-27-security.md#6-informational) (I7)
- [Todo 4030](../../todo/cross-cutting/4030-secret-redaction-quadratic-rules.md)
