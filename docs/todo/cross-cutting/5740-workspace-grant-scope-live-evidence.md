# Workspace grant scope: live evidence on two machines

## Task analysis

Analysed 2026-11-05 against `main` at `e1f4c875`.

### Tasks

1. **Two-node realm check**: a realm opened through a real client grant, and one through the relay, runs terminals and agent chat but is refused global settings and host updates. Status: open.
2. **Older realm favourite check**: a realm served by a command node on v2.35.1-beta or earlier can still favourite a model on an upgraded leaf. Status: open.

### 1. Two-node realm check

**Problem.** Security report 0200 (I1) was built and tested against a real gateway with a fake backend and a fake leaf. It has not run between two real backends. So it is still unproven that a workspace a user opens on another machine keeps every feature it had, and that a grant is refused administration end to end.

**Context.** Since 2026-11-05 a client grant (`apps/backend/src/gateway-auth.ts`, `refuseCommand: isWorkspaceExcludedCommand`) and the relay (`relayHttp`, `apps/backend/src/core/nodes/node-relay.ts`) also refuse `WORKSPACE_ADMINISTRATION_COMMANDS` (`apps/backend/src/core/nodes/workspace-grant-scope.ts`): global settings writes, machine credentials, the machine's profile, storage, preview and log settings, the graph capability ceiling, and host updates. Terminals, agent chat, previews, files, repository settings, agent sign-in and the project boards stay open. Settings reaches another machine through `invoke_on_node`, which these lists do not affect. Covered by `apps/backend/tests/gateway-workspace-grant-scope.test.ts` and `apps/backend/src/core/nodes/workspace-grant-scope.test.ts`.

The list was made from a pass over the registry plus the renderer's callers. A realm command that only some flow sends through the grant, and that is now refused, would show up as a broken feature on another machine. It would not show up on one machine.

**Investigation.** Not run here: the ticket that built it forbade billed provider turns, and a two-node setup needs two isolated profiles with one attached to the other. The renderer's own callers of each refused command were read (`apps/web/src/components/settings/**`, `HostUpdateBanner.tsx`, which a realm does not mount). Every one is in Settings or in window-only UI.

**Decisions.**

- **How to qualify?**
  - **Two `dev:test` profiles, one attached to the other, driven with Playwright through the browser realm and with relay forced (recommended).** Open a leaf environment from the command node's window, run a terminal command, open the agent tab without sending a turn, open the realm's agent and usage popovers, the repository settings dialog and the project boards. Then confirm in the leaf's log that no invoke was refused (`This credential cannot run that command.` is the 403 body). Separately, POST `update_global_config` with a change and `request_host_update` with the grant and through the relay, and expect 403.
    - Pros: exercises the real realm code path, both transports, and finds any refused command a realm actually sends.
    - Cons: needs two profiles and the attach flow; a provider turn must stay out of it unless one is authorised.
  - **Count refusals in production logs instead.**
    - Pros: no setup.
    - Cons: needs real multi-machine use first, and a refused feature is found by a user rather than by a check.

### 2. Older realm favourite check

**Problem.** Realms of command nodes on v2.35.1-beta and earlier save a model favourite by sending the leaf its own settings back with `update_global_config` and `preserveInheritedSettings`. An upgraded leaf now answers that unchanged echo with its current settings instead of refusing it (`isGlobalConfigEcho`, counted as `workspace-grant.config-echo`). The request shape was read from the v2.35.1-beta sources (`useAgentModelFavorites.ts`, `command-node-config.ts`) and replayed in the gateway test, not taken from a running older realm.

**Context.** The compatibility path and its retirement condition are in the register of [version-compatibility.md](../../architecture/version-compatibility.md#register). If the older realm's copy of the leaf's settings is stale, the echo is not a no-op and the leaf refuses it, so the favourite save fails with "Could not save model favorites". That is deliberate: the older realm would otherwise write stale machine settings back to the leaf.

**Investigation.** Not run: it needs a command node on an older release.

**Decisions.**

- **How to check?**
  - **Run a v2.35.1-beta command node (an installed release or `service install --release` into a throwaway data directory) attached to a current leaf profile, favourite a model in the leaf's realm, and read `get_compatibility_path_usage` on the leaf (recommended).**
    - Pros: proves the exact older client, and the counter shows that the path ran.
    - Cons: an older release on an isolated profile takes setup; it must not touch the real data directory or ports 34121 and 34122.
  - **Rely on the replayed request in the gateway test.**
    - Pros: already done.
    - Cons: a renderer default the sources do not show (an extra key in the store's copy) would make the live echo differ and be refused.

## Related

- [Security review: outstanding work](../../reports/security/0000-index.md) (I1)
- [command-nodes.md](../../architecture/command-nodes.md)
- [version-compatibility.md](../../architecture/version-compatibility.md#register)
