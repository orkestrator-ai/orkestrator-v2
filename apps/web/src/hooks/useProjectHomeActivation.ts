import { useEffect, useLayoutEffect } from "react";
import { toast } from "sonner";
import { useEnvironmentStore, useProjectStore, useUIStore } from "@/stores";
import { ensureProjectHomeInStore } from "@/hooks/useFilesPanel";
import { findProjectHomeEnvironment } from "@/lib/project-home";

/**
 * A project's page runs on its project home, the environment that works
 * directly in the project's checkout. Selecting a project with a checkout
 * activates that home, so the toolbar's environment actions target the
 * checkout while the board tabs stay on screen.
 */
export function useProjectHomeActivation(): void {
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const checkoutPath = useProjectStore(
    (state) =>
      (selectedProjectId
        ? state.projects.find((project) => project.id === selectedProjectId)?.localPath?.trim()
        : null) || null,
  );
  const selectedHomeId = useEnvironmentStore((state) => {
    if (!selectedEnvironmentId) return null;
    const environment = state.environments.find(
      (candidate) => candidate.id === selectedEnvironmentId,
    );
    return environment?.projectHome === true ? environment.id : null;
  });

  // A layout effect, so a known home replaces the bare board before paint and
  // the environment controls do not flash out and back in.
  useLayoutEffect(() => {
    if (!selectedProjectId || selectedEnvironmentId) return;
    if (!checkoutPath) {
      // Without a checkout there is no home to show.
      const ui = useUIStore.getState();
      if (ui.projectBoardTab === "home") ui.setProjectBoardTab("coordinator");
      return;
    }
    const known = findProjectHomeEnvironment(
      useEnvironmentStore.getState().environments,
      selectedProjectId,
    );
    if (known) {
      useUIStore.getState().selectEnvironment(known.id);
      return;
    }
    let cancelled = false;
    void ensureProjectHomeInStore(selectedProjectId)
      .then((home) => {
        const ui = useUIStore.getState();
        if (cancelled || ui.selectedProjectId !== selectedProjectId || ui.selectedEnvironmentId) {
          return;
        }
        ui.selectEnvironment(home.id);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toast.error("Could not open the project home", {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId, selectedEnvironmentId, checkoutPath]);

  // The checkout can change branch or path outside Orkestrator. Withhold the
  // previous branch's PR controls while the backend reconciles the home.
  useEffect(() => {
    if (!selectedHomeId) return;
    const store = useEnvironmentStore.getState();
    const home = store.environments.find((environment) => environment.id === selectedHomeId);
    if (!home) return;
    store.updateEnvironment(home.id, { prUrl: null, prState: null, hasMergeConflicts: null });
    void ensureProjectHomeInStore(home.projectId).catch(() => undefined);
  }, [selectedHomeId]);
}
