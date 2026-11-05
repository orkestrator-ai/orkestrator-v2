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

## Outcome

Checked back on 2026-11-05 against `main` at `e1f4c875` (base of this work), implemented in commit `13d153e02`.

| Item in this file | Outcome | Where |
| --- | --- | --- |
| Task 1: close the gap between the grant's guarantee and its deny-list | Done. Re-check: every finding still held at `e1f4c875` (`gateway-auth.ts` passes `refuseCommand: isWorkspaceExcludedCommand` at `:503-504`, the relay checks the same list at `node-relay.ts:144`, and none of the four named commands was on either list). The recommended option was taken: grants and the relay now also refuse `WORKSPACE_ADMINISTRATION_COMMANDS`, and the comment says what a grant can do, terminals included | `apps/backend/src/core/nodes/workspace-grant-scope.ts`, `isWorkspaceExcludedCommand` (`node-routing.ts`), the comment in `client-grants.ts`; tests in `apps/backend/tests/gateway-workspace-grant-scope.test.ts` (gateway and relay paths) and `apps/backend/src/core/nodes/workspace-grant-scope.test.ts` |
| Investigation: `update_global_config` reachable through a grant | Done: refused through a grant and the relay. A write that changes nothing is answered with the current settings, because realms through v2.35.1-beta send one when they save a model favourite; counted as `workspace-grant.config-echo` and registered in `version-compatibility.md` | `isGlobalConfigEcho` (`workspace-grant-scope.ts`), `GatewayHandlers.handleInvoke` (`gateway-handlers.ts`), `answerConfigEcho` (`node-relay.ts`); same tests |
| Investigation: `request_host_update` reachable through a grant | Done: refused with every host update and dependency command (`request_host_update_check`, `cancel_host_update`, `start_host_toolchain_repair`, `start_host_image_update`, `set_host_update_channel`, `set_host_gh_channel`) | `WORKSPACE_ADMINISTRATION_COMMANDS`; same tests |
| Investigation: `start_local_terminal_session` and `local_terminal_write` reachable through a grant | No change needed: terminals are within a grant's stated purpose and stay allowed, now asserted | `a workspace keeps its terminals…` in `workspace-grant-scope.test.ts`; `still runs terminals` and `still relays terminals` in `gateway-workspace-grant-scope.test.ts` |
| Decision: allowlist or deny-list | Done: deny-list (recommended), with the fail-open cost stated in the module comment and `command-nodes.md` | `workspace-grant-scope.ts`, `docs/architecture/command-nodes.md` |
| Open question: which other registered commands count as administration | Done: a pass over the registry and the renderer's callers added `save_config`, `patch_global_config`, `update_notification_sound_settings`, the four credential setters, `update_backend_profile`, `update_worktree_locations`, `update_preview_settings`, `cleanup_logs` and `graph_capability_ceiling_set`; all are called only from Settings or window-only UI. Agent sign-in, accounts, repository settings and permission rules stay open: a realm's agent popover and dialogs use them | `WORKSPACE_ADMINISTRATION_COMMANDS`; the test that every entry is registered and still node-routable |
| Live evidence on two machines, and with an older realm | Moved to a to-do | [5740](../../todo/cross-cutting/5740-workspace-grant-scope-live-evidence.md) |
