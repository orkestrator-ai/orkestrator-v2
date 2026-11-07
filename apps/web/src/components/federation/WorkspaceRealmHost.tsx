import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBugReportStore } from "@/stores/bugReportStore";
import { AddProjectDialog } from "@/components/projects/AddProjectDialog";
import { CreateEnvironmentFlowDialog } from "@/components/environments/CreateEnvironmentFlowDialog";
import { useSidebarHydration } from "@/components/sidebar/useSidebarHydration";
import {
  useRealmFanOutTiming,
  useTimedEnvironmentLoad,
} from "@/components/federation/useRealmBootTiming";
import { useDockerAvailabilityReady } from "@/contexts/DockerAvailabilityContext";
import { useEnvironments } from "@/hooks";
import { useEnvironmentListSync } from "@/hooks/useEnvironmentListSync";
import { useProjects } from "@/hooks/useProjects";
import { startsOnSelection } from "@/lib/environment-auto-start";
import { openCoordinatorWorkTarget } from "@/lib/coordinator-work-navigation";
import { openDialog } from "@/lib/federation/open-workspace";
import { suggestedCloneDirectory } from "@/lib/github-clone";
import { getReadCoordinator } from "@/lib/read-coordinator";
import { type RealmSelectRequest } from "@/lib/federation/workspace-realm";
import { useRealmChannel } from "@/lib/federation/realm-channel";
import { useConfigStore } from "@/stores/configStore";
import { useFilesPanelChromeStore } from "@/stores/filesPanelChromeStore";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useShimNodeScope } from "@/lib/node-scope/scoped-store-shim";
import { environmentStore } from "@/stores/environmentStore";
import { useProjectStore } from "@/stores/projectStore";
import { useRealmShellStore } from "@/stores/realmShellStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { noteNodeSelectionRecents, selectionOnScope } from "@/stores/windowSelectionStore";
import { windowScopeOf } from "@/lib/node-scope/window-scope";
import { uiStore } from "@/stores/uiStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("web.federation");

/**
 * The window's last request each in-tree node's host applied, by scope: a
 * host remounted on the same scope (Try again after a crash) resumes from
 * the node's own selection and does not open a one-shot dialog again, as a
 * realm document opened after `ready` does not. A new scope starts afresh.
 */
const appliedInTree = new WeakMap<NodeScope, number>();

/**
 * What a realm's `selection` report does in its window, for a node in the
 * window's tree, whose `uiStore` already moved the window's selection: mark
 * a project home (the sidebar highlights its project row) and record the
 * window's recents. Nothing while the window's selection is elsewhere.
 */
function noteInTreeSelection(scope: NodeScope, projectHome: boolean): void {
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
  /** The node's first Docker probe has finished. */
  readonly dockerReady: boolean;
}

/**
 * Whether the node's stores have what a request's dialog reads, so it may
 * open now. These checks on the node's scope are the only gate: a realm's
 * window also waits for `ready` before it sends a request, but in the
 * window's tree there is no `ready` (plan item 4005). Add Project waits for
 * the node's projects; New Environment also for its config and first Docker
 * probe (its defaults); a project's dialog for the project list to be live,
 * Delete Project also for its environments, Repository Settings also for
 * the config. An environment's dialogs wait for the environment itself.
 */
export function dialogHydrated(
  request: Pick<
    RealmSelectRequest,
    "addProject" | "createEnvironmentProjectId" | "dialog" | "environmentId"
  >,
  hydration: NodeDialogHydration,
): boolean {
  const projectsLive = hydration.projectsLoaded && !hydration.projectsLoading;
  if (request.addProject) return hydration.projectsLoaded;
  if (request.createEnvironmentProjectId) {
    return projectsLive && hydration.configLoaded && hydration.dockerReady;
  }
  if (!request.dialog || request.environmentId) return true;
  if (!projectsLive) return false;
  if (request.dialog === "delete-project") return hydration.environmentsReady;
  if (request.dialog === "repository-settings") return hydration.configLoaded;
  return true;
}

/**
 * What a node's own sidebar would do for its workspace, in a realm that has
 * no sidebar: keep the node's projects and environments loaded, show what
 * the window asks for as a sidebar click would (starting a local environment
 * that needs it), tell the window when the selection changes here, and open
 * the node's Add Project, New Environment, project and environment dialogs.
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
    refreshEnvironmentSnapshot,
    createEnvironment,
    startEnvironment,
    updateEnvironment,
  } = useEnvironments(null);
  // The node this realm shows: the one the hooks above read.
  const scope = useShimNodeScope("environment");
  // The page's transport in a realm document; the window's loopback for a
  // node shown in the window's own tree (`InTreeWorkspace`).
  const channel = useRealmChannel();
  // In the window's tree this node shares the window's document and stores:
  // what they hold is read and written directly, not exchanged (plan item 4005).
  const inTree = channel.kind === "loopback";
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
  // The realm's boot steps for the desktop's log (`realm-boot-timing.ts`).
  const bootTiming = useTimedEnvironmentLoad(loadAuthoritativeEnvironments);
  const environmentsReady = useSidebarHydration(
    projects,
    projectsLoaded && !projectsLoading,
    allEnvironments,
    bootTiming.load,
  );
  useRealmFanOutTiming(
    projectsLoaded &&
      !projectsLoading &&
      projects.every((project) => bootTiming.settled.has(project.id)),
    bootTiming.clock,
    Array.from(bootTiming.settled.values()).some((succeeded) => !succeeded),
  );

  // What the window asked for last, numbered so the same request twice counts
  // twice. A realm document is told (`select`); in the window's tree it is
  // the window's node-qualified request itself (plan item 4005).
  const [sentRequest, setSentRequest] = useState<(RealmSelectRequest & { seq: number }) | null>(
    () => {
      const initial = inTree ? null : channel.initialRequest();
      return initial ? { ...initial, seq: 1 } : null;
    },
  );
  const windowRequest = useRemoteWorkspaceStore((state) =>
    inTree ? state.requests[scope.nodeId] : undefined,
  );
  const request = useMemo(
    () =>
      inTree
        ? windowRequest
          ? { ...windowRequest.request, seq: windowRequest.seq }
          : null
        : sentRequest,
    [inTree, sentRequest, windowRequest],
  );
  const nextSeq = useRef(2);
  const [resumedSeq] = useState(() => (inTree ? (appliedInTree.get(scope) ?? 0) : 0));
  const appliedSeq = useRef(resumedSeq);
  // The request whose dialog the user closed.
  const [closedSeq, setClosedSeq] = useState(resumedSeq);
  // Set while the window's files panel state is applied here, so it is not echoed back.
  const applyingShellFilesPanel = useRef(false);

  // Listen first, then say so: the window resends what it asked meanwhile.
  useEffect(
    () =>
      channel.onMessage((message) => {
        if (message.type === "select") {
          setSentRequest({ ...message, seq: nextSeq.current++ });
          return;
        }
        // The window's sidebar: the toolbar here shows and toggles it.
        if (message.type === "sidebar") useUIChromeStore.getState().setSidebarOpen(message.open);
        // The window owns the files panel's state; applying it is not a new choice to report.
        if (
          message.type === "filesPanel" &&
          useFilesPanelChromeStore.getState().isOpen !== message.open
        ) {
          applyingShellFilesPanel.current = true;
          try {
            useFilesPanelChromeStore.setState({ isOpen: message.open });
          } finally {
            applyingShellFilesPanel.current = false;
          }
        }
        // The window's grouping decides whether this node's coordinator opens directly.
        if (message.type === "grouping") {
          useRealmShellStore.setState({ grouping: message.grouping });
        }
        // A frame or view the window hides still reads as visible here, so the
        // window says so and this realm's reads defer as a hidden window's do.
        // In the window's own tree (where it is not sent, plan item 4005) the
        // document's visibility is the window's, which a hidden node must not
        // change; its scope's tier does (4002).
        if (message.type === "visibility" && !inTree) {
          getReadCoordinator().setHostHidden(message.hidden);
        }
      }),
    [channel, inTree],
  );
  // In the window's tree nothing waits for `ready`: the request is read from
  // the window's store, and the node's hydration gates its dialogs (4005).
  useEffect(() => (inTree ? undefined : channel.post({ type: "ready" })), [channel, inTree]);
  // The window asked for this node's Report a bug sheet, which runs here so
  // its agent session talks to this node. In the window's tree the sheet is
  // the window's, on this node's scope (plan item 5003); `openBugReport`
  // opens it directly, so this is only a request made while the node was
  // still shown by a realm.
  const bugReportSeq = useRef(resumedSeq);
  useEffect(() => {
    if (!request?.bugReport || bugReportSeq.current >= request.seq) return;
    bugReportSeq.current = request.seq;
    useBugReportStore.getState().openSheet(inTree ? scope.nodeId : null);
  }, [inTree, request, scope]);
  // The toolbar here toggles the window's sidebar; in the window's tree it
  // writes the window's store itself, so there is nothing to report.
  useEffect(
    () =>
      inTree
        ? undefined
        : useUIChromeStore.subscribe((state, previous) => {
            if (state.sidebarOpen !== previous.sidebarOpen) {
              channel.post({ type: "sidebar", open: state.sidebarOpen });
            }
          }),
    [channel, inTree],
  );
  // In the window's tree the files panel's state is the window's own store.
  useEffect(
    () =>
      inTree
        ? undefined
        : useFilesPanelChromeStore.subscribe((state, previous) => {
            if (state.isOpen !== previous.isOpen && !applyingShellFilesPanel.current) {
              channel.post({ type: "filesPanel", open: state.isOpen });
            }
          }),
    [channel, inTree],
  );

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
        if (inTree) {
          // In the window's tree the store has already moved the window's one
          // selection (plan item 3006); what a realm's report adds, the Home
          // flag and the window's recents, is applied to it directly (4005).
          noteInTreeSelection(scope, projectHome);
          return;
        }
        channel.post({
          type: "selection",
          projectId: state.selectedProjectId,
          environmentId: state.selectedEnvironmentId,
          ...(projectHome ? { projectHome: true } : {}),
        });
      }),
    [channel, inTree, scope],
  );

  // The New Environment dialog reads its defaults (environment type, ports)
  // when it opens, so it waits for the node's projects, config and first
  // Docker probe. An unfinished probe must not force a local default.
  const hydration: NodeDialogHydration = {
    projectsLoaded,
    projectsLoading,
    configLoaded,
    environmentsReady,
    dockerReady,
  };
  const createReady = dialogHydrated({ createEnvironmentProjectId: "*" }, hydration);
  const dialogRequest = request && closedSeq < request.seq ? request : null;
  const showAddProject =
    Boolean(dialogRequest?.addProject) && dialogHydrated({ addProject: true }, hydration);
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
    const seq = request.seq;
    const applied = () => {
      appliedSeq.current = seq;
      if (inTree) appliedInTree.set(scope, seq);
    };
    const ui = scope.store(uiStore).getState();
    const hydrated = dialogHydrated(request, {
      projectsLoaded,
      projectsLoading,
      configLoaded,
      environmentsReady,
      dockerReady,
    });
    if (request.addProject) {
      if (!hydrated) return;
      applied();
      ui.selectProject(null);
      return;
    }
    if (request.createEnvironmentProjectId) {
      if (!hydrated) return;
      applied();
      const projectId = request.createEnvironmentProjectId;
      if (projects.some((project) => project.id === projectId)) ui.selectProject(projectId);
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
      ui.selectProject(request.projectId);
      if (request.boardTab) ui.setProjectBoardTab(request.boardTab);
      if (request.dialog) openDialog(request.dialog, request.projectId, undefined, scope.nodeId);
      return;
    }
    const environment = allEnvironments.find((candidate) => candidate.id === request.environmentId);
    if (!environment) {
      // Gone since the window listed it: show its project instead.
      if (environmentsReady) {
        applied();
        ui.selectProject(request.projectId);
        if (request.boardTab) ui.setProjectBoardTab(request.boardTab);
      }
      return;
    }
    applied();
    ui.setProjectCollapsed(environment.projectId, false);
    ui.selectProjectAndEnvironment(environment.projectId, environment.id);
    // A project home opens on its Home tab, as its own sidebar opens it.
    if (request.boardTab) ui.setProjectBoardTab(request.boardTab);
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
    dockerReady,
    environmentsReady,
    inTree,
    projects,
    projectsLoaded,
    projectsLoading,
    request,
    scope,
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
