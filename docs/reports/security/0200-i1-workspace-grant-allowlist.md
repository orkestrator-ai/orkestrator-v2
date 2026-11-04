# Make workspace grants match what they are documented to allow

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Close the gap between the grant's guarantee and its deny-list**: a grant still reaches host terminals, global config and host updates. Status: open.

### 1. Close the gap between the grant's guarantee and its deny-list

**Problem.** The code says that a grant is "never valid for administration" (`apps/backend/src/core/nodes/client-grants.ts:15`), but only named commands are refused, and some administration is not named.

**Context.** A grant exists so a client can open a leaf workspace, "agent chat, terminals, previews", without the leaf's token (`apps/backend/src/core/nodes/client-grants.ts:5-9`). So terminals are part of its stated purpose, while global config and host updates are not. Grants last at most 15 minutes and are bound to the controller.

**Investigation.** A grant on `/__orkestrator/invoke` is checked only with `isWorkspaceExcludedCommand` (`apps/backend/src/gateway-auth.ts:476-477`, `apps/backend/src/core/nodes/node-routing.ts:135`). The relay uses the same check (`apps/backend/src/core/nodes/node-relay.ts:144`). None of `start_local_terminal_session` (`apps/backend/src/core/commands-registry-terminal.ts:742`), `local_terminal_write` (`:812`), `update_global_config` (`apps/backend/src/core/commands-registry-projects.ts:1030`) or `request_host_update` (`apps/backend/src/core/commands-registry-host.ts:38`) is on either list in `node-routing.ts`.

**Decisions.**

- **Allowlist or deny-list?**
  - **Add the plain administration commands to the deny-list and correct the comment to say what a grant can do, terminals included (recommended).**
    - Pros: small; states the real boundary; keeps today's workspace working.
    - Cons: still fails open for a new administration command that nobody adds.
  - **Switch to an allowlist of workspace commands.**
    - Pros: fails closed, which is the report's first option.
    - Cons: a workspace uses a large share of the registry, so missing entries show up as broken features; another list to keep in step with every command.

## Open questions

- Which other registered commands count as administration? The report names four. A pass over the registry is part of this task, whichever option is taken.

## Related

- [Security report, §6 Informational](../2-26-10-27-security.md#6-informational) (I1)
- `docs/architecture/federation.md`
