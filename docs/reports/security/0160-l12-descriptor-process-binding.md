# Tie the CLI's instance descriptor to the backend process that wrote it

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Detect a reused pid**: a stale descriptor whose pid now belongs to another process of the same user still counts as live. Status: open.

### 1. Detect a reused pid

**Problem.** If a backend dies and its pid is reused by another process of the same user, the descriptor still looks live. If a co-tenant has also taken its port, the CLI sends the bearer token to them.

**Context.** The narrow window needs all of: a crashed backend, pid reuse by this user, and another user listening on the old port. A process of the same user is no threat itself, since it could read the auth file directly.

**Investigation.** `processIsAlive` is a plain `kill(pid, 0)` (`packages/cli/src/client/targets.ts:215-222`). `descriptorTarget` then checks only that and the installation id from the descriptor itself (`:231-243`), which says nothing about who holds the port. The descriptor has a `startedAt` (`apps/backend/src/instance-descriptor.test.ts:30-31`).

**Decisions.**

- **How to bind it?**
  - **Compare the process's start time with the descriptor's `startedAt` before reading the token (recommended).**
    - Pros: catches pid reuse locally; nothing about the token leaves the process.
    - Cons: start time comes from `/proc` on Linux and `ps` on macOS, with some clock tolerance needed, since `startedAt` is written after the process starts.
  - **A new unauthenticated route that returns the installation id, compared before the token is sent.**
    - Pros: tests the listener itself, which is the actual risk; works cross-platform.
    - Cons: the existing hello sits behind the credential check (`apps/backend/src/gateway-auth.ts:382`, `:461`), so this is new surface; the id is not a secret, so a co-tenant who learned it could replay it.

## Current state

Done, so not in Tasks (commit `b88623136`): `readDescriptor` opens with `O_NOFOLLOW` and refuses a file owned by another user or with any group or other bits (`packages/cli/src/client/targets.ts:130-146`, `:164-197`); a refused profile descriptor no longer falls back to the manifest endpoint; `EPERM` no longer counts as alive.

## Related

- [Security report, §5 Low severity](../2-26-10-27-security.md#5-low-severity) (L12)
- `packages/cli/tests/client-descriptor-trust.test.ts`
