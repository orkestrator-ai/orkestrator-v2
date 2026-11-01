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
import { isUnknownBackendCommand } from "@/lib/backend/unknown-command";

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
  const patching = command === PATCH_GLOBAL_CONFIG;
  if (machine === null || machine === portalStore.getState().selfId) {
    return patching
      ? patchGlobalOnNode(portalInvoke, args?.patch, args?.unset, false)
      : portalInvoke<AppConfig>(command, args);
  }
  if (machine !== undefined) {
    const node = machine as BackendId;
    return splitConfigCommand(command, args, (nodeCommand, nodeArgs) =>
      portalStore.invokeOnNode(node, nodeCommand, nodeArgs ?? {}),
    );
  }
  if (!settingsOnCommandNode()) {
    return patching
      ? patchGlobalOnNode(workspaceInvoke, args?.patch, args?.unset, false)
      : workspaceInvoke<AppConfig>(command, args);
  }
  return splitConfigCommand(command, args, workspaceInvoke);
}

const PATCH_GLOBAL_CONFIG = "patch_global_config";

/**
 * Patch one node's global settings. A node on an older release has no patch
 * command; it gets the previous behaviour instead: read its config, apply the
 * patch, write the whole object back.
 */
async function patchGlobalOnNode(
  nodeInvoke: ConfigInvoke,
  patchValue: unknown,
  unsetValue: unknown,
  preserveInheritedSettings: boolean,
): Promise<AppConfig> {
  const patch = (patchValue ?? {}) as Partial<GlobalConfig>;
  const unset = Array.isArray(unsetValue) ? (unsetValue as string[]) : [];
  if (Object.keys(patch).length === 0 && unset.length === 0) {
    return nodeInvoke<AppConfig>("get_config");
  }
  try {
    return await nodeInvoke<AppConfig>(PATCH_GLOBAL_CONFIG, {
      patch,
      ...(unset.length > 0 ? { unset } : {}),
    });
  } catch (error) {
    if (!isUnknownBackendCommand(error, PATCH_GLOBAL_CONFIG)) throw error;
    const current = await nodeInvoke<AppConfig>("get_config");
    const global = { ...current.global, ...patch } as Record<string, unknown>;
    for (const key of unset) delete global[key];
    return nodeInvoke<AppConfig>("update_global_config", {
      global,
      ...(preserveInheritedSettings ? { preserveInheritedSettings: true } : {}),
    });
  }
}

/**
 * Route a patch: inherited preferences go to the command node, everything
 * else to this workspace. Only the keys the user changed travel, so neither
 * node's other settings are rewritten from this window's copy.
 */
async function splitGlobalPatch(
  args: Record<string, unknown> | undefined,
  workspaceInvoke: ConfigInvoke,
): Promise<AppConfig> {
  const patch = { ...(args?.patch as Partial<GlobalConfig> | undefined) };
  const unset = Array.isArray(args?.unset) ? (args.unset as string[]) : [];
  const inherited = new Set<string>(INHERITED_GLOBAL_SETTING_KEYS);
  const commandPatch: Record<string, unknown> = {};
  const workspacePatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    (inherited.has(key) ? commandPatch : workspacePatch)[key] = value;
  }
  if (patch.agentSettings) {
    // The form shows the default agent coerced to one enabled on this
    // workspace. Echoing that coerced value must not move the command node's.
    const [commandNode, workspace] = await Promise.all([
      portalInvoke<AppConfig>("get_config"),
      workspaceInvoke<AppConfig>("get_config"),
    ]);
    const effective = workspaceConfig(workspace, commandNode).global;
    if (patch.agentSettings.defaultAgent === effective.agentSettings?.defaultAgent) {
      commandPatch.agentSettings = {
        ...patch.agentSettings,
        defaultAgent: commandNode.global.agentSettings?.defaultAgent,
      };
    }
  }
  const savedCommand = await patchGlobalOnNode(
    portalInvoke,
    commandPatch,
    unset.filter((key) => inherited.has(key)),
    false,
  );
  const savedWorkspace = await patchGlobalOnNode(
    workspaceInvoke,
    workspacePatch,
    unset.filter((key) => !inherited.has(key)),
    true,
  );
  return workspaceConfig(savedWorkspace, savedCommand);
}

async function splitConfigCommand(
  command: string,
  args: Record<string, unknown> | undefined,
  workspaceInvoke: ConfigInvoke,
): Promise<AppConfig> {
  if (command === PATCH_GLOBAL_CONFIG) return splitGlobalPatch(args, workspaceInvoke);
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
