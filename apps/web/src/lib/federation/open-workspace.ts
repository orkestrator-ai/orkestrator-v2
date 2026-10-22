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
  /** Open the New Environment dialog for `projectId` instead of selecting it. */
  createEnvironment?: boolean;
  /** For messages while it opens. */
  title: string;
}

const CREATE_ENVIRONMENT_REQUEST_EVENT = "orkestrator:create-environment";

/** Asks this window's sidebar to open the New Environment dialog for a project. */
function requestCreateEnvironment(projectId: string): void {
  window.dispatchEvent(
    new CustomEvent<string>(CREATE_ENVIRONMENT_REQUEST_EVENT, { detail: projectId }),
  );
}

export function onCreateEnvironmentRequest(listener: (projectId: string) => void): () => void {
  const handle = (event: Event) => {
    const projectId = (event as CustomEvent<unknown>).detail;
    if (typeof projectId === "string" && projectId) listener(projectId);
  };
  window.addEventListener(CREATE_ENVIRONMENT_REQUEST_EVENT, handle);
  return () => window.removeEventListener(CREATE_ENVIRONMENT_REQUEST_EVENT, handle);
}

/**
 * Every portal entry point opens a node's environment the same way: on the
 * node the window already works on it is an ordinary selection; on another
 * node the window moves there and behaves exactly as if it had connected to
 * that node directly.
 *
 * Creating an environment always goes through the node's own New Environment
 * dialog, so its defaults, agent settings and start apply as they would from
 * the node's own sidebar.
 */
export function openMachineWorkspace(spec: MachineWorkspaceSpec): void {
  const selfId = portalStore.getState().selfId;
  const boundId = workspaceTarget()?.nodeId ?? selfId;
  if (spec.connectionId === boundId) {
    const ui = useUIStore.getState();
    if (!spec.projectId) return;
    if (spec.createEnvironment) requestCreateEnvironment(spec.projectId);
    else if (spec.environmentId) ui.selectProjectAndEnvironment(spec.projectId, spec.environmentId);
    else ui.selectProject(spec.projectId);
    return;
  }
  const intent = !spec.projectId
    ? { addProject: true }
    : spec.createEnvironment
      ? { createEnvironmentProjectId: spec.projectId }
      : {
          projectId: spec.projectId,
          ...(spec.environmentId ? { environmentId: spec.environmentId } : {}),
        };
  void switchWorkspace(spec.connectionId === selfId ? null : spec.connectionId, intent).catch(
    (error: unknown) => {
      toast.error(`Could not open ${spec.title}`, {
        description: error instanceof Error ? error.message : String(error),
      });
    },
  );
}
