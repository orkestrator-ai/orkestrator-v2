import { useState, useEffect, useCallback, useRef } from "react";
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
import { Plus, FolderGit2, Square, Trash2, RotateCw } from "lucide-react";
import { SortableProjectGroup } from "./SortableProjectGroup";
import { AddProjectDialog } from "@/components/projects/AddProjectDialog";
import { CreateEnvironmentDialog, type ClaudeOptions } from "@/components/environments/CreateEnvironmentDialog";
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
import { useUIStore, useClaudeOptionsStore, useConfigStore } from "@/stores";
import { RepositorySettings } from "@/components/settings/RepositorySettings";
import { renameEnvironmentFromPrompt, updateEnvironmentAgentSettings } from "@/lib/backend";
import { useEnvironmentDiffStats } from "@/hooks/useEnvironmentDiffStats";
import type { Environment, Project } from "@/types";

export function HierarchicalSidebar() {
  // Poll git diff stats for all environments
  useEnvironmentDiffStats();
  const [showAddProjectDialog, setShowAddProjectDialog] = useState(false);
  const [showCreateEnvDialog, setShowCreateEnvDialog] = useState(false);
  const [createEnvProjectId, setCreateEnvProjectId] = useState<string | null>(null);
  const [isCreatingEnv, setIsCreatingEnv] = useState(false);
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
    setProjectCollapsed,
  } = useUIStore();

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

  const { setOptions } = useClaudeOptionsStore();
  // Subscribe to config to ensure re-render when config loads from backend
  const { config } = useConfigStore();

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
          await loadEnvironments(project.id);
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

    if (!over || active.id === over.id) return;

    if (activeType === "project") {
      // Reorder projects
      const oldIndex = projects.findIndex((p) => p.id === active.id);
      const newIndex = projects.findIndex((p) => p.id === over.id);

      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = [...projects];
        const removed = newOrder.splice(oldIndex, 1)[0];
        if (removed) {
          newOrder.splice(newIndex, 0, removed);
          await reorderProjects(newOrder.map((p) => p.id));
        }
      }
    } else if (activeType === "environment") {
      // Find which project the active environment belongs to
      const activeEnv = allEnvironments.find((e) => e.id === active.id);
      const overEnv = allEnvironments.find((e) => e.id === over.id);

      if (activeEnv && overEnv && activeEnv.projectId === overEnv.projectId) {
        // Same project - reorder within project
        const projectId = activeEnv.projectId;
        const projectEnvs = getProjectEnvironments(projectId);

        const oldIndex = projectEnvs.findIndex((e) => e.id === active.id);
        const newIndex = projectEnvs.findIndex((e) => e.id === over.id);

        if (oldIndex !== -1 && newIndex !== -1) {
          const newOrder = [...projectEnvs];
          const removed = newOrder.splice(oldIndex, 1)[0];
          if (removed) {
            newOrder.splice(newIndex, 0, removed);
            await reorderEnvironments(projectId, newOrder.map((e) => e.id));
          }
        }
      }
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
    // First delete all environments for this project
    const projectEnvs = getProjectEnvironments(projectId);
    const failedEnvs: string[] = [];

    for (const env of projectEnvs) {
      try {
        await deleteEnvironment(env.id);
      } catch (err) {
        console.error(`Failed to delete environment ${env.name}:`, err);
        failedEnvs.push(env.name);
      }
    }

    if (failedEnvs.length > 0) {
      console.error(`Failed to delete environments: ${failedEnvs.join(", ")}. Project deletion aborted.`);
      throw new Error(`Failed to delete some environments: ${failedEnvs.join(", ")}`);
    }

    try {
      await removeProject(projectId);
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

  const handleCreateEnvironment = async (options: ClaudeOptions) => {
    if (!createEnvProjectId) return;

    setIsCreatingEnv(true);
    try {
      const environment = await createEnvironment(
        createEnvProjectId,
        options.environmentName || undefined,
        options.networkAccessMode,
        options.initialPrompt || undefined,
        options.portMappings.length > 0 ? options.portMappings : undefined,
        options.environmentType
      );

      const configuredEnvironment = await updateEnvironmentAgentSettings(
        environment.id,
        options.agentType,
        options.agentType === "claude" ? options.claudeMode : null,
        null,
        options.agentType === "opencode" ? options.opencodeMode : null,
        options.agentType === "codex" ? options.codexMode : null,
      );
      updateEnvironment(environment.id, configuredEnvironment);

      // Store agent options for this environment (needed for terminal to know tab type)
      setOptions(configuredEnvironment.id, {
        launchAgent: options.launchAgent,
        agentType: options.agentType,
        initialPrompt: options.initialPrompt,
        initialPromptAttachments: options.initialPromptAttachments,
      });

      // Expand the project if collapsed so the new environment is visible
      setProjectCollapsed(createEnvProjectId, false);

      // Always select the newly created environment
      selectProjectAndEnvironment(createEnvProjectId, configuredEnvironment.id);

      setShowCreateEnvDialog(false);
      setCreateEnvProjectId(null);

      // Auto-start after the environment is visible. Local startup creates the
      // worktree and may fetch from the remote, so it should not keep the modal
      // open or hide the newly-created environment. Naming runs only after
      // start has been initiated so a slow LLM rename never leaves the user on
      // the stopped-environment overlay.
      const initialPromptForNaming = options.initialPrompt.trim();
      const shouldRenameFromInitialPrompt = !options.environmentName.trim() && initialPromptForNaming.length > 0;
      void (async () => {
        try {
          await startEnvironment(configuredEnvironment.id, options.initialPrompt);
        } catch (startErr) {
          console.error("Failed to auto-start environment:", startErr);
          // Environment was created successfully, user can manually start it.
          return;
        }

        if (shouldRenameFromInitialPrompt) {
          try {
            await renameEnvironmentFromPrompt(configuredEnvironment.id, initialPromptForNaming);
          } catch (renameErr) {
            console.error("Failed to rename environment from initial prompt:", renameErr);
          }
        }
      })();
    } finally {
      setIsCreatingEnv(false);
    }
  };

  // Build a flat ordered list of visible environment IDs in display order
  // Only includes environments from expanded (non-collapsed) projects
  const getOrderedEnvironmentIds = useCallback((): string[] => {
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
  }, [projects, getProjectEnvironments, collapsedProjects]);

  const handleSelectEnvironment = (
    environmentId: string,
    modifiers: { shiftKey?: boolean; metaKey?: boolean } = {}
  ) => {
    const { shiftKey, metaKey } = modifiers;

    if (shiftKey) {
      // Shift+Click: range selection from anchor (selectedEnvironmentId or last in selection) to clicked
      const orderedIds = getOrderedEnvironmentIds();
      const clickedIndex = orderedIds.indexOf(environmentId);

      if (clickedIndex === -1) {
        // Clicked environment not found in ordered list, just toggle it
        toggleEnvironmentSelection(environmentId);
        return;
      }

      // Determine anchor: use currently selected environment or first item in multi-selection
      const anchorId = selectedEnvironmentId || selectedEnvironmentIds[0];

      if (!anchorId) {
        // No anchor, start fresh selection with just the clicked item
        setMultiSelection([environmentId]);
        return;
      }

      const anchorIndex = orderedIds.indexOf(anchorId);

      if (anchorIndex === -1) {
        // Anchor not found, start fresh with clicked item
        setMultiSelection([environmentId]);
        return;
      }

      // Select range between anchor and clicked (inclusive)
      const startIndex = Math.min(anchorIndex, clickedIndex);
      const endIndex = Math.max(anchorIndex, clickedIndex);
      const rangeIds = orderedIds.slice(startIndex, endIndex + 1);

      setMultiSelection(rangeIds);
    } else if (metaKey) {
      // Cmd/Ctrl+Click: toggle individual item in selection
      toggleEnvironmentSelection(environmentId);
    } else {
      // Normal click: clear multi-selection and select single environment
      clearMultiSelection();
      const environment = allEnvironments.find((e) => e.id === environmentId);
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
      <div className="flex h-12 items-center justify-between border-b border-border/80 bg-[#212124] pl-3 pr-2">
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
            <span className="text-sm font-medium text-foreground">Projects</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setShowAddProjectDialog(true)}
              title="Add project"
            >
              <Plus className="h-4 w-4" />
            </Button>
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
      <CreateEnvironmentDialog
        open={showCreateEnvDialog}
        onOpenChange={setShowCreateEnvDialog}
        onCreate={handleCreateEnvironment}
        isLoading={isCreatingEnv}
        projectId={createEnvProjectId}
        defaultPortMappings={
          createEnvProjectId
            ? config.repositories[createEnvProjectId]?.defaultPortMappings
            : undefined
        }
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
