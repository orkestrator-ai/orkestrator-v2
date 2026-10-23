import { portalStore } from "@/lib/portal/portal-store";
import { isWorkspaceRealm, postToShell } from "@/lib/federation/workspace-realm";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
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
 * Every portal entry point opens a node's environment the same way. The
 * window always stays on its command node: one of its own environments is an
 * ordinary selection, and another node's is shown in the central region by
 * that node's workspace realm, without reloading anything around it.
 *
 * Creating an environment on another node goes through that node's own New
 * Environment dialog, so its defaults (the command node's inherited settings
 * laid over the node's own) and start apply as they would there.
 */
export function openMachineWorkspace(spec: MachineWorkspaceSpec): void {
  // A realm is one node's workspace; the window decides what it shows.
  if (isWorkspaceRealm()) {
    if (spec.projectId)
      postToShell({
        type: "open",
        nodeId: spec.connectionId,
        projectId: spec.projectId,
        ...(spec.environmentId ? { environmentId: spec.environmentId } : {}),
        title: spec.title,
      });
    return;
  }
  const selfId = portalStore.getState().selfId;
  if (!selfId || spec.connectionId === selfId) {
    useRemoteWorkspaceStore.getState().showLocal();
    const ui = useUIStore.getState();
    if (!spec.projectId) return;
    if (spec.createEnvironment) requestCreateEnvironment(spec.projectId);
    else if (spec.environmentId) ui.selectProjectAndEnvironment(spec.projectId, spec.environmentId);
    else ui.selectProject(spec.projectId);
    return;
  }
  useRemoteWorkspaceStore.getState().open(
    spec.connectionId,
    !spec.projectId
      ? { addProject: true }
      : spec.createEnvironment
        ? { projectId: spec.projectId, createEnvironmentProjectId: spec.projectId }
        : {
            projectId: spec.projectId,
            ...(spec.environmentId ? { environmentId: spec.environmentId } : {}),
          },
  );
}
