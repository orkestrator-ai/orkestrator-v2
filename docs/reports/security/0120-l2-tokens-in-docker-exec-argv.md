# Take bridge and agent-tools tokens off the `docker exec` command line

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Pass the tokens on stdin**: they are in the argv of `docker exec` while the CLI runs. Status: open.

### 1. Pass the tokens on stdin

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

## Constraints and rationale

- Do this with, or after, the design choice in [0040](0040-h4-bridge-credential-remainder.md). If the bridge credential moves to an inherited descriptor or a separate uid, how the token reaches the bridge changes again.

## Needs verification

- Whether Docker Desktop exposes the `docker` client's argv to other local users in the same way as a Linux host. The report's scenario is a local co-tenant.

## Related

- [Security report, §5 Low severity](../2-26-10-27-security.md#5-low-severity) (L2)
- [0040](0040-h4-bridge-credential-remainder.md)
