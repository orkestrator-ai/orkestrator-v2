import { filesPanelStore } from "@/stores/filesPanelStore";
import { useFilesPanelChromeStore } from "@/stores/filesPanelChromeStore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddProjectDialog } from "@/components/projects/AddProjectDialog";
import { useSidebarHydration } from "@/components/sidebar/useSidebarHydration";
import { useEnvironments } from "@/hooks";
import { useEnvironmentListSync } from "@/hooks/useEnvironmentListSync";
import { useProjects } from "@/hooks/useProjects";
import { startsOnSelection } from "@/lib/environment-auto-start";
import { openCoordinatorWorkTarget } from "@/lib/coordinator-work-navigation";
import { openDialog } from "@/lib/federation/open-workspace";
import type { WorkspaceRequest } from "@/lib/federation/workspace-request";
import { suggestedCloneDirectory } from "@/lib/github-clone";
import { useConfigStore } from "@/stores/configStore";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useNodeScope } from "@/lib/node-scope/providers";
import { environmentStore } from "@/stores/environmentStore";
import { useProjectStore } from "@/stores/projectStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import {
  noteNodeSelectionRecents,
  selectionOnScope,
  useWindowSelection,
} from "@/stores/windowSelectionStore";
import { windowScopeOf } from "@/lib/node-scope/window-scope";
import { uiStore } from "@/stores/uiStore";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("web.federation");

/**
 * The window's last request each node's host applied, by scope: a host
 * remounted on the same scope (Try again after a crash, or a suspended node
 * shown again) resumes from the node's own selection and does not open a
 * one-shot dialog again. A new scope starts afresh.
 */
const appliedRequests = new WeakMap<NodeScope, number>();

/**
 * What the node's selection adds to the window's: its `uiStore` already
 * moved the window's one selection (plan item 3006); this marks a project
 * home (the sidebar highlights its project row) and records the window's
 * recents. Nothing while the window's selection is elsewhere.
 */
function noteNodeSelection(scope: NodeScope, projectHome: boolean): void {
  const windowScope = windowScopeOf(scope);
  const selection = windowScope ? selectionOnScope(scope) : null;
  if (!windowScope || !selection) return;
  const { projectHome: _previous, ...rest } = selection;
  const next = projectHome ? { ...rest, projectHome: true } : rest;
  windowScope.select(next);
  noteNodeSelectionRecents(next);
}

/** What the node's own stores have loaded: the facts its dialogs read. */
export interface NodeDialogHydration {
  readonly projectsLoaded: boolean;
  readonly projectsLoading: boolean;
  readonly configLoaded: boolean;
  /** Every project's environments have loaded (`useSidebarHydration`). */
  readonly environmentsReady: boolean;
}

/**
 * Whether the node's stores have what a request's dialog reads, so it may
 * open now (plan item 4005). Add Project waits for the node's projects; a
 * project's dialog for the project list to be live, Delete Project also for
 * its environments, Repository Settings also for the config. An
 * environment's dialogs wait for the environment itself.
 */
export function dialogHydrated(
  request: Pick<WorkspaceRequest, "addProject" | "dialog" | "environmentId">,
  hydration: NodeDialogHydration,
): boolean {
  const projectsLive = hydration.projectsLoaded && !hydration.projectsLoading;
  if (request.addProject) return hydration.projectsLoaded;
  if (!request.dialog || request.environmentId) return true;
  if (!projectsLive) return false;
  if (request.dialog === "delete-project") return hydration.environmentsReady;
  if (request.dialog === "repository-settings") return hydration.configLoaded;
  return true;
}

/**
 * What a node's own sidebar would do for its workspace shown in the window's
 * tree, which has the window's sidebar instead: keep the node's projects and
 * environments loaded, show what the window asks for
 * (`remoteWorkspaceStore.requests`) as a sidebar click would (starting a
 * local environment that needs it), add the Home flag and recents to the
 * window's selection, and open the node's Add Project, project and
 * environment dialogs. New Environment is the window's own dialog
 * (`AppDialogHost`), whichever node it creates on.
 */
export function NodeWorkspaceHost() {
  const {
    projects,
    addProject,
    createProjectFromScratch,
    validateGitUrl,
    isLoading: projectsLoading,
  } = useProjects();
  const { allEnvironments, loadEnvironments, refreshEnvironmentSnapshot, startEnvironment } =
    useEnvironments(null);
  // The node this host shows: the one the hooks above read.
  const scope = useNodeScope();
  const selection = useWindowSelection();
  const shownHere = selectionOnScope(scope, selection) !== null;
  const projectsLoaded = useProjectStore((state) => state.hasLoaded);
  const configLoaded = useConfigStore((state) => state.hasLoaded);
  const projectIds = useMemo(() => projects.map((project) => project.id), [projects]);
  useEnvironmentListSync(
    projectIds,
    (projectId) => loadEnvironments(projectId, { silent: true, reconcileStatus: false }),
    refreshEnvironmentSnapshot,
  );
  const loadAuthoritativeEnvironments = useCallback(
    (projectId: string) => loadEnvironments(projectId, { throwOnError: true }),
    [loadEnvironments],
  );
  const environmentsReady = useSidebarHydration(
    projects,
    projectsLoaded && !projectsLoading,
    allEnvironments,
    loadAuthoritativeEnvironments,
  );

  // What the window asked for last, numbered so the same request twice counts twice.
  const windowRequest = useRemoteWorkspaceStore((state) => state.requests[scope.nodeId]);
  const request = useMemo(
    () => (windowRequest ? { ...windowRequest.request, seq: windowRequest.seq } : null),
    [windowRequest],
  );
  const [resumedSeq] = useState(() => appliedRequests.get(scope) ?? 0);
  const appliedSeq = useRef(resumedSeq);
  // The request whose dialog the user closed.
  const [closedSeq, setClosedSeq] = useState(resumedSeq);

  useEffect(
    () =>
      scope.store(uiStore).subscribe((state, previous) => {
        if (
          state.selectedProjectId === previous.selectedProjectId &&
          state.selectedEnvironmentId === previous.selectedEnvironmentId
        ) {
          return;
        }
        const projectHome = scope
          .store(environmentStore)
          .getState()
          .environments.some(
            (environment) =>
              environment.id === state.selectedEnvironmentId &&
              environment.projectId === state.selectedProjectId &&
              environment.projectHome,
          );
        noteNodeSelection(scope, projectHome);
      }),
    [scope],
  );

  const hydration: NodeDialogHydration = {
    projectsLoaded,
    projectsLoading,
    configLoaded,
    environmentsReady,
  };
  const dialogRequest = shownHere && request && closedSeq < request.seq ? request : null;
  const showAddProject =
    Boolean(dialogRequest?.addProject) && dialogHydrated({ addProject: true }, hydration);
  const closeDialog = () => {
    if (request) setClosedSeq(request.seq);
  };

  // Select what was asked for, as the node's own sidebar would.
  useEffect(() => {
    if (!request || appliedSeq.current >= request.seq) return;
    // Hydration can finish after navigation, while this warm host remains
    // mounted. Read the current intent again at the side-effect boundary.
    if (
      !selectionOnScope(scope) ||
      useRemoteWorkspaceStore.getState().requests[scope.nodeId]?.seq !== request.seq
    )
      return;
    const seq = request.seq;
    const applied = () => {
      appliedSeq.current = seq;
      appliedRequests.set(scope, seq);
    };
    const ui = scope.store(uiStore).getState();
    const hydrated = dialogHydrated(request, {
      projectsLoaded,
      projectsLoading,
      configLoaded,
      environmentsReady,
    });
    if (request.addProject) {
      if (!hydrated) return;
      applied();
      ui.selectProject(null);
      return;
    }
    if (!request.projectId) {
      applied();
      return;
    }
    if (!request.environmentId) {
      // A project's dialog reads the project from the node's loaded list.
      if (!hydrated) return;
      applied();
      ui.selectProject(request.projectId, { landingTab: request.landingTab });
      if (request.boardTab) ui.setProjectBoardTab(request.boardTab);
      if (request.dialog) openDialog(request.dialog, request.projectId, undefined, scope.nodeId);
      return;
    }
    const environment = allEnvironments.find((candidate) => candidate.id === request.environmentId);
    if (!environment) {
      // Gone since the window listed it: show its project instead.
      if (environmentsReady) {
        applied();
        ui.selectProject(request.projectId, { landingTab: request.landingTab });
        if (request.boardTab) ui.setProjectBoardTab(request.boardTab);
      }
      return;
    }
    applied();
    ui.setProjectCollapsed(environment.projectId, false);
    ui.selectProjectAndEnvironment(environment.projectId, environment.id, {
      landingTab: request.landingTab,
    });
    // A project home opens on its Home tab, as its own sidebar opens it.
    if (request.boardTab) ui.setProjectBoardTab(request.boardTab);
    if (request.filesPanelTab) {
      scope.store(filesPanelStore).getState().setActiveTab(request.filesPanelTab);
      useFilesPanelChromeStore.getState().openPanel();
    }
    if (request.workTarget) openCoordinatorWorkTarget(request.workTarget, undefined, scope);
    if (request.dialog) {
      // Opening its settings is not a request to start it.
      openDialog(request.dialog, environment.projectId, environment.id, scope.nodeId);
      return;
    }
    if (startsOnSelection(environment)) {
      startEnvironment(environment.id).catch((error: unknown) => {
        log.error("environment.start-failed", {
          environmentId: environment.id,
          error: formatLogError(error),
        });
      });
    }
  }, [
    allEnvironments,
    configLoaded,
    environmentsReady,
    projectsLoaded,
    projectsLoading,
    request,
    scope,
    selection,
    startEnvironment,
  ]);

  const defaultCloneDirectory = useMemo(
    () => suggestedCloneDirectory(projects.map((project) => project.localPath)),
    [projects],
  );
  const projectGitUrls = useMemo(() => projects.map((project) => project.gitUrl), [projects]);

  return (
    <>
      <AddProjectDialog
        open={showAddProject}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        onAdd={async (gitUrl, localPath, cloneOnly) => {
          await addProject(gitUrl, localPath, cloneOnly);
        }}
        onCreate={async (localPath) => {
          await createProjectFromScratch(localPath);
        }}
        validateGitUrl={validateGitUrl}
        defaultCloneDirectory={defaultCloneDirectory}
        existingGitUrls={projectGitUrls}
      />
    </>
  );
}
