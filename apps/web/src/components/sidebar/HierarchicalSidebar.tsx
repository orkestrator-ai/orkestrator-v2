import {
  lazy,
  useState,
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Button } from "@/components/ui/button";
import {
  ArrowUpDown,
  Bell,
  Boxes,
  Folder,
  Plus,
  FolderGit2,
  Square,
  Trash2,
  RotateCw,
  RefreshCw,
} from "lucide-react";
import { SortableProjectGroup } from "./SortableProjectGroup";
import { SortableProjectFolder } from "./SortableProjectFolder";
import { AddProjectDialog } from "@/components/projects/AddProjectDialog";
import { AddToFolderDialog } from "@/components/projects/AddToFolderDialog";
import { CreateEnvironmentFlowDialog } from "@/components/environments/CreateEnvironmentFlowDialog";
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
import { useUIStore } from "@/stores";
import { useEnvironmentDiffStats } from "@/hooks/useEnvironmentDiffStats";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { Environment, Project } from "@/types";
import { ServerConnectionSwitcher } from "./ServerConnectionSwitcher";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EnvironmentItem } from "@/components/environments/EnvironmentItem";
import { cn } from "@/lib/utils";
import { LazyDialogLoadingFallback, LazyLoadBoundary } from "@/components/LazyLoadBoundary";
import { useDockerAvailability } from "@/contexts/DockerAvailabilityContext";
import {
  PROJECT_ROOT_DROP_ID,
  buildProjectTree,
  isProjectFolderCollapsed,
  listProjectFolderNames,
  normalizeProjectFolderName,
  parseProjectFolderDragId,
  projectSortableIds,
  resolveAddProjectToFolder,
  resolveProjectArrangement,
  resolveRemoveProjectFromFolder,
  resolveRenameProjectFolder,
  resolveUngroupProjectFolder,
  type ProjectArrangement,
  type ProjectFolderEntry,
} from "@/lib/project-folders";

const NO_ENVIRONMENTS: Environment[] = [];
const LazyRepositorySettings = lazy(async () => ({
  default: (await import("@/components/settings/RepositorySettings")).RepositorySettings,
}));

/**
 * What kind of row a drag started on. Projects and folders both resolve
 * through the folder-aware arrangement resolver; environments do not, because
 * they never move between projects.
 */
export type SidebarDragType = "project" | "folder" | "environment";

export type SidebarReorderResult = { type: "environment"; projectId: string; ids: string[] };

export type SidebarSelectionResult =
  | { type: "toggle"; environmentId: string }
  | { type: "range"; ids: string[] }
  | { type: "single"; environmentId: string };

function parseActivityTime(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

/** Most recent activity first, with the existing project/environment order as a stable fallback. */
export function sortEnvironmentsByActivity(
  environments: Environment[],
  projects: Project[],
): Environment[] {
  const projectOrder = new Map(projects.map((project) => [project.id, project.order]));
  return [...environments].sort((left, right) => {
    const leftActivity = parseActivityTime(left.lastActivityAt);
    const rightActivity = parseActivityTime(right.lastActivityAt);
    if (leftActivity !== rightActivity) return rightActivity - leftActivity;

    const projectDifference =
      (projectOrder.get(left.projectId) ?? Number.MAX_SAFE_INTEGER) -
      (projectOrder.get(right.projectId) ?? Number.MAX_SAFE_INTEGER);
    if (projectDifference !== 0) return projectDifference;
    if (left.order !== right.order) return left.order - right.order;
    return left.id.localeCompare(right.id);
  });
}

export function measureActivityRowLayoutTop(element: HTMLElement): number {
  const getOffsetTop = (node: HTMLElement | null): number => {
    let top = 0;
    let current = node;
    while (current) {
      top += current.offsetTop;
      current = current.offsetParent as HTMLElement | null;
    }
    return top;
  };
  return getOffsetTop(element) - getOffsetTop(element.parentElement);
}

export function animateActivityRowMovement(
  element: HTMLElement,
  previousTop: number | null,
  reduceMotion: boolean,
): { top: number; animation: Animation | null } {
  const nextTop = measureActivityRowLayoutTop(element);
  const offset = previousTop === null ? 0 : previousTop - nextTop;
  let animation: Animation | null = null;
  if (offset !== 0 && !reduceMotion && typeof element.animate === "function") {
    animation = element.animate(
      [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }],
      {
        duration: 280,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    );
  }
  return { top: nextTop, animation };
}

function AnimatedActivityRow({
  environmentId,
  position,
  className,
  children,
}: {
  environmentId: string;
  position: number;
  className: string;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const previousTopRef = useRef<number | null>(null);
  const previousPositionRef = useRef(position);
  const animationRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;

    // Activity, unread, and status updates all re-render the sidebar. Only run
    // the FLIP animation when this row's actual list position changes so those
    // unrelated updates cannot restart transforms across the whole list.
    if (previousTopRef.current !== null && previousPositionRef.current === position) {
      // A preceding row may have changed height without changing this row's
      // numeric position. Refresh the transform-independent layout baseline,
      // but leave any in-flight animation alone.
      previousTopRef.current = measureActivityRowLayoutTop(row);
      return;
    }

    let previousTop = previousTopRef.current;
    const activeAnimation = animationRef.current;
    if (activeAnimation && activeAnimation.playState === "running") {
      // Preserve the row's current visual position when activity changes again
      // before the prior movement finishes. Cancelling first would otherwise
      // make the row jump to its new layout position.
      const parentTop = row.parentElement?.getBoundingClientRect().top ?? 0;
      const transformedTop = row.getBoundingClientRect().top - parentTop;
      activeAnimation.cancel();
      const layoutTop = row.getBoundingClientRect().top - parentTop;
      previousTop = (previousTopRef.current ?? layoutTop) + (transformedTop - layoutTop);
    }

    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const result = animateActivityRowMovement(row, previousTop, reduceMotion);
    previousTopRef.current = result.top;
    previousPositionRef.current = position;
    animationRef.current = result.animation;
  });

  return (
    <div ref={rowRef} data-environment-id={environmentId} className={className}>
      {children}
    </div>
  );
}

/**
 * Drop target for the root level.
 *
 * Only rendered while a project is being dragged, and only then does it take
 * up space: a permanent target at the bottom of the list would compete with
 * the last folder's own rows for every drop near the end.
 *
 * It is deliberately tall and offset from the last row. Collision detection is
 * `closestCenter`, so a short strip tucked directly under the final project
 * puts the two centres close enough together that a drop meant for the root
 * resolves against that project instead.
 */
function SidebarRootDropZone({ active }: { active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: PROJECT_ROOT_DROP_ID });
  if (!active) return null;
  return (
    <div
      ref={setNodeRef}
      data-testid="sidebar-root-drop-zone"
      className={cn(
        "mx-3 mt-3 mb-2 flex min-h-16 items-center justify-center rounded-lg border border-dashed px-3 py-4 text-center text-xs transition-colors",
        isOver
          ? "border-primary/70 bg-primary/10 text-foreground"
          : "border-zinc-800 text-zinc-500",
      )}
    >
      Drop here to remove from folder
    </div>
  );
}

export function resolveSidebarSelection(
  environmentId: string,
  modifiers: { shiftKey?: boolean; metaKey?: boolean },
  orderedIds: string[],
  selectedEnvironmentId: string | null,
  selectedEnvironmentIds: string[],
): SidebarSelectionResult {
  if (modifiers.shiftKey) {
    const clickedIndex = orderedIds.indexOf(environmentId);
    if (clickedIndex === -1) {
      return { type: "toggle", environmentId };
    }

    const anchorId = selectedEnvironmentId || selectedEnvironmentIds[0];
    if (!anchorId) {
      return { type: "range", ids: [environmentId] };
    }

    const anchorIndex = orderedIds.indexOf(anchorId);
    if (anchorIndex === -1) {
      return { type: "range", ids: [environmentId] };
    }

    const startIndex = Math.min(anchorIndex, clickedIndex);
    const endIndex = Math.max(anchorIndex, clickedIndex);
    return { type: "range", ids: orderedIds.slice(startIndex, endIndex + 1) };
  }

  if (modifiers.metaKey) {
    return { type: "toggle", environmentId };
  }

  return { type: "single", environmentId };
}

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

export function createEnvironmentUpdateHandler(
  updateEnvironment: (environmentId: string, environment: Environment) => void,
): (environment: Environment) => void {
  return (environment) => updateEnvironment(environment.id, environment);
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
): Promise<void> {
  const failedNames: string[] = [];
  for (const environment of environments) {
    try {
      await deleteEnvironment(environment.id);
    } catch (error) {
      console.error(`Failed to delete environment ${environment.name}:`, error);
      failedNames.push(environment.name);
    }
  }
  if (failedNames.length > 0) {
    throw new Error(`Failed to delete some environments: ${failedNames.join(", ")}`);
  }
  await removeProject(projectId);
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
  const isMobile = useMediaQuery("(max-width: 767px)");

  const {
    projects,
    addProject,
    createProjectFromScratch,
    removeProject,
    updateProject,
    arrangeProjects,
    validateGitUrl,
    isLoading: projectsLoading,
  } = useProjects();
  const {
    allEnvironments,
    loadEnvironments,
    createEnvironment,
    deleteEnvironment,
    startEnvironment,
    stopEnvironment,
    restartEnvironment,
    reorderEnvironments,
    updateEnvironment,
  } = useEnvironments(null);

  useEnvironmentListSync(
    projects.map((project) => project.id),
    (projectId) => loadEnvironments(projectId, { silent: true, reconcileStatus: false }),
  );

  // Data via narrow selectors; actions are stable references on the store.
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const collapsedProjects = useUIStore((state) => state.collapsedProjects);
  const collapsedProjectFolders = useUIStore((state) => state.collapsedProjectFolders);
  const selectedEnvironmentIds = useUIStore((state) => state.selectedEnvironmentIds);
  const environmentSortMode = useUIStore((state) => state.environmentSortMode);
  const selectProject = useUIStore((state) => state.selectProject);
  const selectProjectAndEnvironment = useUIStore((state) => state.selectProjectAndEnvironment);
  const toggleProjectCollapse = useUIStore((state) => state.toggleProjectCollapse);
  const toggleProjectFolderCollapse = useUIStore((state) => state.toggleProjectFolderCollapse);
  const setProjectFolderCollapsed = useUIStore((state) => state.setProjectFolderCollapsed);
  const toggleEnvironmentSelection = useUIStore((state) => state.toggleEnvironmentSelection);
  const setMultiSelection = useUIStore((state) => state.setMultiSelection);
  const clearMultiSelection = useUIStore((state) => state.clearMultiSelection);
  const collapseEmptyProjects = useUIStore((state) => state.collapseEmptyProjects);
  const setEnvironmentSortMode = useUIStore((state) => state.setEnvironmentSortMode);

  const activityEnvironments = useMemo(
    () => sortEnvironmentsByActivity(allEnvironments, projects),
    [allEnvironments, projects],
  );
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const projectTree = useMemo(() => buildProjectTree(projects), [projects]);
  const projectFolderNames = useMemo(() => listProjectFolderNames(projects), [projects]);
  // Sortable ids and the rendered rows must be built from the same tree and the
  // same collapse state: a registered id with no visible row still resolves
  // drops, and would drop a project into a folder the user cannot see.
  const projectSortableItems = useMemo(
    () => projectSortableIds(projectTree, collapsedProjectFolders),
    [projectTree, collapsedProjectFolders],
  );
  const totalEnvironmentCount = activityEnvironments.length;
  const waitingEnvironmentCount = useMemo(
    () => allEnvironments.filter((environment) => environment.hasUnreadWork).length,
    [allEnvironments],
  );

  const isMultiSelectMode = selectedEnvironmentIds.length >= 1;

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

  // Track which project IDs we've already loaded environments for
  const loadedProjectIdsRef = useRef<Set<string>>(new Set());
  // Track whether initial collapse of empty projects has been done
  const initialCollapseAppliedRef = useRef(false);

  // Reset the loaded ref when store is empty but ref has items
  // (handles hot reload where store is reset but ref persists)
  useEffect(() => {
    if (allEnvironments.length === 0 && loadedProjectIdsRef.current.size > 0) {
      loadedProjectIdsRef.current.clear();
      initialCollapseAppliedRef.current = false;
    }
  }, [allEnvironments.length]);

  // Load environments for new projects only (not on every project count change)
  useEffect(() => {
    const loadNewProjectEnvironments = async () => {
      for (const project of projects) {
        if (!loadedProjectIdsRef.current.has(project.id)) {
          loadedProjectIdsRef.current.add(project.id);
          try {
            await loadEnvironments(project.id);
          } catch (err) {
            // Keep later projects loading and allow this project to be retried
            // after the project list or environment store changes.
            loadedProjectIdsRef.current.delete(project.id);
            console.error(`Failed to load environments for project ${project.id}:`, err);
          }
        }
      }
    };
    if (projects.length > 0) {
      loadNewProjectEnvironments();
    }
  }, [projects, loadEnvironments]);

  // Collapse empty projects on initial load (runs once after environments are loaded)
  useEffect(() => {
    if (initialCollapseAppliedRef.current || projects.length === 0) {
      return;
    }
    // Wait until we've attempted to load environments for all projects
    const allProjectsLoaded = projects.every((p) => loadedProjectIdsRef.current.has(p.id));
    if (!allProjectsLoaded) {
      return;
    }
    // Apply collapse and mark as done
    const projectsWithEnvs = new Set(allEnvironments.map((e) => e.projectId));
    collapseEmptyProjects(
      projects.map((p) => p.id),
      projectsWithEnvs,
    );
    initialCollapseAppliedRef.current = true;
  }, [projects, allEnvironments, collapseEmptyProjects]);

  // Group environments by project in one memoized pass, instead of a
  // filter+sort per project per render.
  const environmentsByProject = useMemo(() => {
    const grouped = new Map<string, Environment[]>();
    for (const environment of allEnvironments) {
      const bucket = grouped.get(environment.projectId);
      if (bucket) bucket.push(environment);
      else grouped.set(environment.projectId, [environment]);
    }
    for (const bucket of grouped.values()) {
      bucket.sort((a, b) => a.order - b.order);
    }
    return grouped;
  }, [allEnvironments]);

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

  /** Persists one arrangement, or nothing when the gesture was a no-op. */
  const applyArrangement = async (arrangement: ProjectArrangement | null): Promise<void> => {
    if (!arrangement) return;
    await arrangeProjects(arrangement.projectIds, arrangement.folders);
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
        await applyArrangement(resolveProjectArrangement(draggedId, droppedOnId, projects));
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
      console.error("Failed to persist sidebar reorder:", err);
    }
  };

  const handleAddToFolder = async (projectId: string, folderName: string): Promise<void> => {
    await applyArrangement(resolveAddProjectToFolder(projects, projectId, folderName));
    // A folder the user just filed something into has to be visible, otherwise
    // the project appears to have vanished from the sidebar.
    setProjectFolderCollapsed(folderName, false);
  };

  const handleRemoveFromFolder = (projectId: string): void => {
    void applyArrangement(resolveRemoveProjectFromFolder(projects, projectId)).catch((err) => {
      console.error("Failed to remove project from folder:", err);
    });
  };

  const handleRenameFolder = (folderName: string, nextName: string): void => {
    // Collapse state is carried against the name that was actually stored, not
    // the typed one: normalization collapses whitespace and control-character
    // runs, and a key that no longer matches leaves the renamed folder expanded
    // while stranding the old entry in the persisted list forever.
    const storedName = normalizeProjectFolderName(nextName);
    void applyArrangement(resolveRenameProjectFolder(projects, folderName, nextName))
      .then(() => {
        if (storedName && isProjectFolderCollapsed(collapsedProjectFolders, folderName)) {
          setProjectFolderCollapsed(folderName, false);
          setProjectFolderCollapsed(storedName, true);
        }
      })
      .catch((err) => {
        console.error("Failed to rename project folder:", err);
      });
  };

  const handleUngroupFolder = (folderName: string): void => {
    void applyArrangement(resolveUngroupProjectFolder(projects, folderName))
      .then(() => setProjectFolderCollapsed(folderName, false))
      .catch((err) => {
        console.error("Failed to remove project folder:", err);
      });
  };

  const handleAddProject = async (gitUrl: string, localPath?: string) => {
    try {
      await addProject(gitUrl, localPath);
    } catch (err) {
      console.error("Failed to add project:", err);
      throw err; // Re-throw so the dialog can handle it
    }
  };

  const handleCreateProject = async (localPath: string) => {
    try {
      await createProjectFromScratch(localPath);
    } catch (err) {
      console.error("Failed to create project:", err);
      throw err;
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    const projectEnvs = getProjectEnvironments(projectId);
    try {
      await deleteProjectAndEnvironments(projectId, projectEnvs, deleteEnvironment, removeProject);
      // Clean up the loaded projects ref since project is deleted
      loadedProjectIdsRef.current.delete(projectId);
    } catch (err) {
      console.error("Failed to delete project:", err);
      throw err;
    }
  };

  const handleOpenCreateEnvDialog = (projectId: string) => {
    setCreateEnvProjectId(projectId);
    setShowCreateEnvDialog(true);
  };

  // Build a flat ordered list of visible environment IDs in display order
  // Only includes environments from expanded (non-collapsed) projects
  const getOrderedEnvironmentIds = useCallback((): string[] => {
    if (environmentSortMode === "activity") {
      return activityEnvironments.map((environment) => environment.id);
    }

    const orderedIds: string[] = [];
    const collectFrom = (project: Project): void => {
      // Skip collapsed projects - their environments aren't visible
      if (collapsedProjects.includes(project.id)) return;
      for (const env of getProjectEnvironments(project.id)) orderedIds.push(env.id);
    };
    for (const entry of projectTree) {
      if (entry.kind === "project") {
        collectFrom(entry.project);
        continue;
      }
      // A collapsed folder hides every project inside it, so shift-range
      // selection must not run through environments that are not on screen.
      if (isProjectFolderCollapsed(collapsedProjectFolders, entry.name)) continue;
      for (const project of entry.projects) collectFrom(project);
    }
    return orderedIds;
  }, [
    activityEnvironments,
    environmentSortMode,
    projectTree,
    collapsedProjectFolders,
    getProjectEnvironments,
    collapsedProjects,
  ]);

  // useCallback so memo(EnvironmentItem) rows are not invalidated every render.
  const handleSelectEnvironment = useCallback(
    (environmentId: string, modifiers: { shiftKey?: boolean; metaKey?: boolean } = {}) => {
      const selection = resolveSidebarSelection(
        environmentId,
        modifiers,
        getOrderedEnvironmentIds(),
        selectedEnvironmentId,
        selectedEnvironmentIds,
      );
      if (selection.type === "toggle") {
        toggleEnvironmentSelection(selection.environmentId);
        return;
      }
      if (selection.type === "range") {
        setMultiSelection(selection.ids);
        return;
      }

      // Normal click: clear multi-selection and select single environment
      if (isMobile && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      clearMultiSelection();
      const environment = allEnvironments.find((e) => e.id === selection.environmentId);
      if (environment) {
        selectProjectAndEnvironment(environment.projectId, environmentId);
        // Auto-start local environments on selection so a terminal can open
        if (
          environment.environmentType === "local" &&
          !environment.worktreePath &&
          environment.status !== "creating"
        ) {
          console.info("[HierarchicalSidebar] Auto-starting local environment:", {
            environmentId: environment.id,
            branch: environment.branch,
            status: environment.status,
            worktreePath: environment.worktreePath,
          });
          // Setup command handling (blocking, placeholder, resolve) is centralized
          // in useEnvironments.startEnvironment() for all code paths.
          startEnvironment(environment.id).catch((err) => {
            console.error("[HierarchicalSidebar] Failed to auto-start local environment:", err);
          });
        }
        // Already-started local environments resume their backend-owned setup
        // phase from the persisted environment snapshot.
      }
    },
    [
      getOrderedEnvironmentIds,
      selectedEnvironmentId,
      selectedEnvironmentIds,
      toggleEnvironmentSelection,
      setMultiSelection,
      isMobile,
      clearMultiSelection,
      allEnvironments,
      selectProjectAndEnvironment,
      startEnvironment,
    ],
  );

  // Bulk action handlers
  const handleStopSelected = async () => {
    const runningIds = selectedEnvironmentIds.filter((id) => {
      const env = allEnvironments.find((e) => e.id === id);
      return env?.status === "running" && (env.environmentType === "local" || dockerAvailable);
    });

    const results = await Promise.allSettled(runningIds.map((id) => stopEnvironment(id)));

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(`Failed to stop environment ${runningIds[index]}:`, result.reason);
      }
    });
  };

  const handleRestartSelected = async () => {
    const runningIds = selectedEnvironmentIds.filter((id) => {
      const env = allEnvironments.find((e) => e.id === id);
      return env?.status === "running" && (env.environmentType === "local" || dockerAvailable);
    });

    const results = await Promise.allSettled(runningIds.map((id) => restartEnvironment(id)));

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(`Failed to restart environment ${runningIds[index]}:`, result.reason);
      }
    });
  };

  const handleDeleteSelected = async () => {
    const idsToDelete = [...selectedEnvironmentIds];

    const results = await Promise.allSettled(idsToDelete.map((id) => deleteEnvironment(id)));

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(`Failed to delete environment ${idsToDelete[index]}:`, result.reason);
      }
    });

    // Clear all selection after deletion
    clearMultiSelection();
    setShowBulkDeleteDialog(false);
  };

  // Get environment info for bulk delete confirmation (id and name)
  const selectedEnvironmentInfo = selectedEnvironmentIds
    .map((id) => {
      const env = allEnvironments.find((e) => e.id === id);
      return env ? { id: env.id, name: env.name } : null;
    })
    .filter(Boolean) as { id: string; name: string }[];
  const hasActionableRunningSelection = selectedEnvironmentIds.some((id) => {
    const environment = allEnvironments.find((candidate) => candidate.id === id);
    return (
      environment?.status === "running" &&
      (environment.environmentType === "local" || dockerAvailable)
    );
  });

  const handleUpdateEnvironment = useMemo(
    () => createEnvironmentUpdateHandler(updateEnvironment),
    [updateEnvironment],
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

  const renderProjectGroup = (project: Project) => (
    <SortableProjectGroup
      key={project.id}
      project={project}
      environments={getProjectEnvironments(project.id)}
      isCollapsed={collapsedProjects.includes(project.id)}
      isSelected={selectedProjectId === project.id && !selectedEnvironmentId}
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
      onUpdateEnvironment={handleUpdateEnvironment}
      onCreateEnvironment={() => handleOpenCreateEnvDialog(project.id)}
      onAddToFolder={() => setFolderDialogProjectId(project.id)}
      onRemoveFromFolder={project.folder ? () => handleRemoveFromFolder(project.id) : undefined}
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

  return (
    <div className="flex h-full flex-col">
      {/* Header - switches between normal and multi-select mode */}
      <div
        data-sidebar-header
        className="flex h-12 items-center justify-between border-b border-border/80 bg-chrome pl-3 pr-2"
      >
        {isMultiSelectMode ? (
          <>
            <span className="text-sm font-medium text-foreground">
              {selectedEnvironmentIds.length} selected
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-orange-500"
                onClick={handleStopSelected}
                title="Stop selected"
                disabled={!hasActionableRunningSelection}
              >
                <Square className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={handleRestartSelected}
                title="Restart selected"
                disabled={!hasActionableRunningSelection}
              >
                <RotateCw className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={() => setShowBulkDeleteDialog(true)}
                title="Delete selected"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </>
        ) : (
          <>
            <ServerConnectionSwitcher />
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-7 w-7",
                      environmentSortMode === "activity" && "bg-zinc-800 text-foreground",
                    )}
                    title="Sort environments"
                    aria-label={`Sort environments: ${environmentSortMode === "project" ? "By project" : "By activity"}`}
                  >
                    <ArrowUpDown className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
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
                </DropdownMenuContent>
              </DropdownMenu>
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
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setShowAddProjectDialog(true)}
                title="Add project"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Projects List */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          data-testid="sidebar-list-content"
          className={environmentSortMode === "activity" && projects.length > 0 ? "pb-2" : "py-2"}
        >
          {projectsLoading && projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <FolderGit2 className="h-8 w-8 mb-2 opacity-50" />
              <p className="text-sm">Loading projects...</p>
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <FolderGit2 className="h-8 w-8 mb-2 opacity-50" />
              <p className="text-sm">No projects yet</p>
              <Button variant="link" size="sm" onClick={() => setShowAddProjectDialog(true)}>
                Add your first project
              </Button>
            </div>
          ) : environmentSortMode === "activity" ? (
            <div data-testid="activity-environment-list">
              <div
                data-testid="activity-controls-bar"
                className="sticky top-0 z-10 flex h-10 items-center border-b border-border/60 bg-sidebar/95 px-2 backdrop-blur-sm md:h-8"
              >
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-zinc-400 hover:bg-zinc-800 hover:text-foreground"
                      aria-label="Create environment"
                      title="Create environment"
                    >
                      <Plus className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      New environment in
                    </DropdownMenuLabel>
                    {projects.map((project) => (
                      <DropdownMenuItem
                        key={project.id}
                        onSelect={() => handleOpenCreateEnvDialog(project.id)}
                      >
                        <FolderGit2 className="h-4 w-4" aria-hidden="true" />
                        <span className="truncate">{project.name}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                <div className="ml-auto flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        className="flex h-7 items-center gap-1.5 rounded-md px-2 font-mono text-[11px] tabular-nums text-zinc-400"
                        aria-label={`${totalEnvironmentCount} ${
                          totalEnvironmentCount === 1 ? "environment" : "environments"
                        }`}
                      >
                        <Boxes className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
                        <span>{totalEnvironmentCount}</span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={5}>
                      Environments
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        className={cn(
                          "flex h-7 min-w-9 items-center justify-center gap-1.5 rounded-md px-2 font-mono text-[11px] tabular-nums",
                          waitingEnvironmentCount > 0
                            ? "bg-amber-500/10 text-amber-400"
                            : "text-zinc-600",
                        )}
                        aria-label={`${waitingEnvironmentCount} waiting ${
                          waitingEnvironmentCount === 1 ? "environment" : "environments"
                        }`}
                      >
                        <Bell
                          className={cn(
                            "h-3.5 w-3.5",
                            waitingEnvironmentCount > 0 && "fill-amber-400/20",
                          )}
                          aria-hidden="true"
                        />
                        <span>{waitingEnvironmentCount}</span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={5}>
                      Waiting environments
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
              {activityEnvironments.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No environments yet
                </div>
              ) : (
                <div data-testid="activity-environment-rows" className="px-1 pt-2">
                  {activityEnvironments.map((environment, position) => (
                    <AnimatedActivityRow
                      key={environment.id}
                      environmentId={environment.id}
                      position={position}
                      className={cn(
                        "mx-1 flex items-center rounded-lg border border-transparent transition-colors will-change-transform",
                        selectedEnvironmentId === environment.id && !isMultiSelectMode
                          ? "relative overflow-hidden bg-linear-to-r from-selected to-selected-edge text-selected-foreground before:absolute before:inset-y-1 before:left-1 before:w-0.5 before:rounded-full before:bg-primary"
                          : "hover:bg-hover",
                      )}
                    >
                      <div className="min-w-0 flex-1 pl-2">
                        <EnvironmentItem
                          environment={environment}
                          subtitle={
                            projectsById.get(environment.projectId)?.name ?? "Unknown project"
                          }
                          isSelected={selectedEnvironmentId === environment.id}
                          onSelect={handleSelectEnvironment}
                          onDelete={deleteEnvironment}
                          onStart={startEnvironment}
                          onStop={stopEnvironment}
                          onRestart={restartEnvironment}
                          onUpdate={handleUpdateEnvironment}
                          isMultiSelectMode={isMultiSelectMode}
                          isChecked={selectedEnvironmentIds.includes(environment.id)}
                        />
                      </div>
                    </AnimatedActivityRow>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={projectSortableItems} strategy={verticalListSortingStrategy}>
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
                      onUngroup={() => handleUngroupFolder(entry.name)}
                    >
                      {entry.projects.map(renderProjectGroup)}
                    </SortableProjectFolder>
                  ),
                )}
                <SidebarRootDropZone active={activeType === "project"} />
              </SortableContext>

              {/* Drag overlay for visual feedback */}
              <DragOverlay>
                {activeProject && (
                  <div className="rounded-md bg-card border border-border px-3 py-2 shadow-lg">
                    <div className="flex items-center gap-2">
                      <FolderGit2 className="h-4 w-4" />
                      <span className="text-sm font-medium">{activeProject.name}</span>
                    </div>
                  </div>
                )}
                {activeFolder && (
                  <div className="rounded-md bg-card border border-border px-3 py-2 shadow-lg">
                    <div className="flex items-center gap-2">
                      <Folder className="h-4 w-4 text-amber-400/80" aria-hidden="true" />
                      <span className="text-sm font-medium">{activeFolder.name}</span>
                    </div>
                  </div>
                )}
                {activeEnvironment && (
                  <div className="rounded-md bg-card border border-border px-3 py-2 shadow-lg">
                    <span className="text-sm">{activeEnvironment.name}</span>
                  </div>
                )}
              </DragOverlay>
            </DndContext>
          )}
        </div>
      </div>

      {/* Add Project Dialog */}
      <AddProjectDialog
        open={showAddProjectDialog}
        onOpenChange={setShowAddProjectDialog}
        onAdd={handleAddProject}
        onCreate={handleCreateProject}
        validateGitUrl={validateGitUrl}
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
            <AlertDialogTitle>Delete {selectedEnvironmentIds.length} Environments</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>Are you sure you want to delete the following environments?</p>
                <ul className="mt-2 list-disc list-inside text-foreground">
                  {selectedEnvironmentInfo.map(({ id, name }) => (
                    <li key={id}>{name}</li>
                  ))}
                </ul>
                <p className="mt-2 text-orange-500">
                  This action cannot be undone. Running environments will be stopped first.
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
