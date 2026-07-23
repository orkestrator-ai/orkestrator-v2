import { useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
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
import { ArrowUpDown, Bell, Boxes, Plus, FolderGit2, Square, Trash2, RotateCw, RefreshCw } from "lucide-react";
import { SortableProjectGroup } from "./SortableProjectGroup";
import { AddProjectDialog } from "@/components/projects/AddProjectDialog";
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
import { useEnvironmentListPolling } from "@/hooks/useEnvironmentListPolling";
import { useUIStore } from "@/stores";
import { RepositorySettings } from "@/components/settings/RepositorySettings";
import { useEnvironmentDiffStats } from "@/hooks/useEnvironmentDiffStats";
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

export type SidebarReorderResult =
  | { type: "project"; ids: string[] }
  | { type: "environment"; projectId: string; ids: string[] };

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
  if (
    offset !== 0 &&
    !reduceMotion &&
    typeof element.animate === "function"
  ) {
    animation = element.animate(
      [
        { transform: `translateY(${offset}px)` },
        { transform: "translateY(0)" },
      ],
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
    if (
      activeAnimation &&
      activeAnimation.playState === "running"
    ) {
      // Preserve the row's current visual position when activity changes again
      // before the prior movement finishes. Cancelling first would otherwise
      // make the row jump to its new layout position.
      const parentTop = row.parentElement?.getBoundingClientRect().top ?? 0;
      const transformedTop = row.getBoundingClientRect().top - parentTop;
      activeAnimation.cancel();
      const layoutTop = row.getBoundingClientRect().top - parentTop;
      previousTop = (previousTopRef.current ?? layoutTop) + (transformedTop - layoutTop);
    }

    const reduceMotion = typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const result = animateActivityRowMovement(
      row,
      previousTop,
      reduceMotion,
    );
    previousTopRef.current = result.top;
    previousPositionRef.current = position;
    animationRef.current = result.animation;
  });

  return (
    <div
      ref={rowRef}
      data-environment-id={environmentId}
      className={className}
    >
      {children}
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

export function resolveSidebarReorder(
  activeId: string,
  overId: string,
  activeType: "project" | "environment" | null,
  projects: Project[],
  environments: Environment[],
): SidebarReorderResult | null {
  if (activeId === overId) return null;
  if (activeType === "project") {
    const oldIndex = projects.findIndex((project) => project.id === activeId);
    const newIndex = projects.findIndex((project) => project.id === overId);
    if (oldIndex === -1 || newIndex === -1) return null;
    const reordered = [...projects];
    const [removed] = reordered.splice(oldIndex, 1);
    if (!removed) return null;
    reordered.splice(newIndex, 0, removed);
    return { type: "project", ids: reordered.map((project) => project.id) };
  }
  if (activeType === "environment") {
    const activeEnvironment = environments.find((environment) => environment.id === activeId);
    const overEnvironment = environments.find((environment) => environment.id === overId);
    if (!activeEnvironment || !overEnvironment || activeEnvironment.projectId !== overEnvironment.projectId) {
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
  // Poll git diff stats for all environments
  useEnvironmentDiffStats();
  const [showAddProjectDialog, setShowAddProjectDialog] = useState(false);
  const [showCreateEnvDialog, setShowCreateEnvDialog] = useState(false);
  const [createEnvProjectId, setCreateEnvProjectId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<"project" | "environment" | null>(null);
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null);

  const { projects, addProject, removeProject, updateProject, reorderProjects, validateGitUrl, isLoading: projectsLoading } = useProjects();
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

  useEnvironmentListPolling(
    projects.map((project) => project.id),
    (projectId) => loadEnvironments(projectId, { silent: true, reconcileStatus: false }),
  );

  const {
    selectedProjectId,
    selectedEnvironmentId,
    selectProject,
    selectProjectAndEnvironment,
    collapsedProjects,
    toggleProjectCollapse,
    selectedEnvironmentIds,
    toggleEnvironmentSelection,
    setMultiSelection,
    clearMultiSelection,
    collapseEmptyProjects,
    environmentSortMode,
    setEnvironmentSortMode,
    unreadEnvironmentIds,
  } = useUIStore();

  const activityEnvironments = useMemo(
    () => sortEnvironmentsByActivity(allEnvironments, projects),
    [allEnvironments, projects],
  );
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const totalEnvironmentCount = activityEnvironments.length;
  const waitingEnvironmentCount = useMemo(() => {
    const environmentIds = new Set(allEnvironments.map((environment) => environment.id));
    return unreadEnvironmentIds.filter((id) => environmentIds.has(id)).length;
  }, [allEnvironments, unreadEnvironmentIds]);

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
      projectsWithEnvs
    );
    initialCollapseAppliedRef.current = true;
  }, [projects, allEnvironments, collapseEmptyProjects]);

  // Get environments for a specific project
  const getProjectEnvironments = useCallback(
    (projectId: string): Environment[] => {
      return allEnvironments
        .filter((e) => e.projectId === projectId)
        .sort((a, b) => a.order - b.order);
    },
    [allEnvironments]
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
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    setActiveId(active.id as string);

    // Determine if we're dragging a project or environment
    const isProject = projects.some((p) => p.id === active.id);
    setActiveType(isProject ? "project" : "environment");
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setActiveType(null);

    if (!over) return;
    const reorder = resolveSidebarReorder(
      String(active.id),
      String(over.id),
      activeType,
      projects,
      allEnvironments,
    );
    try {
      if (reorder?.type === "project") await reorderProjects(reorder.ids);
      if (reorder?.type === "environment") await reorderEnvironments(reorder.projectId, reorder.ids);
    } catch (err) {
      console.error("Failed to persist sidebar reorder:", err);
    }
  };

  const handleAddProject = async (gitUrl: string, localPath?: string) => {
    try {
      await addProject(gitUrl, localPath);
    } catch (err) {
      console.error("Failed to add project:", err);
      throw err; // Re-throw so the dialog can handle it
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
    for (const project of projects) {
      // Skip collapsed projects - their environments aren't visible
      if (collapsedProjects.includes(project.id)) {
        continue;
      }
      const projectEnvs = getProjectEnvironments(project.id);
      for (const env of projectEnvs) {
        orderedIds.push(env.id);
      }
    }
    return orderedIds;
  }, [activityEnvironments, environmentSortMode, projects, getProjectEnvironments, collapsedProjects]);

  const handleSelectEnvironment = (
    environmentId: string,
    modifiers: { shiftKey?: boolean; metaKey?: boolean } = {}
  ) => {
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
        startEnvironment(environment.id)
          .catch((err) => {
            console.error("[HierarchicalSidebar] Failed to auto-start local environment:", err);
          });
      }
      // Already-started local environments: TerminalContainer's effect decides
      // whether to auto-resolve (setup previously complete) or re-run setup
      // (previously incomplete). Persisted `setupScriptsComplete` also seeds
      // `setupCommandsResolved` during env hydration in the store.
    }
  };

  // Bulk action handlers
  const handleStopSelected = async () => {
    const runningIds = selectedEnvironmentIds.filter((id) => {
      const env = allEnvironments.find((e) => e.id === id);
      return env?.status === "running";
    });

    const results = await Promise.allSettled(
      runningIds.map((id) => stopEnvironment(id))
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(`Failed to stop environment ${runningIds[index]}:`, result.reason);
      }
    });
  };

  const handleRestartSelected = async () => {
    const runningIds = selectedEnvironmentIds.filter((id) => {
      const env = allEnvironments.find((e) => e.id === id);
      return env?.status === "running";
    });

    const results = await Promise.allSettled(
      runningIds.map((id) => restartEnvironment(id))
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(`Failed to restart environment ${runningIds[index]}:`, result.reason);
      }
    });
  };

  const handleDeleteSelected = async () => {
    const idsToDelete = [...selectedEnvironmentIds];

    const results = await Promise.allSettled(
      idsToDelete.map((id) => deleteEnvironment(id))
    );

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

  const handleUpdateEnvironment = (environment: Environment) => {
    updateEnvironment(environment.id, environment);
  };

  const handleOpenSettings = (projectId: string) => {
    setSettingsProjectId(projectId);
    setShowSettingsDialog(true);
  };

  const handleUpdateProject = async (project: Project) => {
    await updateProject(project);
  };

  // Get the project for the settings dialog
  const settingsProject = settingsProjectId
    ? projects.find((p) => p.id === settingsProjectId)
    : null;

  // Get the active item for drag overlay
  const activeProject = activeType === "project" ? projects.find((p) => p.id === activeId) : null;
  const activeEnvironment = activeType === "environment" ? allEnvironments.find((e) => e.id === activeId) : null;

  return (
    <div className="flex h-full flex-col">
      {/* Header - switches between normal and multi-select mode */}
      <div data-sidebar-header className="flex h-12 items-center justify-between border-b border-border/80 bg-[#212124] pl-3 pr-2">
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
              >
                <Square className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={handleRestartSelected}
                title="Restart selected"
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
        <div className="py-2">
          {projectsLoading && projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <FolderGit2 className="h-8 w-8 mb-2 opacity-50" />
              <p className="text-sm">Loading projects...</p>
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <FolderGit2 className="h-8 w-8 mb-2 opacity-50" />
              <p className="text-sm">No projects yet</p>
              <Button
                variant="link"
                size="sm"
                onClick={() => setShowAddProjectDialog(true)}
              >
                Add your first project
              </Button>
            </div>
          ) : environmentSortMode === "activity" ? (
            <div data-testid="activity-environment-list">
              <div className="sticky top-0 z-10 mb-1 flex h-9 items-center border-b border-border/60 bg-[#1d1d20]/95 px-2 backdrop-blur-sm">
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
                <div className="space-y-0.5 px-1">
                  {activityEnvironments.map((environment, position) => (
                    <AnimatedActivityRow
                      key={environment.id}
                      environmentId={environment.id}
                      position={position}
                      className={cn(
                        "mx-1 flex items-center rounded-lg border transition-colors will-change-transform",
                        selectedEnvironmentId === environment.id && !isMultiSelectMode
                          ? "border-zinc-700/70 bg-zinc-800/85"
                          : "border-transparent hover:bg-zinc-800/55",
                      )}
                    >
                      <div className="min-w-0 flex-1 pl-2">
                        <EnvironmentItem
                          environment={environment}
                          subtitle={projectsById.get(environment.projectId)?.name ?? "Unknown project"}
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
              <SortableContext
                items={projects.map((p) => p.id)}
                strategy={verticalListSortingStrategy}
              >
                {projects.map((project) => (
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
                    isMultiSelectMode={isMultiSelectMode}
                    selectedEnvironmentIds={selectedEnvironmentIds}
                  />
                ))}
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
        validateGitUrl={validateGitUrl}
      />

      {/* Create Environment Dialog */}
      <CreateEnvironmentFlowDialog
        open={showCreateEnvDialog}
        onOpenChange={(open) => {
          setShowCreateEnvDialog(open);
          if (!open) setCreateEnvProjectId(null);
        }}
        projectId={createEnvProjectId}
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
      {settingsProject && (
        <RepositorySettings
          project={settingsProject}
          open={showSettingsDialog}
          onOpenChange={setShowSettingsDialog}
          onUpdateProject={handleUpdateProject}
        />
      )}
    </div>
  );
}
