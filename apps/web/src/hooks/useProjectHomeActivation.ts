import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useEnvironmentStore, useProjectStore, useUIStore } from "@/stores";
import { ensureProjectHomeInStore, isProjectHomeDeletionInProgress } from "@/hooks/useFilesPanel";
import { findProjectHomeEnvironment } from "@/lib/project-home";

/** Keep toolbar targeting on Home while board panels can obscure its panes. */
export function useProjectHomeActivation() {
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const selectionRevision = useUIStore((state) => state.projectSelectionRevision);
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const projectPending = useProjectStore(
    (state) =>
      !state.hasLoaded && !state.projects.some((project) => project.id === selectedProjectId),
  );
  const checkoutPath = useProjectStore(
    (state) =>
      state.projects.find((project) => project.id === selectedProjectId)?.localPath?.trim() || null,
  );
  const projectDeleting = useProjectStore((state) =>
    selectedProjectId ? state.deletingProjects.has(selectedProjectId) : false,
  );
  const homeDeleting = useEnvironmentStore((state) =>
    state.environments.some(
      (environment) =>
        environment.projectId === selectedProjectId &&
        environment.projectHome &&
        (state.deletingEnvironments.has(environment.id) ||
          environment.deletionRequestedAt ||
          environment.lifecycleOperation === "deleting"),
    ),
  );
  const selectedHomeId = useEnvironmentStore(
    (state) =>
      state.environments.find(
        (environment) => environment.id === selectedEnvironmentId && environment.projectHome,
      )?.id ?? null,
  );
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reconciled = useRef<string | null>(null);
  const suppressedSelection = useRef<string | null>(null);
  const retry = useCallback(() => {
    suppressedSelection.current = null;
    setAttempt((value) => value + 1);
  }, []);
  const selectionKey = `${selectedProjectId}\0${selectionRevision}`;
  const key = `${selectionKey}\0${checkoutPath}\0${attempt}`;

  useLayoutEffect(() => {
    if (!selectedProjectId) return;
    if (projectDeleting || homeDeleting) {
      suppressedSelection.current = selectionKey;
      setFailure({
        key,
        message: "Project home cleanup is in progress. Retry after cleanup finishes.",
      });
      return;
    }
    // Deletion can remove its final signal along with the record. Do not turn
    // that disappearance into a new ensure until the user navigates again.
    if (suppressedSelection.current === selectionKey) return;
    if (selectedEnvironmentId && !selectedHomeId) {
      reconciled.current = null;
      return;
    }
    if (!checkoutPath) {
      // A realm selects its requested project before the first snapshot arrives.
      // Only a known project (or a completed snapshot) can confirm no checkout.
      if (projectPending) return;
      const ui = useUIStore.getState();
      if (selectedHomeId) ui.selectEnvironment(null);
      if (ui.projectBoardTab === "home") ui.setProjectBoardTab("coordinator");
      reconciled.current = null;
      return;
    }
    const known = findProjectHomeEnvironment(
      useEnvironmentStore.getState().environments,
      selectedProjectId,
    );
    if (!selectedEnvironmentId && known) {
      reconciled.current = null;
      useUIStore.getState().selectEnvironment(known.id);
      return;
    }
    if (reconciled.current === key) return;
    let cancelled = false;
    void ensureProjectHomeInStore(selectedProjectId)
      .then((home) => {
        const ui = useUIStore.getState();
        if (
          cancelled ||
          ui.selectedProjectId !== selectedProjectId ||
          isProjectHomeDeletionInProgress(selectedProjectId)
        )
          return;
        reconciled.current = key;
        setFailure(null);
        if (!ui.selectedEnvironmentId || ui.selectedEnvironmentId === selectedHomeId) {
          ui.selectEnvironment(home.id);
        }
      })
      .catch((error: unknown) => {
        if (cancelled || isProjectHomeDeletionInProgress(selectedProjectId)) return;
        const message = error instanceof Error ? error.message : String(error);
        setFailure({ key, message });
        toast.error("Could not open the project home", {
          description: message,
          action: { label: "Retry", onClick: retry },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    selectedProjectId,
    projectPending,
    selectionKey,
    selectedEnvironmentId,
    selectedHomeId,
    checkoutPath,
    projectDeleting,
    homeDeleting,
    key,
    retry,
  ]);

  return { error: failure?.key === key ? failure.message : null, retry };
}
