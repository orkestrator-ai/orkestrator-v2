import { MOBILE_SHELL_MEDIA_QUERY, noteDrawerNavigation } from "@/lib/mobile-shell";
import { useSidebarHydration } from "./useSidebarHydration";
import { useSelectedEnvironmentActions } from "./useSelectedEnvironmentActions";
import { onCreateEnvironmentRequest, openMachineWorkspace } from "@/lib/federation/open-workspace";
import { startsOnSelection } from "@/lib/environment-auto-start";
import { lazy, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { projectTreeSortingStrategy } from "@/lib/sidebar-sorting";
import { Button } from "@/components/ui/button";
import { ArrowUpDown, Plus, Square, Trash2, RotateCw, RefreshCw } from "lucide-react";
import { ProjectHomeActivity } from "./ProjectHomeActivity";
import { CompactRepositoryList } from "./CompactRepositoryList";
import { ActivityEnvironmentList } from "./ActivityEnvironmentList";
import { SortableProjectGroup } from "./SortableProjectGroup";
import { SidebarDragOverlay } from "./SidebarDragOverlay";
import { SidebarEmptyState } from "./SidebarEmptyState";
import { SortableProjectFolder } from "./SortableProjectFolder";
import { SidebarRootDropZone } from "./SidebarRootDropZone";
import { AddProjectDialog } from "@/components/projects/AddProjectDialog";
import { suggestedCloneDirectory } from "@/lib/github-clone";
import { AddToFolderDialog } from "@/components/projects/AddToFolderDialog";
import {
  CreateEnvironmentFlowDialog,
  startEnvironmentInBackground,
} from "@/components/environments/CreateEnvironmentFlowDialog";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useProjects } from "@/hooks/useProjects";
import { useEnvironments } from "@/hooks/useEnvironments";
import { useEnvironmentListSync } from "@/hooks/useEnvironmentListSync";
import { useAgentActivityStore } from "@/stores/agentActivityStore";
import {
  displayedActivityResolver,
  sortEnvironmentsByActivity,
} from "@/lib/environment-activity-sort";
import {
  environmentStore,
  projectStore,
  uiStore,
  useUIStore,
  useProjectStore,
  useEnvironmentStore,
} from "@/stores";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useShimNodeScope } from "@/lib/node-scope/scoped-store-shim";
import { drainProjectHomeEnsures } from "@/hooks/useFilesPanel";
import { useEnvironmentDiffStats } from "@/hooks/useEnvironmentDiffStats";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { Environment, EnvironmentType, Project } from "@/types";
import { ProjectSearchBar } from "./ProjectSearchBar";
import { SidebarBottomBar } from "./SidebarBottomBar";
import { useRevealMachineProject } from "@/components/federation/useRevealMachineProject";
import { ServerConnectionSwitcher } from "./ServerConnectionSwitcher";
import { useFederation } from "@/components/federation/FederationProvider";
import { useProjectCopyStore } from "@/stores/projectCopyStore";
import { MachinesFilter } from "@/components/federation/MachinesFilter";
import { MachineDot, MachineHomeIcon, ProjectIconImage } from "@/components/federation/MachineDot";
import { machineTextClass } from "@/lib/federation/machine-colors";
import {
  FederatedActivityList,
  MachineSectionList,
  MergedProjectList,
} from "@/components/federation/FederatedSidebarSections";
import { useBoundCollapseSync } from "@/components/federation/useBoundCollapseSync";
import { useMachineViews } from "@/components/federation/useMachineViews";
import { ALL_MACHINES, filterMachines, type MachineView } from "@/lib/federation/aggregate";
import { isMachineShown } from "@/lib/federation/sidebar-layout";
import { isSelectedEnvironmentReachable } from "@/lib/federation/selected-environments";
import { applySidebarModifierSelection } from "@/lib/sidebar-selection";
import { useMachineViewStore } from "@/stores/machineViewStore";
import {
  nextSidebarView,
  sidebarGroupingOptions,
  sidebarViewForChoice,
  type SidebarView,
} from "@/lib/federation/sidebar-grouping";
import { onAppShortcut } from "@/lib/app-shortcuts";
import { COMPACT_SIDEBAR_WIDTH_PX } from "@/lib/sidebar-width";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  EnvironmentItem,
  resolveEnvironmentAgentActivity,
} from "@/components/environments/EnvironmentItem";
import { cn } from "@/lib/utils";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { sidebarCollisionDetection } from "@/lib/sidebar-collision";
import { withoutProjectHomes } from "@/lib/project-home";
import { LazyDialogLoadingFallback, LazyLoadBoundary } from "@/components/LazyLoadBoundary";
import { useDockerAvailability } from "@/contexts/DockerAvailabilityContext";
import {
  buildProjectTree,
  flattenProjectTree,
  isProjectFolderCollapsed,
  listProjectFolderNames,
  normalizeProjectFolderName,
  parseProjectFolderDragId,
  projectSortableIds,
  type ProjectFolderEntry,
} from "@/lib/project-folders";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("web.sidebar");

const NO_ENVIRONMENTS: Environment[] = [];
const NO_MACHINES: MachineView[] = [];
const LazyRepositorySettings = lazy(async () => ({
  default: (await import("@/components/settings/RepositorySettings")).RepositorySettings,
}));

/**
 * What kind of row a drag started on. Projects and folders both resolve
 * through the folder-aware arrangement resolver; environments do not, because
 * they never move between projects.
 */
export type SidebarDragType = "project" | "folder" | "environment";

export type SidebarReorderResult = {
  type: "environment";
  projectId: string;
  ids: string[];
};

// Kept here for existing importers; the order itself is shared with the
// federated list and the CLI.
export { sortEnvironmentsByActivity };

export { animateActivityRowMovement, measureActivityRowLayoutTop } from "./ActivityEnvironmentList";

/**
 * Resolves an environment drag within its project.
 *
 * Project and folder drags are resolved by `resolveProjectArrangement`, which
 * has to reason about folder membership as well as order; this stays the
 * environment-only path.
 */
export function resolveSidebarReorder(
  activeId: string,
  overId: string,
  activeType: SidebarDragType | null,
  _projects: Project[],
  environments: Environment[],
): SidebarReorderResult | null {
  if (activeId === overId) return null;
  if (activeType === "environment") {
    const activeEnvironment = environments.find((environment) => environment.id === activeId);
    const overEnvironment = environments.find((environment) => environment.id === overId);
    if (
      !activeEnvironment ||
      !overEnvironment ||
      activeEnvironment.projectId !== overEnvironment.projectId
    ) {
      return null;
    }
    const projectEnvironments = environments
      .filter((environment) => environment.projectId === activeEnvironment.projectId)
      .sort((left, right) => left.order - right.order);
    const oldIndex = projectEnvironments.findIndex((environment) => environment.id === activeId);
    const newIndex = projectEnvironments.findIndex((environment) => environment.id === overId);
    if (oldIndex === -1 || newIndex === -1) return null;
    const [removed] = projectEnvironments.splice(oldIndex, 1);
    if (!removed) return null;
    projectEnvironments.splice(newIndex, 0, removed);
    return {
      type: "environment",
      projectId: activeEnvironment.projectId,
      ids: projectEnvironments.map((environment) => environment.id),
    };
  }
  return null;
}

export async function forkSidebarEnvironment(
  environmentId: string,
  environmentType: EnvironmentType,
  options: {
    allEnvironments: Environment[];
    dockerAvailable: boolean;
    projectsById: Map<string, Pick<Project, "localPath">>;
    forkEnvironment: (
      environmentId: string,
      environmentType: EnvironmentType,
    ) => Promise<Environment>;
    setProjectCollapsed: (projectId: string, collapsed: boolean) => void;
    selectProjectAndEnvironment: (projectId: string, environmentId: string) => void;
    startEnvironment: (
      environmentId: string,
      initialPrompt?: string,
      startOptions?: { background?: boolean; silent?: boolean },
    ) => Promise<unknown>;
  },
): Promise<void> {
  const source = options.allEnvironments.find((environment) => environment.id === environmentId);
  if (!source) return;
  if (environmentType === "containerized" && !options.dockerAvailable) {
    toast.warning("Docker is not running", {
      description: "Start Docker before forking a container environment.",
    });
    return;
  }
  if (environmentType === "local") {
    const project = options.projectsById.get(source.projectId);
    if (project && !project.localPath) {
      toast.warning("Local worktrees are unavailable", {
        description: "Add a local checkout for this project before forking locally.",
      });
      return;
    }
  }
  try {
    const created = await options.forkEnvironment(environmentId, environmentType);
    options.setProjectCollapsed(created.projectId, false);
    options.selectProjectAndEnvironment(created.projectId, created.id);
    startEnvironmentInBackground(options.startEnvironment, created.id);
  } catch (error) {
    log.error("fork.failed", { environmentId, error: formatLogError(error) });
  }
}

export function createProjectUpdateHandler(
  updateProject: (project: Project) => Promise<unknown>,
): (project: Project) => Promise<void> {
  return async (project) => {
    await updateProject(project);
  };
}

export async function deleteProjectAndEnvironments(
  projectId: string,
  environments: Environment[],
  deleteEnvironment: (environmentId: string) => Promise<unknown>,
  removeProject: (projectId: string) => Promise<unknown>,
  scope: NodeScope,
): Promise<void> {
  const projects = scope.store(projectStore).getState();
  projects.setDeleting(projectId, true);
  const ui = scope.store(uiStore);
  if (ui.getState().selectedProjectId === projectId) {
    ui.getState().selectProject(null);
  }
  try {
    const admittedHomes = await drainProjectHomeEnsures(projectId, scope);
    const currentEnvironments = scope
      .store(environmentStore)
      .getState()
      .environments.filter((environment) => environment.projectId === projectId);
    const toDelete = new Map(
      [...environments, ...currentEnvironments, ...admittedHomes].map((env) => [env.id, env]),
    );
    const failedNames: string[] = [];
    for (const environment of toDelete.values()) {
      try {
        await deleteEnvironment(environment.id);
      } catch (error) {
        log.error("environment.delete-failed", {
          environmentId: environment.id,
          error: formatLogError(error),
        });
        failedNames.push(environment.name);
      }
    }
    if (failedNames.length > 0) {
      throw new Error(`Failed to delete some environments: ${failedNames.join(", ")}`);
    }
    await removeProject(projectId);
  } finally {
    if (ui.getState().selectedProjectId === projectId) {
      ui.getState().selectProject(null);
    }
    projects.setDeleting(projectId, false);
  }
}

export function HierarchicalSidebar() {
  const dockerAvailable = useDockerAvailability();
  // Poll git diff stats for all environments
  useEnvironmentDiffStats();
  const [showAddProjectDialog, setShowAddProjectDialog] = useState(false);
  const [showCreateEnvDialog, setShowCreateEnvDialog] = useState(false);
  const [createEnvProjectId, setCreateEnvProjectId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<SidebarDragType | null>(null);
  const [folderDialogProjectId, setFolderDialogProjectId] = useState<string | null>(null);
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null);
  const isMobile = useMediaQuery(MOBILE_SHELL_MEDIA_QUERY);

  const {
    projects,
    addProject,
    createProjectFromScratch,
    removeProject,
    updateProject,
    arrangeProjectsByIntent,
    validateGitUrl,
    isLoading: projectsLoading,
  } = useProjects();
  const {
    allEnvironments,
    loadEnvironments,
    refreshEnvironmentSnapshot,
    createEnvironment,
    forkEnvironment,
    deleteEnvironment,
    startEnvironment,
    stopEnvironment,
    restartEnvironment,
    reorderEnvironments,
    updateEnvironment,
  } = useEnvironments(null);
  // The node this sidebar lists: the one the hooks above read.
  const scope = useShimNodeScope("environment");

  useEnvironmentListSync(
    projects.map((project) => project.id),
    (projectId) => loadEnvironments(projectId, { silent: true, reconcileStatus: false }),
    refreshEnvironmentSnapshot,
  );

  // Data via narrow selectors; actions are stable references on the store.
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const collapsedProjects = useUIStore((state) => state.collapsedProjects);
  const collapsedProjectFolders = useUIStore((state) => state.collapsedProjectFolders);
  const selectedEnvironmentIds = useUIStore((state) => state.selectedEnvironmentIds);
  const environmentSortMode = useUIChromeStore((state) => state.environmentSortMode);
  const activitySortOrder = useUIChromeStore((state) => state.activitySortOrder);
  const selectProject = useUIStore((state) => state.selectProject);
  const selectProjectAndEnvironment = useUIStore((state) => state.selectProjectAndEnvironment);
  const setProjectCollapsed = useUIStore((state) => state.setProjectCollapsed);
  const toggleProjectCollapse = useUIStore((state) => state.toggleProjectCollapse);
  const toggleProjectFolderCollapse = useUIStore((state) => state.toggleProjectFolderCollapse);
  const setProjectFolderCollapsed = useUIStore((state) => state.setProjectFolderCollapsed);
  const clearMultiSelection = useUIStore((state) => state.clearMultiSelection);
  const projectsLoaded = useProjectStore((state) => state.hasLoaded);
  const setEnvironmentSortMode = useUIChromeStore((state) => state.setEnvironmentSortMode);
  const setActivitySortOrder = useUIChromeStore((state) => state.setActivitySortOrder);
  // Multi-machine presentation. This sidebar's own machine keeps its full
  // tree; other machines appear as their own sections, or merged into one
  // projection when grouped by project/repository or sorted by activity.
  const federation = useFederation();
  const machineViews = useMachineViews();
  const revealMachineProject = useRevealMachineProject();
  const machineFilter = useMachineViewStore((state) => state.machineFilter);
  const machineGrouping = useMachineViewStore((state) => state.grouping);
  const setMachineGrouping = useMachineViewStore((state) => state.setGrouping);
  // The phone layout's overlay stays a full list, closest to compact when
  // grouped by repository; the choice is kept for desktop widths.
  const compactActive = machineGrouping === "compact" && !isMobile;
  const listGrouping = machineGrouping === "compact" ? "repository" : machineGrouping;
  const openMachinePanel = openMachineWorkspace;
  const visibleMachines = useMemo(
    () =>
      federation.enabled
        ? filterMachines(
            machineViews,
            machineViews.some((machine) => machine.connectionId === machineFilter)
              ? machineFilter
              : ALL_MACHINES,
          )
        : [],
    [federation.enabled, machineFilter, machineViews],
  );
  const boundMachineView = machineViews.find((machine) => machine.bound) ?? null;
  // This sidebar's own projects can be copied to the machines it commands.
  const copySourceNodeId = federation.enabled
    ? (boundMachineView?.backendId ?? federation.portalState.selfId)
    : null;
  const openProjectCopy = useProjectCopyStore((state) => state.open);
  const remoteMachinesVisible = visibleMachines.filter((machine) => !machine.bound);
  // Machines are listed in the command node's order, whichever one this window
  // works on. Merged lists hide a machine that is not connected; its projects
  // keep their place for when it is back.
  const federatedMode: "machine" | "activity" | "project" | "repository" | null =
    !federation.enabled
      ? null
      : remoteMachinesVisible.length === 0
        ? environmentSortMode === "activity"
          ? null
          : "machine"
        : environmentSortMode === "activity"
          ? "activity"
          : listGrouping;
  const mergedShownIds = useMemo(
    () => new Set(visibleMachines.filter(isMachineShown).map((machine) => machine.connectionId)),
    [visibleMachines],
  );
  const openedRepositoryKey = useMachineViewStore((state) => state.openedRepository?.projectKey);
  useBoundCollapseSync(
    federation.enabled ? (boundMachineView?.backendId ?? null) : null,
    projects,
    projectsLoaded && !projectsLoading,
  );
  // After the window moved to another node, the list returns to where it was.
  const listScrollRef = useRef<HTMLDivElement>(null);

  // A project home has no row of its own: selecting its project activates it.
  const sidebarEnvironments = useMemo(
    () => withoutProjectHomes(allEnvironments),
    [allEnvironments],
  );
  const selectedProjectHomeActive = useMemo(
    () =>
      allEnvironments.some(
        (environment) => environment.id === selectedEnvironmentId && environment.projectHome,
      ),
    [allEnvironments, selectedEnvironmentId],
  );
  // Sort on the activity each row displays (runtime observations, and working
  // during an active build), not the raw persisted state.
  const runtimeActivityStates = useAgentActivityStore((state) => state.containerStates);
  const runtimeActivityUpdatedAt = useAgentActivityStore((state) => state.containerStateUpdatedAt);
  const activeBuildEnvironmentIds = useBuildPipelineStore(
    (state) => state.activeBuildEnvironmentIds,
  );
  const displayedActivity = useMemo(
    () =>
      displayedActivityResolver(
        runtimeActivityStates,
        runtimeActivityUpdatedAt,
        activeBuildEnvironmentIds,
      ),
    [runtimeActivityStates, runtimeActivityUpdatedAt, activeBuildEnvironmentIds],
  );
  const activityEnvironments = useMemo(
    () =>
      sortEnvironmentsByActivity(
        sidebarEnvironments,
        projects,
        activitySortOrder,
        displayedActivity,
      ),
    [sidebarEnvironments, projects, activitySortOrder, displayedActivity],
  );
  const defaultCloneDirectory = useMemo(
    () => suggestedCloneDirectory(projects.map((project) => project.localPath)),
    [projects],
  );
  const projectGitUrls = useMemo(() => projects.map((project) => project.gitUrl), [projects]);
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const projectTree = useMemo(() => buildProjectTree(projects), [projects]);
  const projectFolderNames = useMemo(() => listProjectFolderNames(projects), [projects]);
  const compactLocalProjects = useMemo(() => flattenProjectTree(projectTree), [projectTree]);
  // Sortable ids and the rendered rows must be built from the same tree and the
  // same collapse state: a registered id with no visible row still resolves
  // drops, and would drop a project into a folder the user cannot see.
  const projectSortableItems = useMemo(
    () => projectSortableIds(projectTree, collapsedProjectFolders),
    [projectTree, collapsedProjectFolders],
  );
  const projectSortingStrategy = useMemo(
    () => projectTreeSortingStrategy(projectTree, projectSortableItems),
    [projectTree, projectSortableItems],
  );
  const totalEnvironmentCount = activityEnvironments.length;
  const deletingEnvironments = useEnvironmentStore((state) => state.deletingEnvironments);
  const waitingEnvironmentCount = useAgentActivityStore(
    (state) =>
      allEnvironments.filter(
        (environment) =>
          !deletingEnvironments.has(environment.id) &&
          !environment.deletionRequestedAt &&
          environment.lifecycleOperation !== "deleting" &&
          (environment.hasUnreadWork ||
            (environment.projectHome &&
              resolveEnvironmentAgentActivity(
                environment,
                state.containerStates,
                state.containerStateUpdatedAt,
              ) === "waiting")),
      ).length,
  );

  const isMultiSelectMode = selectedEnvironmentIds.length >= 1;

  const applySidebarView = useCallback(
    (view: SidebarView) => {
      setMachineGrouping(view.grouping);
      setEnvironmentSortMode(view.sortMode);
    },
    [setEnvironmentSortMode, setMachineGrouping],
  );

  // "By project" and "by repository" change nothing until another machine is shown.
  const mergedModesAvailable = federation.enabled && remoteMachinesVisible.some(isMachineShown);
  useEffect(
    () =>
      onAppShortcut("rotate-sidebar-grouping", () => {
        const chrome = useUIChromeStore.getState();
        if (!isMobile && !chrome.sidebarOpen) chrome.toggleSidebar();
        const views = useMachineViewStore.getState();
        const next = nextSidebarView(
          {
            grouping: views.grouping,
            groupingBeforeCompact: views.groupingBeforeCompact,
            sortMode: useUIChromeStore.getState().environmentSortMode,
          },
          { mergedModes: mergedModesAvailable, compact: !isMobile },
        );
        if (next) applySidebarView(next);
      }),
    [applySidebarView, isMobile, mergedModesAvailable],
  );

  // Compact has no environment rows to act on.
  useEffect(() => {
    if (compactActive && isMultiSelectMode) clearMultiSelection();
  }, [clearMultiSelection, compactActive, isMultiSelectMode]);

  // Handle Escape key to clear multi-selection
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isMultiSelectMode) {
        clearMultiSelection();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMultiSelectMode, clearMultiSelection]);

  useSidebarHydration(
    projects,
    projectsLoaded && !projectsLoading && (!federation.supported || federation.portalState.loaded),
    allEnvironments,
    loadEnvironments,
  );

  // Group environments by project in one memoized pass, instead of a
  // filter+sort per project per render.
  const environmentsByProject = useMemo(() => {
    const grouped = new Map<string, Environment[]>();
    for (const environment of sidebarEnvironments) {
      const bucket = grouped.get(environment.projectId);
      if (bucket) bucket.push(environment);
      else grouped.set(environment.projectId, [environment]);
    }
    for (const bucket of grouped.values()) {
      bucket.sort((a, b) => a.order - b.order);
    }
    return grouped;
  }, [sidebarEnvironments]);

  // Get environments for a specific project
  const getProjectEnvironments = useCallback(
    (projectId: string): Environment[] => environmentsByProject.get(projectId) ?? NO_ENVIRONMENTS,
    [environmentsByProject],
  );

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const draggedId = String(active.id);
    setActiveId(draggedId);

    if (parseProjectFolderDragId(draggedId) !== null) {
      setActiveType("folder");
      return;
    }
    setActiveType(projects.some((p) => p.id === draggedId) ? "project" : "environment");
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setActiveType(null);

    if (!over) return;
    const draggedId = String(active.id);
    const droppedOnId = String(over.id);
    try {
      if (activeType === "project" || activeType === "folder") {
        await arrangeProjectsByIntent({ kind: "move", activeId: draggedId, overId: droppedOnId });
        return;
      }
      const reorder = resolveSidebarReorder(
        draggedId,
        droppedOnId,
        activeType,
        projects,
        allEnvironments,
      );
      if (reorder) await reorderEnvironments(reorder.projectId, reorder.ids);
    } catch (err) {
      log.error("reorder.persist-failed", { error: formatLogError(err) });
    }
  };

  const handleAddToFolder = async (projectId: string, folderName: string): Promise<void> => {
    await arrangeProjectsByIntent({ kind: "add-to-folder", projectId, folder: folderName });
    // A folder the user just filed something into has to be visible, otherwise
    // the project appears to have vanished from the sidebar.
    setProjectFolderCollapsed(folderName, false);
  };

  const handleRemoveFromFolder = (projectId: string): void => {
    void arrangeProjectsByIntent({ kind: "remove-from-folder", projectId }).catch((err) => {
      log.error("folder.project-remove-failed", { projectId, error: formatLogError(err) });
    });
  };

  const handleRenameFolder = (folderName: string, nextName: string): void => {
    // Collapse state is carried against the name that was actually stored, not
    // the typed one: normalization collapses whitespace and control-character
    // runs, and a key that no longer matches leaves the renamed folder expanded
    // while stranding the old entry in the persisted list forever.
    const storedName = normalizeProjectFolderName(nextName);
    void arrangeProjectsByIntent({ kind: "rename-folder", folder: folderName, name: nextName })
      .then(() => {
        if (storedName && isProjectFolderCollapsed(collapsedProjectFolders, folderName)) {
          setProjectFolderCollapsed(folderName, false);
          setProjectFolderCollapsed(storedName, true);
        }
      })
      .catch((err) => {
        log.error("folder.rename-failed", { error: formatLogError(err) });
      });
  };

  const handleUngroupFolder = (folderName: string): void => {
    void arrangeProjectsByIntent({ kind: "ungroup-folder", folder: folderName })
      .then(() => setProjectFolderCollapsed(folderName, false))
      .catch((err) => {
        log.error("folder.ungroup-failed", { error: formatLogError(err) });
      });
  };

  const handleSortFolder = (folderName: string): void => {
    void arrangeProjectsByIntent({ kind: "sort-folder", folder: folderName }).catch((err) => {
      log.error("folder.sort-failed", { error: formatLogError(err) });
    });
  };

  const handleAddProject = async (gitUrl: string, localPath?: string, cloneOnly?: boolean) => {
    try {
      await addProject(gitUrl, localPath, cloneOnly);
    } catch (err) {
      log.error("project.add-failed", { error: formatLogError(err) });
      throw err; // Re-throw so the dialog can handle it
    }
  };

  const handleCreateProject = async (localPath: string) => {
    try {
      await createProjectFromScratch(localPath);
    } catch (err) {
      log.error("project.create-failed", { error: formatLogError(err) });
      throw err;
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    // Includes the project home, which has no sidebar row.
    const projectEnvs = allEnvironments.filter(
      (environment) => environment.projectId === projectId,
    );
    try {
      await deleteProjectAndEnvironments(
        projectId,
        projectEnvs,
        deleteEnvironment,
        removeProject,
        scope,
      );
    } catch (err) {
      log.error("project.delete-failed", { projectId, error: formatLogError(err) });
      throw err;
    }
  };

  const handleOpenCreateEnvDialog = (projectId: string) => {
    setCreateEnvProjectId(projectId);
    setShowCreateEnvDialog(true);
  };

  // "New environment" from a machine section that turned out to be this one.
  useEffect(
    () =>
      onCreateEnvironmentRequest((projectId) => {
        setCreateEnvProjectId(projectId);
        setShowCreateEnvDialog(true);
      }),
    [],
  );

  // useCallback so memo(EnvironmentItem) rows are not invalidated every render.
  const handleSelectEnvironment = useCallback(
    (environmentId: string, modifiers: { shiftKey?: boolean; metaKey?: boolean } = {}) => {
      if (applySidebarModifierSelection(environmentId, modifiers)) return;

      // Normal click: clear multi-selection and select single environment
      if (isMobile && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      clearMultiSelection();
      const environment = allEnvironments.find((e) => e.id === environmentId);
      if (environment) {
        selectProjectAndEnvironment(environment.projectId, environmentId);
        // The phone drawer closes even when this is the environment already shown.
        noteDrawerNavigation();
        // Auto-start local environments on selection so a terminal can open
        if (startsOnSelection(environment)) {
          log.info("auto-start.started", {
            environmentId: environment.id,
            status: environment.status,
            hasWorktree: !!environment.worktreePath,
          });
          // Setup command handling (blocking, placeholder, resolve) is centralized
          // in useEnvironments.startEnvironment() for all code paths.
          startEnvironment(environment.id).catch((err) => {
            log.error("auto-start.failed", {
              environmentId: environment.id,
              error: formatLogError(err),
            });
          });
        }
        // Already-started local environments resume their backend-owned setup
        // phase from the persisted environment snapshot.
      }
    },
    [isMobile, clearMultiSelection, allEnvironments, selectProjectAndEnvironment, startEnvironment],
  );

  const revealProject = useCallback(
    (projectId: string) => {
      setProjectCollapsed(projectId, false);
      const project = projectsById.get(projectId);
      if (project?.folder) {
        setProjectFolderCollapsed(project.folder, false);
      }
    },
    [projectsById, setProjectCollapsed, setProjectFolderCollapsed],
  );

  const handleSearchSelectProject = useCallback(
    (projectId: string) => {
      revealProject(projectId);
      selectProject(projectId);
    },
    [revealProject, selectProject],
  );

  const handleSearchSelectEnvironment = useCallback(
    (environmentId: string) => {
      const environment = allEnvironments.find((entry) => entry.id === environmentId);
      if (environment) {
        revealProject(environment.projectId);
      }
      handleSelectEnvironment(environmentId);
    },
    [allEnvironments, handleSelectEnvironment, revealProject],
  );

  const selection = useSelectedEnvironmentActions({
    selectionIds: selectedEnvironmentIds,
    localEnvironments: allEnvironments,
    machines: machineViews,
    dockerAvailable,
    stopEnvironment,
    restartEnvironment,
    deleteEnvironment,
  });

  const handleDeleteSelected = async () => {
    await selection.deleteSelected();
    // Clear all selection after deletion
    clearMultiSelection();
    setShowBulkDeleteDialog(false);
  };

  const selectionSpansMachines = selection.selected.some((entry) => entry.remote);

  const handleForkEnvironment = useCallback(
    (environmentId: string, environmentType: EnvironmentType) =>
      forkSidebarEnvironment(environmentId, environmentType, {
        allEnvironments,
        dockerAvailable,
        projectsById,
        forkEnvironment,
        setProjectCollapsed,
        selectProjectAndEnvironment,
        startEnvironment,
      }),
    [
      allEnvironments,
      dockerAvailable,
      forkEnvironment,
      projectsById,
      selectProjectAndEnvironment,
      setProjectCollapsed,
      startEnvironment,
    ],
  );

  const handleOpenSettings = (projectId: string) => {
    setSettingsProjectId(projectId);
    setShowSettingsDialog(true);
  };

  const handleUpdateProject = createProjectUpdateHandler(updateProject);

  const folderDialogProject = folderDialogProjectId
    ? (projectsById.get(folderDialogProjectId) ?? null)
    : null;

  // Get the project for the settings dialog
  const settingsProject = settingsProjectId
    ? projects.find((p) => p.id === settingsProjectId)
    : null;

  // This machine's home, in its colour, wherever the sidebar names machines;
  // shown even before the machine is identified, then coloured once it is.
  const boundHomeIcon = (project: Project) => (
    <MachineHomeIcon
      colorToken={boundMachineView?.colorToken}
      machineName={boundMachineView?.name ?? "This machine"}
      status="This window"
      projectIcon={project.icon}
    />
  );
  const projectIconOnly = (project: Project) =>
    project.icon ? <ProjectIconImage src={project.icon} /> : undefined;

  const renderProjectGroup = (
    project: Project,
    mixed?: {
      sortableId: string;
      machineIcon?: ReactNode;
      label?: string;
      labelClassName?: string;
      /** Its repository heading opened it and is highlighted in its place. */
      openedByHeading?: boolean;
    },
  ) => (
    <SortableProjectGroup
      key={project.id}
      sortableId={mixed?.sortableId}
      machineIcon={
        mixed
          ? mixed.machineIcon
          : federation.enabled
            ? boundHomeIcon(project)
            : projectIconOnly(project)
      }
      label={mixed?.label}
      labelClassName={mixed?.labelClassName}
      machineName={federation.enabled ? (boundMachineView?.name ?? "This machine") : undefined}
      project={project}
      environments={getProjectEnvironments(project.id)}
      home={allEnvironments.find(
        (environment) =>
          environment.projectId === project.id &&
          environment.projectHome &&
          !environment.deletionRequestedAt &&
          environment.lifecycleOperation !== "deleting",
      )}
      isCollapsed={collapsedProjects.includes(project.id)}
      isSelected={
        !mixed?.openedByHeading &&
        selectedProjectId === project.id &&
        (!selectedEnvironmentId || selectedProjectHomeActive)
      }
      onToggleCollapse={() => toggleProjectCollapse(project.id)}
      selectedEnvironmentId={selectedEnvironmentId}
      onSelectProject={() => selectProject(project.id)}
      onSelectEnvironment={handleSelectEnvironment}
      onDeleteProject={handleDeleteProject}
      onOpenSettings={() => handleOpenSettings(project.id)}
      onDeleteEnvironment={deleteEnvironment}
      onStartEnvironment={startEnvironment}
      onStopEnvironment={stopEnvironment}
      onRestartEnvironment={restartEnvironment}
      onForkEnvironment={handleForkEnvironment}
      onCreateEnvironment={() => handleOpenCreateEnvDialog(project.id)}
      onCopyToMachine={
        copySourceNodeId
          ? () => openProjectCopy({ source: { nodeId: copySourceNodeId, projectId: project.id } })
          : undefined
      }
      onAddToFolder={mixed ? undefined : () => setFolderDialogProjectId(project.id)}
      onRemoveFromFolder={
        !mixed && project.folder ? () => handleRemoveFromFolder(project.id) : undefined
      }
      isMultiSelectMode={isMultiSelectMode}
      selectedEnvironmentIds={selectedEnvironmentIds}
    />
  );

  // Get the active item for drag overlay
  const activeProject = activeType === "project" ? projects.find((p) => p.id === activeId) : null;
  const activeFolderKey =
    activeType === "folder" && activeId ? parseProjectFolderDragId(activeId) : null;
  const activeFolder =
    activeFolderKey === null
      ? null
      : (projectTree.find(
          (entry): entry is ProjectFolderEntry =>
            entry.kind === "folder" && entry.key === activeFolderKey,
        ) ?? null);
  const activeEnvironment =
    activeType === "environment" ? allEnvironments.find((e) => e.id === activeId) : null;

  const renderActivityHome = (home: Environment) => (
    <ProjectHomeActivity
      key={home.id}
      home={home}
      projectName={projectsById.get(home.projectId)?.name ?? "Unknown project"}
    />
  );

  const renderActivityItem = (environment: Environment) => (
    <EnvironmentItem
      environment={environment}
      subtitle={projectsById.get(environment.projectId)?.name ?? "Unknown project"}
      isSelected={selectedEnvironmentId === environment.id}
      onSelect={handleSelectEnvironment}
      onDelete={deleteEnvironment}
      onStart={startEnvironment}
      onStop={stopEnvironment}
      onRestart={restartEnvironment}
      onFork={handleForkEnvironment}
      isMultiSelectMode={isMultiSelectMode}
      isChecked={selectedEnvironmentIds.includes(environment.id)}
    />
  );

  /** This window's own machine's projects and environments. */
  const localTree =
    projectsLoading && projects.length === 0 ? (
      <SidebarEmptyState loading />
    ) : projects.length === 0 ? (
      <SidebarEmptyState onAdd={() => setShowAddProjectDialog(true)} />
    ) : environmentSortMode === "activity" ? (
      <ActivityEnvironmentList
        testId="activity-environment-list"
        createTargets={projects.map((project) => ({
          key: project.id,
          name: project.name,
          onSelect: () => handleOpenCreateEnvDialog(project.id),
        }))}
        totalCount={totalEnvironmentCount}
        waitingCount={waitingEnvironmentCount}
        homes={sortEnvironmentsByActivity(
          allEnvironments,
          projects,
          activitySortOrder,
          displayedActivity,
        )
          .filter(
            (environment) =>
              environment.projectHome &&
              !environment.deletionRequestedAt &&
              environment.lifecycleOperation !== "deleting",
          )
          .map((home) => renderActivityHome(home))}
        rows={activityEnvironments.map((environment) => ({
          key: environment.id,
          environmentId: environment.id,
          selected: selectedEnvironmentId === environment.id && !isMultiSelectMode,
          content: renderActivityItem(environment),
        }))}
      />
    ) : (
      <DndContext
        sensors={sensors}
        collisionDetection={sidebarCollisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={projectSortableItems} strategy={projectSortingStrategy}>
          {projectTree.map((entry) =>
            entry.kind === "project" ? (
              renderProjectGroup(entry.project)
            ) : (
              <SortableProjectFolder
                key={`folder:${entry.key}`}
                name={entry.name}
                projectCount={entry.projects.length}
                isCollapsed={isProjectFolderCollapsed(collapsedProjectFolders, entry.name)}
                onToggleCollapse={() => toggleProjectFolderCollapse(entry.name)}
                onRename={(nextName) => handleRenameFolder(entry.name, nextName)}
                onSort={() => handleSortFolder(entry.name)}
                onUngroup={() => handleUngroupFolder(entry.name)}
              >
                {entry.projects.map((project) => renderProjectGroup(project))}
              </SortableProjectFolder>
            ),
          )}
          <SidebarRootDropZone active={activeType === "project"} />
        </SortableContext>

        <SidebarDragOverlay
          item={
            activeProject
              ? { kind: "project", name: activeProject.name }
              : activeFolder
                ? { kind: "folder", name: activeFolder.name }
                : activeEnvironment
                  ? { kind: "environment", name: activeEnvironment.name }
                  : null
          }
        />
      </DndContext>
    );

  const renderMergedBoundProject = (
    projectId: string,
    sortableId: string,
    label: string | undefined,
  ) => {
    const project = projectsById.get(projectId);
    if (!project) return null;
    // A repository member is named by its machine, in the machine's colour.
    if (federatedMode === "repository") {
      return renderProjectGroup(project, {
        sortableId,
        label,
        labelClassName: machineTextClass(boundMachineView?.colorToken),
        machineIcon: projectIconOnly(project),
        openedByHeading: openedRepositoryKey === sortableId,
      });
    }
    return renderProjectGroup(project, { sortableId, label, machineIcon: boundHomeIcon(project) });
  };

  const handleBoundEnvironmentDrop = (activeId: string, overId: string) => {
    const reorder = resolveSidebarReorder(
      activeId,
      overId,
      "environment",
      projects,
      allEnvironments,
    );
    if (!reorder) return;
    reorderEnvironments(reorder.projectId, reorder.ids).catch((err: unknown) => {
      log.error("reorder.persist-failed", { error: formatLogError(err) });
    });
  };

  const boundDisplayedActivity = (environmentId: string) => {
    const environment = sidebarEnvironments.find((entry) => entry.id === environmentId);
    return environment ? displayedActivity(environment) : undefined;
  };
  const renderFederatedActivityRow = (environmentId: string) => {
    const environment = sidebarEnvironments.find((entry) => entry.id === environmentId);
    return environment ? renderActivityItem(environment) : null;
  };
  const renderFederatedActivityHome = (environmentId: string) => {
    const home = allEnvironments.find((entry) => entry.id === environmentId);
    return home ? renderActivityHome(home) : null;
  };

  const groupingOptions = sidebarGroupingOptions({
    federated: federation.enabled,
    sortMode: environmentSortMode,
    compact: compactActive,
  });
  const groupingValue = groupingOptions.some((option) => option.value === machineGrouping)
    ? machineGrouping
    : "";
  const sortMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-7 w-7",
            !compactActive && environmentSortMode === "activity" && "bg-zinc-800 text-foreground",
          )}
          title={compactActive ? "Sidebar view" : "Sort environments"}
          aria-label={
            compactActive
              ? "Sidebar view: Compact"
              : `Sort environments: ${environmentSortMode === "project" ? "By project" : "By activity"}`
          }
        >
          <ArrowUpDown className="h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={compactActive ? "start" : "end"} className="w-44">
        {compactActive ? null : (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Sort environments
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={environmentSortMode}
              onValueChange={(value) => {
                if (value === "project" || value === "activity") {
                  setEnvironmentSortMode(value);
                }
              }}
            >
              <DropdownMenuRadioItem value="project">By project</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="activity">By activity</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            {environmentSortMode === "activity" ? (
              <>
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Order
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={activitySortOrder}
                  onValueChange={(value) => {
                    if (value === "priority" || value === "newest" || value === "oldest") {
                      setActivitySortOrder(value);
                    }
                  }}
                >
                  <DropdownMenuRadioItem value="priority">Priority order</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="newest">Newest first</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="oldest">Oldest first</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </>
            ) : null}
          </>
        )}
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {federation.enabled && !compactActive && environmentSortMode === "project"
            ? "Group machines"
            : "Sidebar view"}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={groupingValue}
          onValueChange={(value) => {
            const view = sidebarViewForChoice(value, {
              grouping: machineGrouping,
              groupingBeforeCompact: useMachineViewStore.getState().groupingBeforeCompact,
              sortMode: environmentSortMode,
            });
            if (view) applySidebarView(view);
          }}
        >
          {groupingOptions.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div
      className="flex h-full flex-col"
      // Content stays one icon wide while the panel around it narrows.
      style={compactActive ? { width: COMPACT_SIDEBAR_WIDTH_PX } : undefined}
      data-sidebar-view={compactActive ? "compact" : undefined}
    >
      {/* Header - switches between normal and multi-select mode */}
      <div
        data-sidebar-header
        className={cn(
          "flex h-12 items-center border-b border-border/80 bg-chrome",
          compactActive ? "justify-center" : "justify-between pl-3 pr-2",
        )}
      >
        {compactActive ? (
          sortMenu
        ) : isMultiSelectMode ? (
          <>
            <span className="text-sm font-medium text-foreground">
              {selection.selected.length} selected
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-orange-500"
                onClick={() => void selection.stopSelected()}
                title="Stop selected"
                disabled={!selection.canStopOrRestart}
              >
                <Square className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={() => void selection.restartSelected()}
                title="Restart selected"
                disabled={!selection.canStopOrRestart}
              >
                <RotateCw className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={() => setShowBulkDeleteDialog(true)}
                title="Delete selected"
                disabled={!selection.canDelete}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </>
        ) : (
          <>
            {federation.enabled ? (
              <MachinesFilter machines={machineViews} />
            ) : (
              <ServerConnectionSwitcher />
            )}
            <div className="flex items-center gap-1">
              {sortMenu}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => window.location.reload()}
                title="Refresh projects, environments, tabs, and layout"
                aria-label="Refresh projects, environments, tabs, and layout"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
              </Button>
              {federation.enabled ? (
                // A project is added on a specific machine, chosen explicitly:
                // the window first moves to another machine, so its paths are
                // picked on that machine, never on this device.
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" title="Add project">
                      <Plus className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60">
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Add a project on
                    </DropdownMenuLabel>
                    {machineViews.map((machine) => (
                      <DropdownMenuItem
                        key={machine.connectionId}
                        disabled={!machine.bound && machine.transport !== "connected"}
                        onSelect={() => {
                          if (machine.bound) setShowAddProjectDialog(true);
                          else
                            openMachinePanel({
                              connectionId: machine.connectionId,
                              projectId: "",
                              title: "Add project",
                            });
                        }}
                      >
                        <MachineDot colorToken={machine.colorToken} machineName={machine.name} />
                        <span className="truncate">{machine.name}</span>
                        {machine.bound ? (
                          <span className="ml-auto text-[11px] text-muted-foreground">
                            This window
                          </span>
                        ) : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setShowAddProjectDialog(true)}
                  title="Add project"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              )}
            </div>
          </>
        )}
      </div>

      {compactActive ? null : (
        <ProjectSearchBar
          projects={projects}
          environments={sidebarEnvironments}
          onSelectProject={handleSearchSelectProject}
          onSelectEnvironment={handleSearchSelectEnvironment}
          onSelectMachineProject={revealMachineProject}
        />
      )}

      {/* Projects List */}
      {compactActive ? (
        <CompactRepositoryList
          machines={federation.enabled && boundMachineView ? machineViews : NO_MACHINES}
          localProjects={compactLocalProjects}
          environments={allEnvironments}
          loading={projectsLoading}
          onAddProject={() => setShowAddProjectDialog(true)}
        />
      ) : (
        <div ref={listScrollRef} data-sidebar-scroll className="min-h-0 flex-1 overflow-y-auto">
          <div
            data-testid="sidebar-list-content"
            className={environmentSortMode === "activity" && projects.length > 0 ? "pb-2" : "py-2"}
          >
            {federatedMode === "activity" ? (
              <FederatedActivityList
                machines={visibleMachines}
                order={activitySortOrder}
                renderBoundRow={renderFederatedActivityRow}
                boundActivity={boundDisplayedActivity}
                renderBoundHome={renderFederatedActivityHome}
                boundSelectedId={isMultiSelectMode ? null : selectedEnvironmentId}
                onCreateBound={handleOpenCreateEnvDialog}
                boundWaitingCount={waitingEnvironmentCount}
              />
            ) : federatedMode === "project" || federatedMode === "repository" ? (
              <MergedProjectList
                machines={machineViews}
                shownIds={mergedShownIds}
                mode={federatedMode}
                renderBoundProject={renderMergedBoundProject}
                onBoundEnvironmentDragEnd={handleBoundEnvironmentDrop}
                boundLoading={projectsLoading && projects.length === 0}
                onAddProject={() => setShowAddProjectDialog(true)}
              />
            ) : federatedMode === "machine" && boundMachineView ? (
              <MachineSectionList
                machines={machineViews}
                shown={visibleMachines}
                renderBound={() => localTree}
              />
            ) : federatedMode === "machine" ? (
              // This window's machine is not identified yet; its tree comes first.
              <>
                {localTree}
                <MachineSectionList
                  machines={machineViews}
                  shown={remoteMachinesVisible}
                  renderBound={() => null}
                />
              </>
            ) : (
              localTree
            )}
          </div>
        </div>
      )}

      <SidebarBottomBar stacked={compactActive} />

      {/* Add Project Dialog */}
      <AddProjectDialog
        open={showAddProjectDialog}
        onOpenChange={setShowAddProjectDialog}
        onAdd={handleAddProject}
        onCreate={handleCreateProject}
        validateGitUrl={validateGitUrl}
        defaultCloneDirectory={defaultCloneDirectory}
        existingGitUrls={projectGitUrls}
      />

      {/* Add to Folder Dialog */}
      <AddToFolderDialog
        open={folderDialogProject !== null}
        onOpenChange={(open) => {
          if (!open) setFolderDialogProjectId(null);
        }}
        projectName={folderDialogProject?.name ?? ""}
        currentFolder={folderDialogProject?.folder ?? null}
        existingFolders={projectFolderNames}
        onSubmit={async (folderName) => {
          if (!folderDialogProject) return;
          await handleAddToFolder(folderDialogProject.id, folderName);
        }}
      />

      {/* Create Environment Dialog */}
      <CreateEnvironmentFlowDialog
        open={showCreateEnvDialog}
        onOpenChange={(open) => {
          setShowCreateEnvDialog(open);
          if (!open) setCreateEnvProjectId(null);
        }}
        projectId={createEnvProjectId}
        projectName={projects.find((project) => project.id === createEnvProjectId)?.name}
        createEnvironment={createEnvironment}
        updateEnvironment={updateEnvironment}
        startEnvironment={startEnvironment}
      />

      {/* Bulk Delete Confirmation Dialog */}
      <AlertDialog open={showBulkDeleteDialog} onOpenChange={setShowBulkDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selection.selected.length} Environments</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>Are you sure you want to delete the following environments?</p>
                <ul className="mt-2 max-h-64 list-disc list-inside overflow-y-auto text-foreground">
                  {selection.selected.map((entry) => (
                    <li key={entry.selectionId}>
                      {entry.name}
                      {selectionSpansMachines && (
                        <span className="text-muted-foreground">
                          {" "}
                          on{" "}
                          {entry.remote?.machine.name ?? boundMachineView?.name ?? "this machine"}
                          {!isSelectedEnvironmentReachable(entry) && " (unavailable, skipped)"}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-orange-500">
                  This action cannot be undone. Running environments will be stopped first, and
                  their containers, persistent storage and recovery copies are deleted.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteSelected}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Repository Settings Dialog */}
      {settingsProject && showSettingsDialog && (
        <LazyLoadBoundary
          loadingFallback={<LazyDialogLoadingFallback label="Loading repository settings…" />}
        >
          <LazyRepositorySettings
            project={settingsProject}
            open={showSettingsDialog}
            onOpenChange={setShowSettingsDialog}
            onUpdateProject={handleUpdateProject}
          />
        </LazyLoadBoundary>
      )}
    </div>
  );
}
