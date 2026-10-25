/** Workspace config keeps machine settings local; only preferences come from the command node. */
import {
  INHERITED_GLOBAL_SETTING_KEYS,
  pickInheritedGlobalSettings,
} from "@orkestrator/protocol/controller-settings";
import {
  firstEnabledAgentPlatform,
  normalizeAgentPlatforms,
} from "@orkestrator/protocol/agent-platforms";
import { normalizeAgentSettings } from "@orkestrator/protocol/agent-settings";
import { deepEqualJson } from "@/lib/chat/message-identity";
import type { BackendId } from "@orkestrator/protocol/federation";
import { invoke } from "@/lib/native/backend";
import type { AppConfig, GlobalConfig } from "@/types";
import { portalStore } from "./portal-store";
import { portalInvoke, workspaceTarget } from "./portal-transport";

type ConfigInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function workspaceInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
}

export function settingsOnCommandNode(): boolean {
  return workspaceTarget() !== null;
}

function workspaceConfig(workspace: AppConfig, commandNode: AppConfig): AppConfig {
  const global = { ...workspace.global };
  for (const key of INHERITED_GLOBAL_SETTING_KEYS) delete global[key];
  Object.assign(global, pickInheritedGlobalSettings(commandNode.global));
  const agentSettings = normalizeAgentSettings(global.agentSettings);
  const enabled = normalizeAgentPlatforms(global.enabledAgentPlatforms, []);
  global.agentSettings = {
    ...agentSettings,
    defaultAgent:
      enabled.length > 0
        ? firstEnabledAgentPlatform(enabled, agentSettings.defaultAgent)
        : agentSettings.defaultAgent,
  };
  return { ...workspace, global };
}

/**
 * Read the effective workspace view, or save each setting on its owning node.
 *
 * `machine` names the node whose machine settings are shown, as Settings
 * does for the machine picked in its header: `null` is the command node
 * itself, a node ID another machine reached through it, and `undefined` this
 * view's own backend.
 */
export async function invokeGlobalConfigCommand(
  command: string,
  args?: Record<string, unknown>,
  machine?: string | null,
): Promise<AppConfig> {
  if (machine === null || machine === portalStore.getState().selfId) {
    return portalInvoke<AppConfig>(command, args);
  }
  if (machine !== undefined) {
    const node = machine as BackendId;
    return splitConfigCommand(command, args, (nodeCommand, nodeArgs) =>
      portalStore.invokeOnNode(node, nodeCommand, nodeArgs ?? {}),
    );
  }
  if (!settingsOnCommandNode()) return workspaceInvoke<AppConfig>(command, args);
  return splitConfigCommand(command, args, workspaceInvoke);
}

async function splitConfigCommand(
  command: string,
  args: Record<string, unknown> | undefined,
  workspaceInvoke: ConfigInvoke,
): Promise<AppConfig> {
  if (command === "update_global_config") {
    // Read before writing: a failed paired read must not leave a partial save.
    const [commandNode, workspace] = await Promise.all([
      portalInvoke<AppConfig>("get_config"),
      workspaceInvoke<AppConfig>("get_config"),
    ]);
    const incoming = args?.global as GlobalConfig;
    const effective = workspaceConfig(workspace, commandNode).global;
    const commandGlobal = { ...commandNode.global };
    const workspaceGlobal = { ...incoming };
    for (const key of INHERITED_GLOBAL_SETTING_KEYS) {
      // Preserve command defaults when the form echoes a leaf-coerced value.
      if (!deepEqualJson(incoming[key], effective[key])) {
        delete commandGlobal[key];
        if (incoming[key] !== undefined) Object.assign(commandGlobal, { [key]: incoming[key] });
        if (
          key === "agentSettings" &&
          incoming.agentSettings?.defaultAgent === effective.agentSettings?.defaultAgent
        ) {
          commandGlobal.agentSettings = {
            ...incoming.agentSettings,
            defaultAgent: commandNode.global.agentSettings?.defaultAgent,
          };
        }
      }
      delete workspaceGlobal[key];
    }
    const savedCommand = await portalInvoke<AppConfig>(command, { global: commandGlobal });
    const savedWorkspace = await workspaceInvoke<AppConfig>(command, {
      global: workspaceGlobal,
      preserveInheritedSettings: true,
    });
    return workspaceConfig(savedWorkspace, savedCommand);
  }
  const [commandNode, workspace] = await Promise.all([
    portalInvoke<AppConfig>("get_config"),
    workspaceInvoke<AppConfig>(command, args),
  ]);
  return workspaceConfig(workspace, commandNode);
}

export async function invokeRepositoryConfigCommand(
  command: string,
  args?: Record<string, unknown>,
): Promise<AppConfig> {
  return invokeGlobalConfigCommand(command, args);
}

/** Commands dedicated to inherited preferences target the command node. */
export function invokeCommandNodeSetting<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return settingsOnCommandNode()
    ? portalInvoke<T>(command, args)
    : workspaceInvoke<T>(command, args);
}
