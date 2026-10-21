import type { MachinePanelSpec } from "@/stores/machineViewStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { openLeafWorkspace, storeWorkspaceForFrame } from "@/lib/portal/workspaces";
import { browserPanelUrl } from "./panel-realm";
import { MOBILE_SHELL_MEDIA_QUERY } from "@/lib/mobile-shell";
import { toast } from "sonner";

/** Every portal entry point opens the owner workspace, including narrow clients. */
export function openMachineWorkspace(spec: Omit<MachinePanelSpec, "id">): void {
  if (
    !window.orkestratorGateway?.desktop &&
    window.matchMedia?.(MOBILE_SHELL_MEDIA_QUERY).matches
  ) {
    const tab = window.open("about:blank", "_blank");
    void openLeafWorkspace(spec.connectionId as never)
      .then((workspace) => {
        storeWorkspaceForFrame(workspace, tab ?? window);
        const url = browserPanelUrl({
          ...spec,
          workspaceId: workspace.workspaceId,
          nodeId: workspace.nodeId,
          connection: workspace,
        });
        if (tab) tab.location.href = url;
        else window.location.href = url;
      })
      .catch((error: unknown) => {
        tab?.close();
        toast.error("Could not open the node workspace", {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    return;
  }
  useMachineViewStore.getState().openPanel(spec);
}
