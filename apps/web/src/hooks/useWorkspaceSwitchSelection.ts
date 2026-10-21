import { useEffect, useRef, useState } from "react";
import { startsOnSelection } from "@/lib/environment-auto-start";
import { takeSwitchSelection } from "@/lib/portal/workspace-switch";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useUIStore } from "@/stores/uiStore";

/**
 * After the window moved to another node, selects what the user clicked on
 * as the sidebar would have: once the node's environments are loaded, and
 * starting a local environment that needs it.
 */
export function useWorkspaceSwitchSelection(startEnvironment: (id: string) => Promise<unknown>) {
  const [pending] = useState(takeSwitchSelection);
  const environments = useEnvironmentStore((state) => state.environments);
  const applied = useRef(false);

  useEffect(() => {
    if (!pending || applied.current) return;
    const ui = useUIStore.getState();
    if (!pending.environmentId) {
      applied.current = true;
      ui.selectProject(pending.projectId);
      return;
    }
    const environment = environments.find((candidate) => candidate.id === pending.environmentId);
    if (!environment) return;
    applied.current = true;
    // The row the user clicked was visible; keep it so here.
    ui.setProjectCollapsed(environment.projectId, false);
    ui.selectProjectAndEnvironment(environment.projectId, environment.id);
    if (startsOnSelection(environment)) {
      startEnvironment(environment.id).catch((error: unknown) => {
        console.error("[Workspace] Failed to start the opened environment:", error);
      });
    }
  }, [environments, pending, startEnvironment]);
}
