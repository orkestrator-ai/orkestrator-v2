/**
 * Settings belong to the command node the client is connected to.
 *
 * While the window's workspace is on another node, the application settings
 * (the global config: defaults, platforms, review, terminal, keys, sounds,
 * messaging) are still read from and written to the command node, over the
 * portal channel. The command node hands the inherited ones down to that
 * node, so its own launches use them too (`@orkestrator/protocol/controller-settings`).
 * Per-project repository settings stay with the node that owns the project.
 *
 * So the config a leaf window holds is the leaf's repositories with the
 * command node's global settings.
 */

import { invoke } from "@/lib/native/backend";
import type { AppConfig } from "@/types";
import { portalInvoke, workspaceTarget } from "./portal-transport";

/** The workspace transport, called exactly as a direct `invoke` would be. */
function workspaceInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
}

/** The window's workspace is on another node, so settings go to the command node. */
export function settingsOnCommandNode(): boolean {
  return workspaceTarget() !== null;
}

/** A global-settings command: on the command node, with this window's repositories. */
export async function invokeGlobalConfigCommand(
  command: string,
  args?: Record<string, unknown>,
): Promise<AppConfig> {
  if (!settingsOnCommandNode()) return workspaceInvoke<AppConfig>(command, args);
  const [commandNode, workspace] = await Promise.all([
    portalInvoke<AppConfig>(command, args),
    workspaceInvoke<AppConfig>("get_config"),
  ]);
  return { ...workspace, global: commandNode.global };
}

/** A repository-settings command: on the project's node, with the command node's global settings. */
export async function invokeRepositoryConfigCommand(
  command: string,
  args?: Record<string, unknown>,
): Promise<AppConfig> {
  if (!settingsOnCommandNode()) return workspaceInvoke<AppConfig>(command, args);
  const [workspace, commandNode] = await Promise.all([
    workspaceInvoke<AppConfig>(command, args),
    portalInvoke<AppConfig>("get_config"),
  ]);
  return { ...workspace, global: commandNode.global };
}

/** A settings command that returns no config: on the command node. */
export function invokeCommandNodeSetting<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return settingsOnCommandNode()
    ? portalInvoke<T>(command, args)
    : workspaceInvoke<T>(command, args);
}
