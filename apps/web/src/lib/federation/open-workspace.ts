import { toast } from "sonner";
import { portalStore } from "@/lib/portal/portal-store";
import { workspaceTarget } from "@/lib/portal/portal-transport";
import { switchWorkspace } from "@/lib/portal/workspace-switch";
import { useUIStore } from "@/stores/uiStore";

export interface MachineWorkspaceSpec {
  /** The node, by identity. */
  connectionId: string;
  /** Empty: the node's project launcher (to add a project there). */
  projectId: string;
  environmentId?: string;
  /** For messages while it opens. */
  title: string;
}

/**
 * Every portal entry point opens a node's environment the same way: on the
 * node the window already works on it is an ordinary selection; on another
 * node the window moves there and behaves exactly as if it had connected to
 * that node directly.
 */
export function openMachineWorkspace(spec: MachineWorkspaceSpec): void {
  const selfId = portalStore.getState().selfId;
  const boundId = workspaceTarget()?.nodeId ?? selfId;
  if (spec.connectionId === boundId) {
    const ui = useUIStore.getState();
    if (!spec.projectId) return;
    if (spec.environmentId) ui.selectProjectAndEnvironment(spec.projectId, spec.environmentId);
    else ui.selectProject(spec.projectId);
    return;
  }
  const intent = spec.projectId
    ? {
        projectId: spec.projectId,
        ...(spec.environmentId ? { environmentId: spec.environmentId } : {}),
      }
    : { addProject: true };
  void switchWorkspace(spec.connectionId === selfId ? null : spec.connectionId, intent).catch(
    (error: unknown) => {
      toast.error(`Could not open ${spec.title}`, {
        description: error instanceof Error ? error.message : String(error),
      });
    },
  );
}
