/**
 * Moving the window's workspace between nodes.
 *
 * Opening an environment of another node makes the window that node's
 * client, exactly as if it had connected to it directly: the desktop
 * re-binds the window in the main process, a browser or iOS tab stores the
 * node's workspace grant for its gateway. Either way the renderer reloads
 * into the node, and the selection the user asked for is applied once
 * after the reload. The multi-node views stay on the command node through
 * the portal channel.
 */

import { portalInvoke, workspaceTarget } from "./portal-transport";
import { readStoredWorkspace, writeStoredWorkspace } from "./workspace-target-storage";
import { closeLeafWorkspace, keepWorkspaceAlive, openLeafWorkspace } from "./workspaces";

export interface WorkspaceSwitchIntent {
  projectId?: string;
  environmentId?: string;
  /** Open the Add Project dialog on the node. */
  addProject?: boolean;
}

const INTENT_KEY = "orkestrator.workspace-switch-intent";

function writeIntent(intent: WorkspaceSwitchIntent | null): void {
  try {
    if (intent) window.sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent));
    else window.sessionStorage.removeItem(INTENT_KEY);
  } catch {
    // The switch still happens; nothing is selected after it.
  }
}

function readIntent(): WorkspaceSwitchIntent | null {
  try {
    const text = window.sessionStorage.getItem(INTENT_KEY);
    if (!text) return null;
    const value = JSON.parse(text) as Record<string, unknown>;
    return {
      ...(typeof value.projectId === "string" ? { projectId: value.projectId } : {}),
      ...(typeof value.environmentId === "string" ? { environmentId: value.environmentId } : {}),
      ...(value.addProject === true ? { addProject: true } : {}),
    };
  } catch {
    return null;
  }
}

/** The selection asked for with the last switch, once. */
export function takeSwitchSelection(): { projectId: string; environmentId?: string } | null {
  const intent = readIntent();
  if (!intent?.projectId) return null;
  const { projectId, environmentId, ...rest } = intent;
  writeIntent(rest.addProject ? rest : null);
  return { projectId, ...(environmentId ? { environmentId } : {}) };
}

/** Whether the last switch asked to add a project on the node, once. */
export function takeAddProjectIntent(): boolean {
  const intent = readIntent();
  if (!intent?.addProject) return false;
  const { addProject: _addProject, ...rest } = intent;
  writeIntent(rest.projectId ? rest : null);
  return true;
}

/**
 * Point the window's workspace at a node (`null`: the command node) and
 * reload into it. Rejects, without reloading, when the node cannot be
 * reached.
 */
export async function switchWorkspace(
  nodeId: string | null,
  intent: WorkspaceSwitchIntent = {},
): Promise<void> {
  writeIntent(intent);
  try {
    const desktop = window.orkestrator?.workspaceTarget;
    if (desktop) {
      await desktop.set(nodeId);
    } else {
      const current = readStoredWorkspace();
      if (nodeId === null) {
        writeStoredWorkspace(null);
      } else {
        const profile = await portalInvoke<{ displayName?: string }>("get_backend_profile").catch(
          () => null,
        );
        const workspace = await openLeafWorkspace(nodeId as never, {
          commandNodeName: profile?.displayName ?? "",
        });
        writeStoredWorkspace(workspace);
      }
      // The previous node's grant is revoked; its work keeps running.
      if (current) await closeLeafWorkspace(current.workspaceId);
    }
  } catch (error) {
    writeIntent(null);
    throw error;
  }
  window.location.reload();
}

/**
 * Browser and iOS: keep the stored workspace's grant alive while this tab
 * works on it, and re-open it if it lapsed. The desktop renews in its main
 * process. Returns the stop function.
 */
export function keepStoredWorkspaceAlive(): () => void {
  if (window.orkestrator?.workspaceTarget) return () => undefined;
  const workspace = readStoredWorkspace();
  const target = workspaceTarget();
  if (!workspace || !target) return () => undefined;
  return keepWorkspaceAlive(workspace.workspaceId, () => {
    void switchWorkspace(target.nodeId).catch(() => undefined);
  });
}
