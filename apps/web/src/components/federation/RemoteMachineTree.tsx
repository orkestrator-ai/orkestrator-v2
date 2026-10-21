import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { useCallback, useMemo, type ReactNode } from "react";
import { toast } from "sonner";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
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
  Folder,
  FolderOpen,
  GripVertical,
  LayoutGrid,
  Laptop,
  Link2,
  Loader2,
  MoreVertical,
  PanelRight,
  Play,
  Plus,
  Square,
  Trash2,
} from "lucide-react";
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
  EnvironmentMenuItems,
  type EnvironmentMenuItem,
} from "@/components/environments/EnvironmentItem";
import { UnreadBellIcon } from "@/components/environments/UnreadBellIcon";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { isMachineWritable, type MachineView } from "@/lib/federation/aggregate";
import { useStore } from "zustand";
import { remoteOrdersFor } from "@/lib/federation/remote-order-writes";
import { moveId, withOrder } from "@/lib/federation/remote-order";
import type { FederatedEnvironment, FederatedProject } from "@/lib/federation/summaries";
import { buildProjectTree, isProjectFolderCollapsed } from "@/lib/project-folders";
import { OutcomeUnknownError } from "@/lib/portal/portal-store";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/stores";
import { useFederation } from "./FederationProvider";
import { MachineDot, machineStatusText } from "./MachineDot";
import {
  useCreateFederatedEnvironment,
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
 * Collapse state is kept with this window's own projects and folders, so it
 * is keyed by the machine-qualified identity: two machines can share IDs and
 * folder names.
 */
function folderCollapseKey(machine: MachineView, folder: string): string {
  return `${machine.backendId}/${folder}`;
}

/** The selected environment when this window is working on this machine. */
function useFocusedEnvironmentId(machine: MachineView): string | null {
  return useUIStore((state) => (machine.bound ? state.selectedEnvironmentId : null));
}

/**
 * Another machine's projects and environments, laid out like this window's
 * own sidebar: the owner's folders, project order and environment order.
 * Environments can be dragged within their project; the new order is written
 * to the owner, never to this machine.
 */
export function RemoteMachineTree({ machine }: { machine: MachineView }) {
  const { portal } = useFederation();
  const collapsedProjects = useUIStore((state) => state.collapsedProjects);
  const collapsedProjectFolders = useUIStore((state) => state.collapsedProjectFolders);
  const toggleProjectCollapse = useUIStore((state) => state.toggleProjectCollapse);
  const toggleProjectFolderCollapse = useUIStore((state) => state.toggleProjectFolderCollapse);
  const focusedEnvironmentId = useFocusedEnvironmentId(machine);
  const orderWrites = useMemo(() => remoteOrdersFor(portal), [portal]);
  const orders = useStore(orderWrites.store);
  const writable = isMachineWritable(machine);
  const sortable = writable && !machine.truncated;

  const projects = useMemo(
    () => [...machine.projects].sort((left, right) => left.order - right.order),
    [machine.projects],
  );
  const tree = useMemo(() => buildProjectTree(projects), [projects]);
  const environmentsOf = useCallback(
    (project: FederatedProject) =>
      withOrder(
        (machine.environmentsByProject.get(project.ref.projectId) ?? NO_ENVIRONMENTS)
          .filter((environment) => !environment.isProjectHome)
          .sort((left, right) => left.order - right.order),
        orders.get(project.key),
        (environment) => environment.ref.environmentId,
      ),
    [machine.environmentsByProject, orders],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!sortable || !over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    // Environments never move between projects, so both rows share one.
    const project = projects.find((candidate) => {
      const ids = environmentsOf(candidate).map((environment) => environment.ref.environmentId);
      return ids.includes(activeId) && ids.includes(overId);
    });
    if (!project) return;
    const projectId = project.ref.projectId;
    const ids = moveId(
      environmentsOf(project).map((environment) => environment.ref.environmentId),
      activeId,
      overId,
    );
    if (!ids) return;
    // Reorder only visible slots; home rows keep their owner position and are
    // included in the whole-project payload so the owner never appends them.
    let nextVisible = 0;
    const allIds = [...(machine.environmentsByProject.get(projectId) ?? NO_ENVIRONMENTS)]
      .sort((left, right) => left.order - right.order)
      .map((environment) =>
        environment.isProjectHome ? environment.ref.environmentId : ids[nextVisible++]!,
      );
    orderWrites.submit(project.ref, allIds, (error: unknown) => {
      if (error instanceof OutcomeUnknownError) {
        toast.warning(`Reorder: outcome unknown on ${machine.name}`, {
          description: error.message,
        });
      } else {
        toast.error(`Could not reorder environments on ${machine.name}`, {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    });
  };

  const renderProject = (project: FederatedProject) => (
    <RemoteProjectGroup
      key={project.key}
      machine={machine}
      project={project}
      environments={environmentsOf(project)}
      isCollapsed={collapsedProjects.includes(project.key)}
      onToggleCollapse={() => toggleProjectCollapse(project.key)}
      focusedEnvironmentId={focusedEnvironmentId}
      sortable={sortable}
    />
  );

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      {tree.map((entry) => {
        if (entry.kind === "project") return renderProject(entry.project);
        const collapseKey = folderCollapseKey(machine, entry.name);
        return (
          <RemoteProjectFolder
            key={`folder:${entry.key}`}
            name={entry.name}
            projectCount={entry.projects.length}
            isCollapsed={isProjectFolderCollapsed(collapsedProjectFolders, collapseKey)}
            onToggleCollapse={() => toggleProjectFolderCollapse(collapseKey)}
          >
            {entry.projects.map(renderProject)}
          </RemoteProjectFolder>
        );
      })}
    </DndContext>
  );
}

/** A folder of another machine, drawn like `SortableProjectFolder`. */
function RemoteProjectFolder({
  name,
  projectCount,
  isCollapsed,
  onToggleCollapse,
  children,
}: {
  name: string;
  projectCount: number;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  children: ReactNode;
}) {
  const FolderIcon = isCollapsed ? Folder : FolderOpen;
  return (
    <div data-project-folder={name} className="px-2 py-0.5">
      <div className="relative mx-1 flex items-center rounded-lg border border-transparent transition-colors hover:bg-hover">
        <button
          type="button"
          aria-expanded={!isCollapsed}
          title={isCollapsed ? `Expand folder ${name}` : `Collapse folder ${name}`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground"
          onClick={onToggleCollapse}
        >
          <FolderIcon className="h-4 w-4 shrink-0 text-amber-400/80" aria-hidden="true" />
          <span className="truncate font-medium">{name}</span>
          <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-md bg-white/[0.07] px-1 text-[10px] text-zinc-300">
            {projectCount}
          </span>
        </button>
        <button
          type="button"
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? `Expand folder ${name}` : `Collapse folder ${name}`}
          className="shrink-0 rounded-md p-1 transition-colors hover:bg-white/[0.07]"
          onClick={onToggleCollapse}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform duration-200",
              !isCollapsed && "rotate-90",
            )}
          />
        </button>
      </div>
      {!isCollapsed && (
        <div className="ml-3 border-l border-zinc-800/80 pl-1" data-project-folder-content={name}>
          {children}
        </div>
      )}
    </div>
  );
}

/** A project of another machine, drawn like `SortableProjectGroup`. */
function RemoteProjectGroup({
  machine,
  project,
  environments,
  isCollapsed,
  onToggleCollapse,
  focusedEnvironmentId,
  sortable,
}: {
  machine: MachineView;
  project: FederatedProject;
  environments: readonly FederatedEnvironment[];
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  focusedEnvironmentId: string | null;
  sortable: boolean;
}) {
  const { creating, create } = useCreateFederatedEnvironment(machine, project);
  const writable = isMachineWritable(machine);
  const openBoard = () =>
    openMachineWorkspace({
      connectionId: machine.connectionId,
      projectId: project.ref.projectId,
      title: project.name,
    });

  return (
    <div className="px-2" data-testid="federated-project" data-project={project.key}>
      <Collapsible open={!isCollapsed} onOpenChange={onToggleCollapse}>
        <div className="relative mx-1 flex items-center group/project rounded-lg border border-transparent transition-colors hover:bg-hover">
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
          <ContextMenu>
            <ContextMenuTrigger className="contents">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground"
                onClick={openBoard}
                title={`Open ${project.name} on ${machine.name}`}
              >
                <span className="truncate font-medium">{project.name}</span>
                {environments.length > 0 && (
                  <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-md bg-white/[0.07] px-1 text-[10px] text-zinc-300">
                    {environments.length}
                  </span>
                )}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={openBoard}>
                <LayoutGrid className="h-4 w-4 mr-2" />
                Open Board
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem disabled={!writable || creating} onClick={() => void create()}>
                <Plus className="h-4 w-4 mr-2" />
                New Environment
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground opacity-100 transition-opacity hover:text-foreground md:opacity-0 md:group-hover/project:opacity-100 md:focus-visible:opacity-100"
            disabled={!writable || creating}
            onClick={(event) => {
              event.stopPropagation();
              event.currentTarget.blur();
              void create();
            }}
            aria-label={`New environment in ${project.name} on ${machine.name}`}
            title={
              writable ? `New environment on ${machine.name}` : `${machine.name} is unavailable`
            }
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <CollapsibleContent>
          {environments.length > 0 && (
            <SortableContext
              items={environments.map((environment) => environment.ref.environmentId)}
              strategy={verticalListSortingStrategy}
            >
              {environments.map((environment) => (
                <RemoteSortableEnvironmentItem
                  key={environment.key}
                  machine={machine}
                  environment={environment}
                  isSelected={focusedEnvironmentId === environment.ref.environmentId}
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
 * An environment of another machine, drawn like `SortableEnvironmentItem`
 * around `EnvironmentItem`. Selecting it switches to the owner's workspace.
 */
function RemoteSortableEnvironmentItem({
  machine,
  environment,
  isSelected,
  sortable,
}: {
  machine: MachineView;
  environment: FederatedEnvironment;
  isSelected: boolean;
  sortable: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: environment.ref.environmentId,
    disabled: !sortable,
  });
  const { busy, writable, open, copyLink, start, stop, requestDelete, deleteDialog } =
    useFederatedEnvironmentActions(machine, environment);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);

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
  const EnvironmentIcon = isLocalEnvironment ? Laptop : Container;

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
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "opacity-50 z-50")}
      data-testid="federated-environment-row"
      data-machine={machine.connectionId}
    >
      <div
        className={cn(
          "group/sortable mx-1 flex items-center rounded-lg border border-transparent transition-colors",
          isSelected
            ? "relative overflow-hidden border-transparent bg-linear-to-r from-selected to-selected-edge text-selected-foreground before:absolute before:inset-y-1 before:left-1 before:w-0.5 before:rounded-full before:bg-primary before:transition-opacity hover:before:opacity-0"
            : "hover:bg-environment-hover",
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
          <ContextMenu>
            <ContextMenuTrigger className="contents">
              <div
                className={cn(
                  "group flex w-full items-center gap-2 py-1 pr-2 text-[13px] transition-colors",
                  isMobile && "select-none",
                  environment.deleting && "opacity-60",
                )}
              >
                <button
                  type="button"
                  onClick={open}
                  aria-label={`${environment.name}, on ${machine.name}, ${activityText}`}
                  className={cn(
                    "flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left transition-colors",
                    isSelected
                      ? "text-foreground"
                      : "text-muted-foreground group-hover:text-foreground",
                  )}
                >
                  {environment.deleting ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-destructive" />
                  ) : isTransitioning || busy ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-500" />
                  ) : (
                    <EnvironmentIcon
                      className={cn(
                        "h-4 w-4 shrink-0 transition-colors",
                        (!isRunning || !live) && "text-muted-foreground",
                        isRunning &&
                          live &&
                          environment.activity === "waiting" &&
                          "text-amber-500 animate-pulse",
                        isRunning &&
                          live &&
                          environment.activity === "working" &&
                          "text-blue-500 animate-pulse",
                        isRunning && live && environment.activity === "idle" && "text-success",
                      )}
                    />
                  )}
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <MachineDot
                      colorToken={machine.colorToken}
                      machineName={machine.name}
                      status={statusText}
                    />
                    <span className="truncate font-medium leading-4">{environment.name}</span>
                    {environment.hasUnreadWork && (
                      <UnreadBellIcon className="h-3 w-3" aria-label="New completed activity" />
                    )}
                  </span>
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
            <ContextMenuContent>
              <EnvironmentMenuItems
                items={menuItems}
                Item={ContextMenuItem}
                Separator={ContextMenuSeparator}
              />
            </ContextMenuContent>
          </ContextMenu>
        </div>
      </div>
      {deleteDialog}
    </div>
  );
}
