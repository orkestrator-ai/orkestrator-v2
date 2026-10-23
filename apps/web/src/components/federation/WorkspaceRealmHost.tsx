import { useEffect, useMemo, useRef, useState } from "react";
import { AddProjectDialog } from "@/components/projects/AddProjectDialog";
import { CreateEnvironmentFlowDialog } from "@/components/environments/CreateEnvironmentFlowDialog";
import { useSidebarHydration } from "@/components/sidebar/useSidebarHydration";
import { useDockerAvailabilityReady } from "@/contexts/DockerAvailabilityContext";
import { useEnvironments } from "@/hooks";
import { useEnvironmentListSync } from "@/hooks/useEnvironmentListSync";
import { useProjects } from "@/hooks/useProjects";
import { startsOnSelection } from "@/lib/environment-auto-start";
import { suggestedCloneDirectory } from "@/lib/github-clone";
import {
  onShellMessage,
  postToShell,
  realmInitialRequest,
  type RealmSelectRequest,
} from "@/lib/federation/workspace-realm";
import { useConfigStore } from "@/stores/configStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";

/**
 * What a node's own sidebar would do for its workspace, in a realm that has
 * no sidebar: keep the node's projects and environments loaded, show what
 * the window asks for as a sidebar click would (starting a local environment
 * that needs it), tell the window when the selection changes here, and open
 * the node's Add Project and New Environment dialogs.
 */
export function WorkspaceRealmHost() {
  const dockerReady = useDockerAvailabilityReady();
  const {
    projects,
    addProject,
    createProjectFromScratch,
    validateGitUrl,
    isLoading: projectsLoading,
  } = useProjects();
  const {
    allEnvironments,
    loadEnvironments,
    createEnvironment,
    startEnvironment,
    updateEnvironment,
  } = useEnvironments(null);
  const projectsLoaded = useProjectStore((state) => state.hasLoaded);
  const configLoaded = useConfigStore((state) => state.hasLoaded);
  const projectIds = useMemo(() => projects.map((project) => project.id), [projects]);
  useEnvironmentListSync(projectIds, (projectId) =>
    loadEnvironments(projectId, { silent: true, reconcileStatus: false }),
  );
  const environmentsReady = useSidebarHydration(
    projects,
    projectsLoaded && !projectsLoading,
    allEnvironments,
    loadEnvironments,
  );

  // What the window asked for last, numbered so the same request twice counts twice.
  const [request, setRequest] = useState<(RealmSelectRequest & { seq: number }) | null>(() => {
    const initial = realmInitialRequest();
    return initial ? { ...initial, seq: 1 } : null;
  });
  const nextSeq = useRef(2);
  const appliedSeq = useRef(0);
  // The request whose dialog the user closed.
  const [closedSeq, setClosedSeq] = useState(0);

  // Listen first, then say so: the window resends what it asked meanwhile.
  useEffect(
    () =>
      onShellMessage((message) => {
        if (message.type === "select") {
          setRequest({ ...message, seq: nextSeq.current++ });
          return;
        }
        // The window's sidebar: the toolbar here shows and toggles it.
        if (message.type === "sidebar" && useUIStore.getState().sidebarOpen !== message.open) {
          useUIStore.setState({ sidebarOpen: message.open });
        }
      }),
    [],
  );
  useEffect(() => postToShell({ type: "ready" }), []);
  useEffect(
    () =>
      useUIStore.subscribe((state, previous) => {
        if (state.sidebarOpen !== previous.sidebarOpen) {
          postToShell({ type: "sidebar", open: state.sidebarOpen });
        }
      }),
    [],
  );

  useEffect(
    () =>
      useUIStore.subscribe((state, previous) => {
        if (
          state.selectedProjectId === previous.selectedProjectId &&
          state.selectedEnvironmentId === previous.selectedEnvironmentId
        ) {
          return;
        }
        postToShell({
          type: "selection",
          projectId: state.selectedProjectId,
          environmentId: state.selectedEnvironmentId,
        });
      }),
    [],
  );

  // The New Environment dialog reads its defaults (environment type, ports)
  // when it opens, so it waits for the node's projects, config and first
  // Docker probe. An unfinished probe must not force a local default.
  const createReady = configLoaded && projectsLoaded && !projectsLoading && dockerReady;
  const dialogRequest = request && closedSeq < request.seq ? request : null;
  const showAddProject = Boolean(dialogRequest?.addProject) && projectsLoaded;
  const createProjectId = createReady ? (dialogRequest?.createEnvironmentProjectId ?? null) : null;
  const createProjectKnown =
    createProjectId !== null && projects.some((project) => project.id === createProjectId);
  // A project that is not there once everything has loaded is gone; a later
  // refresh must not revive the request.
  if (dialogRequest && createProjectId !== null && !createProjectKnown) {
    setClosedSeq(dialogRequest.seq);
  }
  const createEnvProjectId = createProjectKnown ? createProjectId : null;
  const closeDialog = () => {
    if (request) setClosedSeq(request.seq);
  };

  // Select what was asked for, as the node's own sidebar would.
  useEffect(() => {
    if (!request || appliedSeq.current >= request.seq) return;
    const ui = useUIStore.getState();
    if (request.addProject) {
      if (!projectsLoaded) return;
      appliedSeq.current = request.seq;
      ui.selectProject(null);
      return;
    }
    if (request.createEnvironmentProjectId) {
      if (!createReady) return;
      appliedSeq.current = request.seq;
      const projectId = request.createEnvironmentProjectId;
      if (projects.some((project) => project.id === projectId)) ui.selectProject(projectId);
      return;
    }
    if (!request.projectId) {
      appliedSeq.current = request.seq;
      return;
    }
    if (!request.environmentId) {
      appliedSeq.current = request.seq;
      ui.selectProject(request.projectId);
      if (request.boardTab) ui.setProjectBoardTab(request.boardTab);
      return;
    }
    const environment = allEnvironments.find((candidate) => candidate.id === request.environmentId);
    if (!environment) {
      // Gone since the window listed it: show its project instead.
      if (environmentsReady) {
        appliedSeq.current = request.seq;
        ui.selectProject(request.projectId);
        if (request.boardTab) ui.setProjectBoardTab(request.boardTab);
      }
      return;
    }
    appliedSeq.current = request.seq;
    ui.setProjectCollapsed(environment.projectId, false);
    ui.selectProjectAndEnvironment(environment.projectId, environment.id);
    if (startsOnSelection(environment)) {
      startEnvironment(environment.id).catch((error: unknown) => {
        console.error("[Workspace] Failed to start the opened environment:", error);
      });
    }
  }, [
    allEnvironments,
    createReady,
    environmentsReady,
    projects,
    projectsLoaded,
    request,
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
      <CreateEnvironmentFlowDialog
        open={createEnvProjectId !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        projectId={createEnvProjectId}
        projectName={projects.find((project) => project.id === createEnvProjectId)?.name}
        createEnvironment={createEnvironment}
        updateEnvironment={updateEnvironment}
        startEnvironment={startEnvironment}
      />
    </>
  );
}
