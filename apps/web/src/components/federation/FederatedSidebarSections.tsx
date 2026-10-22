import { useMemo, useState, type ReactNode } from "react";
import {
  DndContext,
  closestCenter,
  type CollisionDetection,
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
import { ChevronDown, ChevronRight, GripVertical, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { SortableProjectFolder } from "@/components/sidebar/SortableProjectFolder";
import { SidebarRootDropZone } from "@/components/sidebar/SidebarRootDropZone";
import { activityRows, isMachineWritable, type MachineView } from "@/lib/federation/aggregate";
import {
  arrangeMachines,
  buildRepositoryTree,
  resolveRepositoryArrangement,
  mergedArrangementUpdate,
  mergedProjectList,
  repositoryArrangementUpdate,
  repositoryLabel,
  repositoryMemberLabel,
  repositoryOpenTarget,
  repositoryProjectList,
  type MergedProject,
} from "@/lib/federation/sidebar-layout";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { updatePortalLayout, usePortalLayout } from "@/lib/portal/portal-layout";
import {
  buildProjectTree,
  normalizeProjectFolderName,
  parseProjectFolderDragId,
  PROJECT_ROOT_DROP_ID,
  projectFolderKey,
  projectSortableIds,
  resolveProjectArrangement,
  resolveRenameProjectFolder,
  resolveSortProjectFolder,
  resolveUngroupProjectFolder,
  type ProjectArrangement,
} from "@/lib/project-folders";
import { cn } from "@/lib/utils";
import { sidebarFolderKey, useMachineViewStore } from "@/stores/machineViewStore";
import { useFederation } from "./FederationProvider";
import { MachineDot, machineStatusText } from "./MachineDot";
import {
  RemoteEnvironmentItem,
  RemoteMachineTree,
  RemoteProjectGroup,
  remoteEnvironmentProject,
  useRemoteEnvironments,
} from "./RemoteMachineTree";
import { UnknownOutcomesNotice } from "./UnknownOutcomesNotice";

function reportLayoutError(error: unknown): void {
  toast.error("Could not save the sidebar order", {
    description: error instanceof Error ? error.message : String(error),
  });
}

function useDragSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/** A machine heading: colour, name and its connection state, never activity. */
export function MachineSectionHeader({
  machine,
  collapsed,
  onToggle,
  dragHandle,
}: {
  machine: MachineView;
  collapsed?: boolean;
  onToggle?: () => void;
  /** Drag listeners for the grip that moves the whole section. */
  dragHandle?: Record<string, unknown>;
}) {
  const status = machine.bound
    ? "This window"
    : machineStatusText({
        transport: machine.transport,
        freshness: machine.freshness,
        loadedAt: machine.loadedAt,
      });
  const live = machine.bound || machine.transport === "connected";
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div
      className="group/machine sticky top-0 z-[5] flex h-8 items-center gap-2 border-b border-border/50 bg-sidebar/95 pr-3 pl-1 backdrop-blur-sm"
      data-testid="machine-section-header"
      data-machine={machine.connectionId}
    >
      {dragHandle ? (
        <button
          type="button"
          {...dragHandle}
          aria-label={`Move ${machine.name}`}
          className="flex h-6 w-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 active:cursor-grabbing group-hover/machine:opacity-100 pointer-coarse:opacity-100"
        >
          <GripVertical className="h-3 w-3" aria-hidden="true" />
        </button>
      ) : (
        <span aria-hidden="true" className="h-6 w-4 shrink-0" />
      )}
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          className="text-muted-foreground hover:text-foreground"
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${machine.name}`}
          aria-expanded={!collapsed}
        >
          <Chevron className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
      <MachineDot colorToken={machine.colorToken} machineName={machine.name} status={status} />
      <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {machine.name}
      </span>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1 text-[11px]",
          live ? "text-muted-foreground" : "text-amber-400",
        )}
        title={machine.transportDetail}
      >
        {!live ? <WifiOff className="h-3 w-3" aria-hidden="true" /> : null}
        {status}
      </span>
    </div>
  );
}

function MachineNotices({ machine }: { machine: MachineView }) {
  const notices: ReactNode[] = [];
  if (!machine.bound && machine.transport !== "connected" && machine.loadedAt !== null) {
    notices.push(
      <p key="stale" className="px-3 py-1 text-[11px] text-amber-400/90">
        Showing last known state. Live actions are disabled until {machine.name} reconnects.
      </p>,
    );
  }
  if (machine.truncated) {
    notices.push(
      <p key="truncated" className="px-3 py-1 text-[11px] text-muted-foreground">
        Not every project or environment on {machine.name} is shown here.
      </p>,
    );
  }
  if (!machine.bound && machine.transportDetail && machine.transport !== "connected") {
    notices.push(
      <p key="detail" className="px-3 py-1 text-[11px] text-muted-foreground">
        {machine.transportDetail}
      </p>,
    );
  }
  return notices.length > 0 ? <>{notices}</> : null;
}

/** Another machine's projects and environments, laid out as its own sidebar lays them out. */
function RemoteMachineBody({ machine }: { machine: MachineView }) {
  return (
    <div className="py-1">
      <MachineNotices machine={machine} />
      <UnknownOutcomesNotice connectionId={machine.connectionId} />
      {machine.loadedAt === null && machine.projects.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {machine.transport === "connected" || machine.transport === "connecting"
            ? "Loading…"
            : "Not available yet."}
        </p>
      ) : machine.projects.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No projects</p>
      ) : (
        <RemoteMachineTree machine={machine} />
      )}
    </div>
  );
}

const MACHINE_DRAG_PREFIX = "machine:";

/** One machine's section "by machine": a heading that collapses it and moves it. */
function MachineSection({
  machine,
  sortable,
  children,
}: {
  machine: MachineView;
  sortable: boolean;
  children: ReactNode;
}) {
  const collapsed = useMachineViewStore((state) =>
    state.collapsedMachines.includes(machine.connectionId),
  );
  const setMachineCollapsed = useMachineViewStore((state) => state.setMachineCollapsed);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `${MACHINE_DRAG_PREFIX}${machine.connectionId}`,
    disabled: !sortable,
  });
  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "relative z-50 opacity-50")}
      aria-label={`${machine.name} projects`}
      data-testid={machine.bound ? "bound-machine-section" : "remote-machine-section"}
    >
      <MachineSectionHeader
        machine={machine}
        collapsed={collapsed}
        onToggle={() => setMachineCollapsed(machine.connectionId)}
        dragHandle={sortable ? { ...attributes, ...listeners } : undefined}
      />
      {!collapsed ? children : null}
    </section>
  );
}

/** Another machine's section on its own (outside a machine list it cannot be moved). */
export function RemoteMachineSection({ machine }: { machine: MachineView }) {
  return (
    <MachineSection machine={machine} sortable={false}>
      <RemoteMachineBody machine={machine} />
    </MachineSection>
  );
}

/**
 * "By machine": each shown machine under its heading, in the order the
 * command node keeps. Headings are dragged to reorder machines; within a
 * section the machine's own order applies.
 */
export function MachineSectionList({
  machines,
  shown,
  renderBound,
}: {
  /** Every known machine, in order (the stored order keeps hidden ones in place). */
  machines: readonly MachineView[];
  /** The machines shown, in order. */
  shown: readonly MachineView[];
  /** This window's own machine's tree. */
  renderBound: () => ReactNode;
}) {
  const { portalState } = useFederation();
  const layout = usePortalLayout();
  const sensors = useDragSensors();
  const sortable = shown.length > 1;

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const machineOrder = arrangeMachines(
      machines,
      shown,
      layout,
      portalState.selfId,
      String(active.id).slice(MACHINE_DRAG_PREFIX.length),
      String(over.id).slice(MACHINE_DRAG_PREFIX.length),
    );
    if (machineOrder) updatePortalLayout({ machineOrder }).catch(reportLayoutError);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext
        items={shown.map((machine) => `${MACHINE_DRAG_PREFIX}${machine.connectionId}`)}
        strategy={verticalListSortingStrategy}
      >
        {shown.map((machine) => (
          <MachineSection key={machine.connectionId} machine={machine} sortable={sortable}>
            {machine.bound ? (
              <div className="py-1">{renderBound()}</div>
            ) : (
              <RemoteMachineBody machine={machine} />
            )}
          </MachineSection>
        ))}
      </SortableContext>
    </DndContext>
  );
}

/**
 * "By project" and "by repository": every shown machine's projects in one
 * list, in the order the command node keeps. Projects and folders (or
 * repository groups) are dragged as on a machine's own sidebar; the order
 * and the merged list's folders are stored on the command node, while
 * environment order stays with each environment's machine.
 */
export function MergedProjectList({
  machines,
  shownIds,
  mode,
  renderBoundProject,
  onBoundEnvironmentDragEnd,
}: {
  /** Every known machine, in machine order. */
  machines: readonly MachineView[];
  /** Machines whose projects are shown (connected, and not filtered out). */
  shownIds: ReadonlySet<string>;
  mode: "project" | "repository";
  /** A project of this window's own machine, with its drag id and the label to show. */
  renderBoundProject: (projectId: string, sortableId: string, label?: string) => ReactNode;
  /** An environment of this window's own machine was dropped. */
  onBoundEnvironmentDragEnd: (activeId: string, overId: string) => void;
}) {
  const layout = usePortalLayout();
  const { portalState } = useFederation();
  const collapsedProjectKeys = useMachineViewStore((state) => state.collapsedProjectKeys);
  const collapsedFolderKeys = useMachineViewStore((state) => state.collapsedFolderKeys);
  const setProjectKeyCollapsed = useMachineViewStore((state) => state.setProjectKeyCollapsed);
  const setFolderKeyCollapsed = useMachineViewStore((state) => state.setFolderKeyCollapsed);
  const { environmentsOf, reorder } = useRemoteEnvironments();
  const [draggingProject, setDraggingProject] = useState(false);
  const sensors = useDragSensors();

  const list = useMemo(
    () =>
      mode === "project"
        ? mergedProjectList(machines, shownIds, layout, portalState.selfId)
        : repositoryProjectList(machines, shownIds, layout, portalState.selfId),
    [layout, machines, mode, portalState.selfId, shownIds],
  );
  const tree = useMemo(
    () => (mode === "repository" ? buildRepositoryTree(list.shown) : buildProjectTree(list.shown)),
    [list.shown, mode],
  );
  const projectIds = useMemo(() => new Set(list.shown.map((item) => item.id)), [list.shown]);
  const folderCollapseKey = (name: string) =>
    sidebarFolderKey(mode, mode === "repository" ? name : projectFolderKey(name));
  const isFolderCollapsed = (name: string) => collapsedFolderKeys.includes(folderCollapseKey(name));
  const sortableIds =
    mode === "repository"
      ? tree.flatMap((entry) =>
          entry.kind === "project"
            ? [entry.project.id]
            : [
                `project-folder:${entry.key}`,
                ...(isFolderCollapsed(entry.name) ? [] : entry.projects.map((p) => p.id)),
              ],
        )
      : projectSortableIds(tree, [], isFolderCollapsed);
  const isProjectDrag = (id: string) => parseProjectFolderDragId(id) !== null || projectIds.has(id);
  // Expanded projects' environment rows are droppables too, and usually the
  // closest ones; a project dropped on one would go nowhere.
  const collisionDetection: CollisionDetection = (args) =>
    closestCenter(
      isProjectDrag(String(args.active.id))
        ? {
            ...args,
            droppableContainers: args.droppableContainers.filter((container) => {
              const id = String(container.id);
              return id === PROJECT_ROOT_DROP_ID || isProjectDrag(id);
            }),
          }
        : args,
    );

  const apply = (arrangement: ProjectArrangement | null) => {
    const update =
      mode === "project"
        ? mergedArrangementUpdate(list, machines, layout, arrangement)
        : repositoryArrangementUpdate(list, machines, arrangement);
    if (update) updatePortalLayout(update).catch(reportLayoutError);
  };

  const handleDragStart = ({ active }: DragStartEvent) => {
    setDraggingProject(isProjectDrag(String(active.id)));
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setDraggingProject(false);
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (isProjectDrag(activeId)) {
      apply(
        mode === "repository"
          ? resolveRepositoryArrangement(activeId, overId, list.shown)
          : resolveProjectArrangement(activeId, overId, list.shown),
      );
      return;
    }
    for (const item of list.shown) {
      if (item.machine.bound) continue;
      const project = remoteEnvironmentProject(item.machine, [item.project], activeId);
      if (project) {
        if (isMachineWritable(item.machine) && !item.machine.truncated) {
          reorder(item.machine, project, activeId, overId);
        }
        return;
      }
    }
    onBoundEnvironmentDragEnd(activeId, overId);
  };

  const renderProject = (item: MergedProject, label?: string) =>
    item.machine.bound ? (
      <div key={item.id}>{renderBoundProject(item.project.ref.projectId, item.id, label)}</div>
    ) : (
      <RemoteProjectGroup
        key={item.id}
        machine={item.machine}
        project={item.project}
        environments={environmentsOf(item.machine, item.project)}
        isCollapsed={collapsedProjectKeys.includes(item.id)}
        onToggleCollapse={() => setProjectKeyCollapsed(item.id)}
        sortable={isMachineWritable(item.machine) && !item.machine.truncated}
        showMachine
        label={label}
      />
    );

  return (
    <div
      className="py-1"
      data-testid={mode === "project" ? "federated-project-list" : "federated-repository-list"}
    >
      {list.shown.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">No projects yet</p>
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDraggingProject(false)}
      >
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          {tree.map((entry) => {
            if (entry.kind === "project") return renderProject(entry.project);
            const folderActions =
              mode === "project"
                ? {
                    onRename: (nextName: string) => {
                      const normalized = normalizeProjectFolderName(nextName);
                      if (!normalized) return;
                      const collapsed = isFolderCollapsed(entry.name);
                      apply(resolveRenameProjectFolder(list.shown, entry.name, nextName));
                      setFolderKeyCollapsed(folderCollapseKey(entry.name), false);
                      setFolderKeyCollapsed(folderCollapseKey(normalized), collapsed);
                    },
                    onSort: () => apply(resolveSortProjectFolder(list.shown, entry.name)),
                    onUngroup: () => apply(resolveUngroupProjectFolder(list.shown, entry.name)),
                  }
                : {};
            const opens =
              mode === "repository"
                ? repositoryOpenTarget(entry.projects, portalState.selfId)
                : null;
            return (
              <SortableProjectFolder
                key={`folder:${entry.key}`}
                name={entry.name}
                sortableId={mode === "repository" ? `project-folder:${entry.key}` : undefined}
                label={mode === "repository" ? repositoryLabel(entry.name) : entry.name}
                repository={mode === "repository"}
                projectCount={entry.projects.length}
                isCollapsed={isFolderCollapsed(entry.name)}
                onToggleCollapse={() => setFolderKeyCollapsed(folderCollapseKey(entry.name))}
                onOpen={
                  opens
                    ? () =>
                        openMachineWorkspace({
                          connectionId: opens.machine.connectionId,
                          projectId: opens.project.ref.projectId,
                          title: opens.name,
                        })
                    : undefined
                }
                openMachineName={opens?.machine.name}
                badge={
                  opens ? (
                    <MachineDot
                      colorToken={opens.machine.colorToken}
                      machineName={opens.machine.name}
                    />
                  ) : undefined
                }
                {...folderActions}
              >
                {entry.projects.map((item) =>
                  renderProject(
                    item,
                    mode === "repository" ? repositoryMemberLabel(item, entry.projects) : undefined,
                  ),
                )}
              </SortableProjectFolder>
            );
          })}
          <SidebarRootDropZone active={draggingProject && mode === "project"} />
        </SortableContext>
      </DndContext>
    </div>
  );
}

/**
 * "By activity" across machines: every shown environment, attention first,
 * each row laid out as this window's own activity rows are.
 */
export function FederatedActivityList({
  machines,
  renderBoundRow,
}: {
  machines: readonly MachineView[];
  /** A whole activity row of this window's own machine. */
  renderBoundRow: (environmentId: string) => ReactNode;
}) {
  const rows = activityRows(machines);
  return (
    <div className="px-1 pt-2" data-testid="federated-activity-list">
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">No environments yet</p>
      ) : (
        rows.map((row) =>
          row.machine.bound ? (
            <div key={row.environment.key}>{renderBoundRow(row.environment.ref.environmentId)}</div>
          ) : (
            <div
              key={row.environment.key}
              className={cn(
                "mx-1 flex items-center rounded-lg border border-transparent transition-colors hover:bg-environment-hover",
                row.machine.transport !== "connected" && "opacity-60",
              )}
              data-testid="federated-environment-row"
              data-machine={row.machine.connectionId}
            >
              <div className="min-w-0 flex-1 pl-2">
                <RemoteEnvironmentItem
                  machine={row.machine}
                  environment={row.environment}
                  subtitle={row.project?.name ?? "Unknown project"}
                />
              </div>
            </div>
          ),
        )
      )}
    </div>
  );
}
