/**
 * Reaching one machine by node id (plan item 5004, report §9 "Agent accounts
 * / MCP per machine"): a node the window holds a warm or live scope for is
 * called on that scope's own client; any other node (summary tier, or
 * suspended) is asked through the command scope with `invoke_on_node`
 * (`PortalStore.invokeOnNode`).
 *
 * The tier is the scope's (`NodeScope.tier`). Until the lifecycle manager
 * (plan item 4002) moves scopes between tiers, every open scope is `live`,
 * so "warm or live" is "the window has an open scope for it".
 *
 * Only a command a workspace grant admits goes to the scope. A leaf scope
 * holds a workspace grant, which runs `access: "workspace"` commands only and
 * refuses the rest (plan item 7012), while `invoke_on_node` runs with the
 * command node's authority. So an `admin` command (a host update, a profile
 * write, diagnostics) and any command this build has no definition for keep
 * the command-scope route, whatever the tier.
 */

import { ACCOUNTS_COMMANDS } from "@orkestrator/protocol/contract/domains/accounts";
import { AGENT_SERVERS_COMMANDS } from "@orkestrator/protocol/contract/domains/agent-servers";
import { CONFIG_COMMANDS } from "@orkestrator/protocol/contract/domains/config";
import { DOCKER_COMMANDS } from "@orkestrator/protocol/contract/domains/docker";
import { ENVIRONMENTS_COMMANDS } from "@orkestrator/protocol/contract/domains/environments";
import { GRAPHS_COMMANDS } from "@orkestrator/protocol/contract/domains/graphs";
import { KANBAN_COMMANDS } from "@orkestrator/protocol/contract/domains/kanban";
import { MCP_COMMANDS } from "@orkestrator/protocol/contract/domains/mcp";
import { NODES_COMMANDS } from "@orkestrator/protocol/contract/domains/nodes";
import { PREVIEWS_COMMANDS } from "@orkestrator/protocol/contract/domains/previews";
import { PROJECTS_COMMANDS } from "@orkestrator/protocol/contract/domains/projects";
import { SYSTEM_COMMANDS } from "@orkestrator/protocol/contract/domains/system";
import { WEB_ANNOTATIONS_COMMANDS } from "@orkestrator/protocol/contract/domains/web-annotations";
import { isNodeReadCommand } from "@orkestrator/protocol/command-nodes";
import type { BackendId } from "@orkestrator/protocol/federation";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import type { WindowScope } from "@/lib/node-scope/window-scope";
import { scopeInvoker } from "@/lib/node-scope-slots";
import { portalStore } from "./portal-store";

/**
 * The domains the machine-aware `lib/backend` functions (`machineInvoker`,
 * `machineBackendClient`) and Settings' machine calls (`machine-access.ts`:
 * profile and host maintenance) reach. `kanban` is here for the Linear
 * connect dialog, which sends the key to each machine on its own scope when
 * the window holds one, so it does not pass through the command node.
 */
const MACHINE_DOMAIN_COMMANDS: ReadonlyArray<
  ReadonlyArray<{ readonly name: string; readonly access: string }>
> = [
  ACCOUNTS_COMMANDS,
  AGENT_SERVERS_COMMANDS,
  CONFIG_COMMANDS,
  DOCKER_COMMANDS,
  ENVIRONMENTS_COMMANDS,
  GRAPHS_COMMANDS,
  KANBAN_COMMANDS,
  MCP_COMMANDS,
  NODES_COMMANDS,
  PREVIEWS_COMMANDS,
  PROJECTS_COMMANDS,
  SYSTEM_COMMANDS,
  WEB_ANNOTATIONS_COMMANDS,
];

let workspaceCommands: ReadonlySet<string> | null = null;

/** Whether a workspace grant admits `command` (its definition says `access: "workspace"`). */
export function isWorkspaceGrantCommand(command: string): boolean {
  workspaceCommands ??= new Set(
    MACHINE_DOMAIN_COMMANDS.flat()
      .filter((definition) => definition.access === "workspace")
      .map((definition) => definition.name),
  );
  return workspaceCommands.has(command);
}

/**
 * `nodeId`'s scope in `windowScope` when it is open and warm or live, else
 * `null`.
 */
export function hydratedMachineScope(
  nodeId: BackendId,
  windowScope: WindowScope = getWindowScope(),
): NodeScope | null {
  const scope = windowScope.get(nodeId);
  if (!scope || scope.disposed) return null;
  const tier = scope.tier.get();
  return tier === "warm" || tier === "live" ? scope : null;
}

/**
 * Runs `command` on `nodeId`: on its scope when the window holds it warm or
 * live and a workspace grant admits the command, otherwise through the
 * command scope. The choice is made per call, so a node whose scope opens or
 * closes between calls follows. A write on a scope also refreshes the
 * portal's summaries, as a routed write does.
 */
export async function invokeOnMachine<T>(
  nodeId: BackendId,
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const scope = isWorkspaceGrantCommand(command) ? hydratedMachineScope(nodeId) : null;
  if (!scope) return portalStore.invokeOnNode<T>(nodeId, command, args);
  const result = await scopeInvoker(scope)<T>(command, args);
  if (!isNodeReadCommand(command)) portalStore.scheduleRefresh();
  return result;
}
