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

## Outcome

Built 2026-11-05 on base commit `2882b30ee` (`main`). The re-check found the
finding still held: `processIsAlive` was still a bare `kill(pid, 0)` and
`descriptorTarget` checked nothing else before the token was read
(`packages/cli/src/client/targets.ts` at `2882b30ee`). The recommended option
was built; the unauthenticated installation-id route was not added.

| Task | Outcome | Evidence |
| --- | --- | --- |
| 1. Detect a reused pid | Done; the real-host macOS run is moved to [todo 6220](../../todo/cli-and-slash-commands/6220-descriptor-start-time-macos-live-run.md) | Code: `descriptorProcessRefusal` and `DESCRIPTOR_START_{BEFORE,AFTER}_TOLERANCE_MS` in `packages/cli/src/client/targets.ts`, called from `descriptorTarget` (saved connections and profiles) and from `awaitServiceConnection` (`packages/cli/src/client/service-connection.ts`) before any token is read; the start-time reader in `packages/cli/src/client/process-start.ts` (Linux `/proc/<pid>/stat` field 22 plus `btime`; macOS `/bin/ps -o lstart=` under `LC_ALL=C TZ=UTC0`). Tests: `packages/cli/tests/client-descriptor-process.test.ts` (both platform paths with fakes, a real child on this Linux host, the window edges, unreadable start time refused before the credential file is opened, and `connection add`, a saved connection and a profile each refusing a reused pid with zero gateway requests). Docs: `docs/architecture/public-cli.md`. |

Tolerance: the process may have started up to 30 seconds after `startedAt`
and up to one hour before it. The backend writes `startedAt` once it is
serving, so a genuine process predates it by its boot time; a reused pid can
only have started later, so the 30 seconds absorbs only the one-second
resolution of `btime` and `ps -o lstart` plus small clock corrections. An
unreadable start time, or a `startedAt` that is not a time, is refused. The
CLI package ships for Linux and macOS only (`"os"` in
`packages/cli/package.json`); on any other platform the start time is
unreadable, so a descriptor would be refused.
