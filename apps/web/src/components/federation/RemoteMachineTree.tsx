import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { projectLandingBoardTab, type RealmGrouping } from "@/lib/federation/workspace-realm";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronRight,
  Container,
  Copy,
  FolderInput,
  FolderMinus,
  GripVertical,
  Laptop,
  LayoutGrid,
  Link2,
  Loader2,
  MoreVertical,
  PanelRight,
  Play,
  Plus,
  RotateCw,
  Settings2,
  Square,
  Trash2,
} from "lucide-react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { GithubIcon } from "@/components/icons/GithubIcon";
import { AddToFolderDialog } from "@/components/projects/AddToFolderDialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  EnvironmentChangeBadge,
  EnvironmentChangeSummary,
  EnvironmentMenuItems,
  type EnvironmentMenuItem,
} from "@/components/environments/EnvironmentItem";
import { EnvironmentAgentSummary } from "@/components/environments/EnvironmentAgentSummary";
import { EnvironmentStatusMarker } from "@/components/environments/EnvironmentStatusMarker";
import { EnvironmentTooltipBody } from "@/components/environments/EnvironmentTooltipBody";
import { MergeReadyMarker, MergeReadyName } from "@/components/environments/MergeReadyName";
import { isNodeEnvironmentReadyToMerge } from "@/lib/pr-merge-readiness";
import { HoverTooltipContent, useHoverTooltip } from "@/components/ui/hover-tooltip";
import { UnreadBellIcon } from "@/components/environments/UnreadBellIcon";
import { SortableProjectFolder } from "@/components/sidebar/SortableProjectFolder";
import { SidebarRootDropZone } from "@/components/sidebar/SidebarRootDropZone";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { getGitHubRepositoryUrl } from "@/lib/gitUrl";
import { isMachineWritable, type MachineView } from "@/lib/federation/aggregate";
import { useNodeEnvironmentChangeProjection } from "@/lib/federation/node-change-projections";
import {
  nodeAgentSummarySource,
  useNodeEnvironment,
} from "@/lib/federation/node-environment-reads";
import { useStore } from "zustand";
import { useProjectCopyStore } from "@/stores/projectCopyStore";
import { remoteOrdersFor } from "@/lib/federation/remote-order-writes";
import { remoteProjectsFor, withArrangement } from "@/lib/federation/remote-project-writes";
import { moveId, withOrder } from "@/lib/federation/remote-order";
import type { FederatedEnvironment, FederatedProject } from "@/lib/federation/summaries";
import {
  buildProjectTree,
  listProjectFolderNames,
  normalizeProjectFolderName,
  parseProjectFolderDragId,
  projectFolderKey,
  projectSortableIds,
  resolveAddProjectToFolder,
  resolveProjectArrangement,
  resolveRemoveProjectFromFolder,
  resolveRenameProjectFolder,
  resolveSortProjectFolder,
  resolveUngroupProjectFolder,
  type ProjectArrangement,
} from "@/lib/project-folders";
import { OutcomeUnknownError } from "@/lib/portal/portal-store";
import { cn } from "@/lib/utils";
import { sidebarCollisionDetection } from "@/lib/sidebar-collision";
import { sidebarFolderKey, useMachineViewStore } from "@/stores/machineViewStore";
import {
  useRemoteEnvironmentShown,
  useRemoteProjectHomeShown,
} from "@/stores/remoteWorkspaceStore";
import { SELECTED_ENVIRONMENT_ROW_CLASS } from "@/components/sidebar/SortableEnvironmentItem";
import { useFederation } from "./FederationProvider";
import { MachineDot, MachineHomeIcon, machineStatusText } from "./MachineDot";
import {
  newFederatedEnvironment,
  useFederatedEnvironmentActions,
} from "./useFederatedEnvironmentActions";

const NO_ENVIRONMENTS: readonly FederatedEnvironment[] = [];
/** Matches `EnvironmentItem`: below this width rows get an explicit actions button. */
const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

const ACTIVITY_TEXT: Record<FederatedEnvironment["activity"], string> = {
  working: "Working",
  waiting: "Awaiting input",
  idle: "Idle",
};

/**
 * Opens a public web page on this client. No node is involved, so this skips
 * the backend's `open_in_browser`, which the window's workspace (possibly a
 * leaf) would run.
 */
function openWebPage(url: string): void {
  const openExternal = window.orkestrator?.shell?.openExternal;
  if (openExternal) {
    void openExternal(url).catch(() => toast.error("Could not open repository in browser."));
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function reportWriteError(machine: MachineView, what: string, error: unknown): void {
  if (error instanceof OutcomeUnknownError) {
    toast.warning(`${what}: outcome unknown on ${machine.name}`, {
      description: error.message,
    });
  } else {
    toast.error(`Could not ${what.toLowerCase()} on ${machine.name}`, {
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A project of another machine as the folder arrangement sees it: its key is its drag id. */
interface RemoteProjectItem {
  id: string;
  name: string;
  folder?: string;
  project: FederatedProject;
}

function remoteProjectItems(projects: readonly FederatedProject[]): RemoteProjectItem[] {
  return projects.map((project) => ({
    id: project.key,
    name: project.name,
    ...(project.folder ? { folder: project.folder } : {}),
    project,
  }));
}

/**
 * Another machine's environment order, with the drags this client sent and
 * the owner has not reflected yet. A drag is written to the owner.
 */
export function useRemoteEnvironments() {
  const { portal } = useFederation();
  const orderWrites = useMemo(() => remoteOrdersFor(portal), [portal]);
  const orders = useStore(orderWrites.store);

  const environmentsOf = useCallback(
    (machine: MachineView, project: FederatedProject) =>
      withOrder(
        (machine.environmentsByProject.get(project.ref.projectId) ?? NO_ENVIRONMENTS)
          .filter((environment) => !environment.isProjectHome)
          .sort((left, right) => left.order - right.order),
        orders.get(project.key),
        (environment) => environment.ref.environmentId,
      ),
    [orders],
  );

  /** Persists dragging environment `activeKey` onto `overKey`; false when neither is in `project`. */
  const reorder = useCallback(
    (machine: MachineView, project: FederatedProject, activeKey: string, overKey: string) => {
      const visible = environmentsOf(machine, project);
      const keys = moveId(
        visible.map((environment) => environment.key),
        activeKey,
        overKey,
      );
      if (!keys) return false;
      const idByKey = new Map(visible.map((environment) => [environment.key, environment]));
      const ids = keys.map((key) => idByKey.get(key)!.ref.environmentId);
      // Reorder only visible slots; home rows keep their owner position and are
      // included in the whole-project payload so the owner never appends them.
      let nextVisible = 0;
      const allIds = [
        ...(machine.environmentsByProject.get(project.ref.projectId) ?? NO_ENVIRONMENTS),
      ]
        .sort((left, right) => left.order - right.order)
        .map((environment) =>
          environment.isProjectHome ? environment.ref.environmentId : ids[nextVisible++]!,
        );
      orderWrites.submit(project.ref, allIds, (error: unknown) =>
        reportWriteError(machine, "Reorder environments", error),
      );
      return true;
    },
    [environmentsOf, orderWrites],
  );

  return { environmentsOf, reorder };
}

/** Whether a drag id is one of `projects`' environments, and in which project. */
export function remoteEnvironmentProject(
  machine: MachineView,
  projects: readonly FederatedProject[],
  environmentKey: string,
): FederatedProject | null {
  for (const project of projects) {
    const environments = machine.environmentsByProject.get(project.ref.projectId) ?? [];
    if (environments.some((environment) => environment.key === environmentKey)) return project;
  }
  return null;
}

/**
 * Another machine's projects and environments, laid out like this window's
 * own sidebar: the owner's folders, project order and environment order.
 * Projects, folders and environments can be dragged as on the owner's own
 * sidebar; the result is written to the owner, never to this machine.
 */
export function RemoteMachineTree({ machine }: { machine: MachineView }) {
  const { portal } = useFederation();
  const collapsedProjectKeys = useMachineViewStore((state) => state.collapsedProjectKeys);
  const collapsedFolderKeys = useMachineViewStore((state) => state.collapsedFolderKeys);
  const setProjectKeyCollapsed = useMachineViewStore((state) => state.setProjectKeyCollapsed);
  const setFolderKeyCollapsed = useMachineViewStore((state) => state.setFolderKeyCollapsed);
  const projectWrites = useMemo(() => remoteProjectsFor(portal), [portal]);
  const arrangements = useStore(projectWrites.store);
  const { environmentsOf, reorder } = useRemoteEnvironments();
  const [dragging, setDragging] = useState<"project" | "other" | null>(null);
  const [folderDialogKey, setFolderDialogKey] = useState<string | null>(null);
  const writable = isMachineWritable(machine);
  const sortable = writable && !machine.truncated;

  const projects = useMemo(
    () => withArrangement(machine.projects, arrangements.get(machine.backendId)),
    [arrangements, machine.backendId, machine.projects],
  );
  const items = useMemo(() => remoteProjectItems(projects), [projects]);
  const tree = useMemo(() => buildProjectTree(items), [items]);
  const folderCollapseKey = (name: string) =>
    sidebarFolderKey(machine.backendId, projectFolderKey(name));
  const isFolderCollapsed = (name: string) => collapsedFolderKeys.includes(folderCollapseKey(name));
  const sortableIds = projectSortableIds(tree, [], isFolderCollapsed);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const arrange = (arrangement: ProjectArrangement | null) => {
    if (!sortable || !arrangement) return;
    const byKey = new Map(items.map((item) => [item.id, item.project.ref.projectId]));
    const folders: Record<string, string | null> = {};
    for (const [key, folder] of Object.entries(arrangement.folders)) {
      const projectId = byKey.get(key);
      if (projectId) folders[projectId] = folder;
    }
    projectWrites.submit(
      machine.backendId as BackendId,
      {
        projectIds: arrangement.projectIds.flatMap((key) => byKey.get(key) ?? []),
        folders,
      },
      (error: unknown) => reportWriteError(machine, "Arrange projects", error),
    );
  };

  const handleDragStart = ({ active }: DragStartEvent) => {
    const id = String(active.id);
    setDragging(
      parseProjectFolderDragId(id) !== null || items.some((item) => item.id === id)
        ? "project"
        : "other",
    );
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!sortable || !over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (parseProjectFolderDragId(activeId) !== null || items.some((item) => item.id === activeId)) {
      arrange(resolveProjectArrangement(activeId, overId, items));
      return;
    }
    // Environments never move between projects, so both rows share one.
    const project = remoteEnvironmentProject(machine, projects, activeId);
    if (project) reorder(machine, project, activeId, overId);
  };

  const folderDialogItem = folderDialogKey
    ? (items.find((item) => item.id === folderDialogKey) ?? null)
    : null;

  const renderProject = (item: RemoteProjectItem) => (
    <RemoteProjectGroup
      key={item.id}
      machine={machine}
      project={item.project}
      environments={environmentsOf(machine, item.project)}
      isCollapsed={collapsedProjectKeys.includes(item.id)}
      onToggleCollapse={() => setProjectKeyCollapsed(item.id)}
      sortable={sortable}
      grouping="machine"
      {...(sortable
        ? {
            onAddToFolder: () => setFolderDialogKey(item.id),
            ...(item.folder
              ? {
                  onRemoveFromFolder: () => arrange(resolveRemoveProjectFromFolder(items, item.id)),
                }
              : {}),
          }
        : {})}
    />
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sidebarCollisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        {tree.map((entry) => {
          if (entry.kind === "project") return renderProject(entry.project);
          const folderActions = sortable
            ? {
                onRename: (nextName: string) => {
                  const normalized = normalizeProjectFolderName(nextName);
                  if (!normalized) return;
                  const collapsed = isFolderCollapsed(entry.name);
                  arrange(resolveRenameProjectFolder(items, entry.name, nextName));
                  setFolderKeyCollapsed(folderCollapseKey(entry.name), false);
                  setFolderKeyCollapsed(folderCollapseKey(normalized), collapsed);
                },
                onSort: () => arrange(resolveSortProjectFolder(items, entry.name)),
                onUngroup: () => arrange(resolveUngroupProjectFolder(items, entry.name)),
              }
            : {};
          return (
            <SortableProjectFolder
              key={`folder:${entry.key}`}
              name={entry.name}
              projectCount={entry.projects.length}
              isCollapsed={isFolderCollapsed(entry.name)}
              onToggleCollapse={() => setFolderKeyCollapsed(folderCollapseKey(entry.name))}
              {...folderActions}
            >
              {entry.projects.map(renderProject)}
            </SortableProjectFolder>
          );
        })}
        <SidebarRootDropZone active={dragging === "project"} />
      </SortableContext>
      <AddToFolderDialog
        open={folderDialogItem !== null}
        onOpenChange={(open) => {
          if (!open) setFolderDialogKey(null);
        }}
        projectName={folderDialogItem?.name ?? ""}
        currentFolder={folderDialogItem?.folder ?? null}
        existingFolders={listProjectFolderNames(items)}
        onSubmit={(folderName) => {
          if (!folderDialogItem) return;
          arrange(resolveAddProjectToFolder(items, folderDialogItem.id, folderName));
          // A folder the user just filed something into has to be visible,
          // otherwise the project appears to have vanished from the sidebar.
          const normalized = normalizeProjectFolderName(folderName);
          if (normalized) setFolderKeyCollapsed(folderCollapseKey(normalized), false);
        }}
      />
    </DndContext>
  );
}

/**
 * A project of another machine, drawn like `SortableProjectGroup`. Its drag id
 * is its node-qualified key, so it can share a list with other machines'.
 */
export function RemoteProjectGroup({
  machine,
  project,
  environments,
  isCollapsed,
  onToggleCollapse,
  sortable,
  grouping,
  showMachine,
  label = project.name,
  labelClassName,
  onAddToFolder,
  onRemoveFromFolder,
}: {
  machine: MachineView;
  project: FederatedProject;
  environments: readonly FederatedEnvironment[];
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  sortable: boolean;
  /** How the window's sidebar groups the list this row is in; decides where it opens. */
  grouping: RealmGrouping;
  /** Mark the machine with a home before the name, in lists that mix machines. */
  showMachine?: boolean;
  /** Shown instead of the project name (a repository group names the machine). */
  label?: string;
  labelClassName?: string;
  /** Opens the folder composer for this project; omitted where folders are not arranged. */
  onAddToFolder?: () => void;
  /** Lifts this project back out to the root level; omitted when it has no folder. */
  onRemoveFromFolder?: () => void;
}) {
  const writable = isMachineWritable(machine);
  const githubRepositoryUrl = project.repositoryHint
    ? getGitHubRepositoryUrl(`https://${project.repositoryHint}`)
    : null;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.key,
    disabled: !sortable,
  });
  // Chosen in the project search: highlighted like a selected project, and
  // scrolled into view each time it is chosen.
  const revealRevision = useMachineViewStore((state) =>
    state.revealedProject?.key === project.key ? state.revealedProject.revision : null,
  );
  const revealed = revealRevision !== null;
  // Shown with its home or nothing else, as this window's own project rows are.
  const homeId = machine.environmentsByProject
    .get(project.ref.projectId)
    ?.find((environment) => environment.isProjectHome)?.ref.environmentId;
  const shown = useRemoteProjectHomeShown(machine.connectionId, project.ref.projectId, homeId);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (revealRevision === null) return;
    rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [revealRevision]);
  const openProject = (board = false) => {
    const boardTab = board ? "coordinator" : projectLandingBoardTab(grouping, machine.bound);
    openMachineWorkspace({
      connectionId: machine.connectionId,
      projectId: project.ref.projectId,
      ...(boardTab ? { boardTab } : {}),
      title: project.name,
    });
  };
  // The project's own dialogs, in its machine's workspace, as its sidebar opens them.
  const openProjectDialog = (dialog: "repository-settings" | "delete-project") =>
    openMachineWorkspace({
      connectionId: machine.connectionId,
      projectId: project.ref.projectId,
      dialog,
      title: project.name,
    });
  const chevron = (
    <CollapsibleTrigger
      className="shrink-0 rounded-md p-1 transition-colors hover:bg-white/[0.07]"
      aria-label={
        isCollapsed ? `Expand project ${project.name}` : `Collapse project ${project.name}`
      }
    >
      <ChevronRight
        aria-hidden="true"
        className={cn(
          "h-4 w-4 text-muted-foreground transition-transform duration-200",
          !isCollapsed && "rotate-90",
        )}
      />
    </CollapsibleTrigger>
  );

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("px-2", isDragging && "opacity-50 z-50")}
      data-testid="federated-project"
      data-project={project.key}
      data-revealed={revealed || undefined}
      data-selected={shown || undefined}
    >
      <Collapsible open={!isCollapsed} onOpenChange={onToggleCollapse}>
        <div
          ref={rowRef}
          className={cn(
            "relative mx-1 flex items-center group/project rounded-lg border border-transparent transition-colors",
            shown || revealed
              ? "bg-linear-to-r from-selected to-selected-edge text-selected-foreground"
              : "hover:bg-hover",
          )}
        >
          <ContextMenu>
            <ContextMenuTrigger className="contents">
              <button
                {...(sortable ? attributes : {})}
                {...(sortable ? listeners : {})}
                type="button"
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground",
                  sortable && "cursor-grab active:cursor-grabbing",
                )}
                onClick={() => openProject()}
                aria-current={shown ? "page" : revealed ? "true" : undefined}
                title={`Open ${project.name} on ${machine.name}`}
              >
                {showMachine ? (
                  <MachineHomeIcon colorToken={machine.colorToken} machineName={machine.name} />
                ) : null}
                <span className={cn("truncate font-medium", labelClassName)}>{label}</span>
                {environments.length > 0 && (
                  <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-md bg-white/[0.07] px-1 text-[10px] text-zinc-300">
                    {environments.length}
                  </span>
                )}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => openProject(true)}>
                <LayoutGrid className="h-4 w-4 mr-2" />
                Open Board
              </ContextMenuItem>
              {githubRepositoryUrl && (
                <ContextMenuItem onClick={() => openWebPage(githubRepositoryUrl)}>
                  <GithubIcon className="h-4 w-4 mr-2" />
                  Open Repo on GitHub
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={!writable}
                onClick={() => openProjectDialog("repository-settings")}
              >
                <Settings2 className="h-4 w-4 mr-2" />
                Repository Settings
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={!writable}
                onClick={() => newFederatedEnvironment(machine, project)}
              >
                <Plus className="h-4 w-4 mr-2" />
                New Environment
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!writable}
                onClick={() =>
                  useProjectCopyStore.getState().open({
                    source: { nodeId: machine.backendId, projectId: project.ref.projectId },
                  })
                }
              >
                <Copy className="h-4 w-4 mr-2" />
                Copy to Machine…
              </ContextMenuItem>
              {onAddToFolder && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={onAddToFolder}>
                    <FolderInput className="h-4 w-4 mr-2" />
                    Add to Folder
                  </ContextMenuItem>
                  {onRemoveFromFolder && (
                    <ContextMenuItem onClick={onRemoveFromFolder}>
                      <FolderMinus className="h-4 w-4 mr-2" />
                      Remove from Folder
                    </ContextMenuItem>
                  )}
                </>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                disabled={!writable}
                onClick={() => openProjectDialog("delete-project")}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Project
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground opacity-100 transition-opacity hover:text-foreground md:opacity-0 md:group-hover/project:opacity-100 md:focus-visible:opacity-100"
            disabled={!writable}
            onClick={(event) => {
              event.stopPropagation();
              event.currentTarget.blur();
              newFederatedEnvironment(machine, project);
            }}
            aria-label={`New environment in ${project.name} on ${machine.name}`}
            title={
              writable ? `New environment on ${machine.name}` : `${machine.name} is unavailable`
            }
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          {chevron}
        </div>
        <CollapsibleContent>
          {environments.length > 0 && (
            <SortableContext
              items={environments.map((environment) => environment.key)}
              strategy={verticalListSortingStrategy}
            >
              {environments.map((environment) => (
                <RemoteSortableEnvironmentItem
                  key={environment.key}
                  machine={machine}
                  environment={environment}
                  sortable={sortable}
                />
              ))}
            </SortableContext>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * An environment of another machine in a project, drawn like
 * `SortableEnvironmentItem` around `EnvironmentItem`. Its drag id is its
 * node-qualified key.
 */
function RemoteSortableEnvironmentItem({
  machine,
  environment,
  sortable,
}: {
  machine: MachineView;
  environment: FederatedEnvironment;
  sortable: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: environment.key,
    disabled: !sortable,
  });
  const live = machine.transport === "connected";
  const shown = useRemoteEnvironmentShown(machine.connectionId, environment.ref.environmentId);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "opacity-50 z-50")}
      data-testid="federated-environment-row"
      data-machine={machine.connectionId}
      data-selected={shown || undefined}
    >
      <div
        className={cn(
          "group/sortable mx-1 flex items-center rounded-lg border border-transparent transition-colors",
          shown ? SELECTED_ENVIRONMENT_ROW_CLASS : "hover:bg-environment-hover",
          !live && "opacity-60",
        )}
      >
        {sortable ? (
          <button
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${environment.name}`}
            className="flex h-6 w-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground opacity-0 transition-opacity hover:text-foreground active:cursor-grabbing group-hover/sortable:opacity-100"
          >
            <GripVertical className="h-3 w-3" />
          </button>
        ) : (
          // Read-only while the owner is unavailable; keeps the icons aligned.
          <span aria-hidden="true" className="h-6 w-4 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <RemoteEnvironmentItem machine={machine} environment={environment} />
        </div>
      </div>
    </div>
  );
}

/**
 * The row content of another machine's environment, laid out like
 * `EnvironmentItem`: an activity ring around a machine-coloured circle (local)
 * or square (container), followed by the name and optional subtitle. During
 * transitions and actions, a spinner leads and a machine dot stays by the name.
 * Selecting it moves the window to the owner's workspace.
 */
export function RemoteEnvironmentItem({
  machine,
  environment,
  subtitle,
}: {
  machine: MachineView;
  environment: FederatedEnvironment;
  subtitle?: string;
}) {
  const {
    busy,
    writable,
    open,
    copyLink,
    openSettings,
    start,
    stop,
    restart,
    fork,
    requestDelete,
    deleteDialog,
  } = useFederatedEnvironmentActions(machine, environment);
  const shown = useRemoteEnvironmentShown(machine.connectionId, environment.ref.environmentId);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  // The same `environment-net` projection the machine's own rows show, read
  // through the command node and kept current by the machine's relayed events.
  const changeProjection = useNodeEnvironmentChangeProjection(environment.ref);
  // The hover card reads the full record and agent summary from the machine
  // only while it is open; until then it shows what the summary carries.
  const tooltipAnchorRef = useRef<HTMLDivElement>(null);
  const tooltip = useHoverTooltip();
  const details = useNodeEnvironment(environment.ref, tooltip.open);

  const live = machine.transport === "connected";
  const statusText = machineStatusText({
    transport: machine.transport,
    freshness: machine.freshness,
    loadedAt: machine.loadedAt,
  });
  const activityText = live
    ? ACTIVITY_TEXT[environment.activity]
    : `Connection lost; last observed ${ACTIVITY_TEXT[environment.activity].toLowerCase()}`;
  const isLocalEnvironment = environment.environmentType === "local";
  // Local environments are always considered "running", as on their own machine.
  const isRunning = isLocalEnvironment || environment.status === "running";
  const isTransitioning =
    !isLocalEnvironment && (environment.status === "creating" || environment.status === "stopping");
  // Decided here from the machine's relayed PR reading (pr-merge-readiness).
  const readyToMerge = isNodeEnvironmentReadyToMerge(environment, machine);
  const mergeReadyDescriptionId = useId();

  const menuItems: EnvironmentMenuItem[] = [
    {
      key: "open",
      label: "Open workspace",
      icon: <PanelRight className="h-4 w-4 mr-2" />,
      onSelect: open,
    },
    {
      key: "copy-link",
      label: "Copy link",
      icon: <Link2 className="h-4 w-4 mr-2" />,
      onSelect: copyLink,
    },
    {
      key: "settings",
      label: "Settings",
      icon: <Settings2 className="h-4 w-4 mr-2" />,
      onSelect: openSettings,
      disabled: !writable,
    },
    { key: "fork-separator", separator: true },
    {
      key: "fork-local",
      label: "Fork local",
      icon: <Laptop className="h-4 w-4 mr-2" />,
      onSelect: () => fork("local"),
      disabled: !writable || busy || environment.deleting,
    },
    {
      key: "fork-container",
      label: "Fork container",
      icon: <Container className="h-4 w-4 mr-2" />,
      onSelect: () => fork("containerized"),
      disabled: !writable || busy || environment.deleting,
    },
    ...(!isLocalEnvironment
      ? ([
          { key: "container-actions", separator: true },
          {
            key: "power",
            label: isRunning ? "Stop" : "Start",
            icon: isRunning ? (
              <Square className="h-4 w-4 mr-2" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            ),
            onSelect: isRunning ? stop : start,
            disabled: !writable || busy || isTransitioning,
          },
          {
            key: "restart",
            label: "Restart",
            icon: <RotateCw className="h-4 w-4 mr-2" />,
            onSelect: restart,
            disabled: !writable || busy || !isRunning || isTransitioning,
          },
        ] satisfies EnvironmentMenuItem[])
      : []),
    { key: "delete-separator", separator: true },
    {
      key: "delete",
      label: "Delete…",
      icon: <Trash2 className="h-4 w-4 mr-2" />,
      onSelect: requestDelete,
      disabled: !writable || busy || environment.deleting,
      variant: "destructive",
    },
  ];

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger className="contents">
          <div
            ref={tooltipAnchorRef}
            className={cn(
              "group flex w-full items-center gap-2 py-1 pr-2 text-[13px] transition-colors",
              isMobile && "select-none",
              environment.deleting && "opacity-60",
            )}
          >
            <button
              type="button"
              onClick={open}
              onMouseEnter={tooltip.show}
              onMouseLeave={tooltip.hide}
              onFocus={tooltip.show}
              onBlur={tooltip.hide}
              aria-label={`${environment.name}, on ${machine.name}, ${activityText}`}
              aria-describedby={readyToMerge ? mergeReadyDescriptionId : undefined}
              aria-current={shown ? "true" : undefined}
              className={cn(
                "flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left transition-colors",
                shown ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
              )}
            >
              {environment.deleting ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-destructive" />
              ) : isTransitioning || busy ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-500" />
              ) : (
                <EnvironmentStatusMarker
                  local={isLocalEnvironment}
                  state={isRunning && live ? environment.activity : "inactive"}
                  machine={{
                    name: machine.name,
                    colorToken: machine.colorToken,
                    status: statusText,
                  }}
                />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-1.5">
                  <MergeReadyName ready={readyToMerge} className="truncate font-medium leading-4">
                    {environment.name}
                  </MergeReadyName>
                  <MergeReadyMarker ready={readyToMerge} descriptionId={mergeReadyDescriptionId} />
                  {(environment.deleting || isTransitioning || busy) && (
                    <MachineDot
                      machineName={machine.name}
                      colorToken={machine.colorToken}
                      status={statusText}
                      shape={isLocalEnvironment ? "circle" : "square"}
                    />
                  )}
                  {environment.hasUnreadWork && (
                    <UnreadBellIcon className="h-3 w-3" aria-label="New completed activity" />
                  )}
                </span>
                {subtitle && (
                  <span className="truncate text-[11px] font-normal leading-4 text-zinc-500">
                    {subtitle}
                  </span>
                )}
              </span>
              {changeProjection && (
                // Last known while the machine is away.
                <span className={cn("contents", !live && "[&>*]:opacity-60")}>
                  <EnvironmentChangeBadge projection={changeProjection} />
                </span>
              )}
            </button>
            {isMobile && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="-my-1 -mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-zinc-700/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    aria-label={`Actions for ${environment.name} on ${machine.name}`}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <MoreVertical className="h-4 w-4" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <EnvironmentMenuItems
                    items={menuItems}
                    Item={DropdownMenuItem}
                    Separator={DropdownMenuSeparator}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </ContextMenuTrigger>
        <HoverTooltipContent
          anchorRef={tooltipAnchorRef}
          open={tooltip.open}
          side="bottom"
          align="start"
          sideOffset={4}
          onMouseEnter={tooltip.show}
          onMouseLeave={tooltip.hide}
        >
          <EnvironmentTooltipBody
            name={environment.name}
            readyToMerge={readyToMerge}
            machine={{
              name: machine.name,
              colorToken: machine.colorToken,
              ...(live ? {} : { status: statusText }),
            }}
            details={
              details ?? {
                projectHome: environment.isProjectHome,
                ...(environment.branch ? { branch: environment.branch } : {}),
                ...(environment.environmentType
                  ? { environmentType: environment.environmentType }
                  : {}),
              }
            }
            agentSummary={
              live ? (
                <EnvironmentAgentSummary
                  environmentId={environment.ref.environmentId}
                  open={tooltip.open}
                  source={nodeAgentSummarySource(environment.ref.backendId)}
                />
              ) : null
            }
            changes={
              changeProjection ? <EnvironmentChangeSummary projection={changeProjection} /> : null
            }
          />
        </HoverTooltipContent>
        <ContextMenuContent>
          <EnvironmentMenuItems
            items={menuItems}
            Item={ContextMenuItem}
            Separator={ContextMenuSeparator}
          />
        </ContextMenuContent>
      </ContextMenu>
      {deleteDialog}
    </>
  );
}
