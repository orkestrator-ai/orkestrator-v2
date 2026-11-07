import { useEnvironmentStore } from "@/stores/environmentStore";
import { useMemo, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowUpCircle, ChevronDown, ChevronRight, WifiOff } from "lucide-react";
import { toast } from "sonner";
import {
  SortableProjectFolder,
  type RepositoryMenuActions,
} from "@/components/sidebar/SortableProjectFolder";
import { SidebarRootDropZone } from "@/components/sidebar/SidebarRootDropZone";
import {
  folderDragItem,
  machineEnvironmentDragItem,
  SidebarDragOverlay,
  type SidebarDragItem,
} from "@/components/sidebar/SidebarDragOverlay";
import { SidebarEmptyState } from "@/components/sidebar/SidebarEmptyState";
import { projectTreeSortingStrategy } from "@/lib/sidebar-sorting";
import { activityRows, isMachineWritable, type MachineView } from "@/lib/federation/aggregate";
import {
  arrangeMachines,
  resolveRepositoryArrangement,
  mergedArrangementUpdate,
  mergedProjectView,
  repositoryArrangementUpdate,
  repositoryIcon,
  repositoryLabel,
  repositoryMemberLabel,
  repositoryOpenTarget,
  repositoryTileColor,
  type MergedProject,
} from "@/lib/federation/sidebar-layout";
import { openMachineWorkspace, openRepository } from "@/lib/federation/open-workspace";
import { getGitHubRepositoryUrl } from "@/lib/gitUrl";
import { updatePortalLayout, usePortalLayout } from "@/lib/portal/portal-layout";
import { portalStore } from "@/lib/portal/portal-store";
import {
  normalizeProjectFolderName,
  parseProjectFolderDragId,
  projectFolderKey,
  projectSortableIds,
  resolveProjectArrangement,
  resolveRenameProjectFolder,
  resolveSortProjectFolder,
  resolveUngroupProjectFolder,
  type ProjectArrangement,
  type ProjectTreeEntry,
} from "@/lib/project-folders";
import { machineTextClass } from "@/lib/federation/machine-colors";
import {
  currencyDescription,
  currencyLacksText,
  currencyOffersUpdate,
  machineViewCurrency,
} from "@/lib/federation/fleet-currency";
import { requestMachineUpdate } from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";
import {
  machineCollisionDetection,
  machineKeyboardCoordinates,
  sidebarCollisionDetection,
} from "@/lib/sidebar-collision";
import {
  sidebarFolderKey,
  useMachineViewStore,
  type OpenedRepository,
} from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIStore, type ActivitySortOrder } from "@/stores/uiStore";
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import {
  ActivityEnvironmentList,
  type ActivityCreateTarget,
} from "@/components/sidebar/ActivityEnvironmentList";
import {
  ProjectHomeActivityButton,
  projectHomeStatus,
} from "@/components/sidebar/ProjectHomeActivity";
import { compareActivity, type ActivitySortKey } from "@/lib/activity-order";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import { useFederation } from "./FederationProvider";
import { CommandNodeHomeIcon, machineStatusText } from "./MachineDot";
import {
  RemoteEnvironmentItem,
  RemoteMachineTree,
  RemoteProjectGroup,
  openWebPage,
  remoteEnvironmentProject,
  useRemoteEnvironments,
} from "./RemoteMachineTree";
import { UnknownOutcomesNotice } from "./UnknownOutcomesNotice";
import { newFederatedEnvironment } from "./useFederatedEnvironmentActions";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function reportLayoutError(error: unknown): void {
  toast.error("Could not save the sidebar order", {
    description: error instanceof Error ? error.message : String(error),
  });
}

function useDragSensors(coordinateGetter: KeyboardCoordinateGetter = sortableKeyboardCoordinates) {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter,
    }),
  );
}

/**
 * A machine's version beside its heading, when it differs from the command
 * node's, with the contract domains it lacks (plan item 5006). Behind the
 * command node it is a button that opens the machine's update.
 */
function MachineVersionSkew({ machine }: { machine: MachineView }) {
  // The command node's release, from the same portal read as every machine's.
  const commandRelease = useStore(portalStore.store, (state) => state.commandRelease);
  const currency = machineViewCurrency(machine, { commandRelease });
  if (!currency) return null;
  const lacks = currencyLacksText(currency);
  const description = currencyDescription(machine.name, currency);
  const content = (
    <>
      {currencyOffersUpdate(currency) ? (
        <ArrowUpCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
      ) : null}
      <span className="shrink-0 font-mono">{currency.version}</span>
      {lacks ? <span className="min-w-0 truncate opacity-80">· {lacks}</span> : null}
    </>
  );
  const className =
    // Shrinks well before the machine name does: the name is what the header is for.
    "flex min-w-0 max-w-[50%] shrink-[8] items-center gap-1 rounded px-1 text-[10px] leading-4";
  if (!currencyOffersUpdate(currency)) {
    return (
      <span
        className={cn(className, "text-muted-foreground")}
        title={description}
        data-testid="machine-version-skew"
        data-relation={currency.relation}
      >
        <span className="sr-only">{description}</span>
        <span aria-hidden="true" className="flex min-w-0 items-center gap-1">
          {content}
        </span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => requestMachineUpdate(machine.backendId)}
      className={cn(
        className,
        "text-amber-400/90 hover:bg-amber-400/10 hover:text-amber-300 outline-none focus-hairline",
      )}
      title={`${description} Update it.`}
      aria-label={`Update ${machine.name}. ${description}`}
      data-testid="machine-version-skew"
      data-relation={currency.relation}
    >
      {content}
    </button>
  );
}

/**
 * A machine heading: its name in the machine's colour, its version when it
 * differs from the command node's and, while it is unreachable or catching
 * up, its status, never activity. The name moves the whole section; the
 * chevron last collapses it.
 */
export function MachineSectionHeader({
  machine,
  collapsed,
  onToggle,
  dragHandle,
}: {
  machine: MachineView;
  collapsed?: boolean;
  onToggle?: () => void;
  /** Drag attributes and listeners for the name, which moves the whole section. */
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
  const catchingUp = !machine.bound && live && machine.freshness === "catching-up";
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div
      className="sticky top-0 z-[5] flex h-8 items-center gap-2 border-b border-border/50 bg-sidebar/95 pr-3 pl-1 backdrop-blur-sm"
      data-testid="machine-section-header"
      data-machine={machine.connectionId}
    >
      <div
        {...dragHandle}
        {...(dragHandle ? { "aria-label": `Move ${machine.name}` } : {})}
        className={cn(
          "flex h-6 min-w-0 flex-[1_1_auto] items-center gap-2 rounded-md px-2",
          dragHandle && "cursor-grab active:cursor-grabbing",
        )}
      >
        <span
          data-machine-color={machine.colorToken ?? "neutral"}
          title={`${machine.name} · ${status}`}
          className={cn(
            "min-w-0 truncate text-xs font-semibold uppercase tracking-wide",
            machineTextClass(machine.colorToken),
          )}
        >
          {machine.name}
        </span>
      </div>
      <MachineVersionSkew machine={machine} />
      {!live || catchingUp ? (
        <span
          className="flex shrink-0 items-center gap-1 text-[11px] text-amber-400"
          title={machine.transportDetail}
        >
          {!live ? <WifiOff className="h-3 w-3" aria-hidden="true" /> : null}
          {status}
        </span>
      ) : null}
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${machine.name}`}
          aria-expanded={!collapsed}
        >
          <Chevron className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
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
        machine.transport === "connected" || machine.transport === "connecting" ? (
          <SidebarEmptyState loading />
        ) : (
          // Only another machine can be unreachable; its own sidebar has no such state.
          <p className="px-3 py-2 text-xs text-muted-foreground">Not available yet.</p>
        )
      ) : machine.projects.length === 0 ? (
        <SidebarEmptyState
          onAdd={
            isMachineWritable(machine)
              ? () =>
                  openMachineWorkspace({
                    connectionId: machine.connectionId,
                    projectId: "",
                    title: "Add project",
                  })
              : undefined
          }
        />
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
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `${MACHINE_DRAG_PREFIX}${machine.connectionId}`,
    disabled: !sortable,
  });
  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "relative z-50 opacity-50")}
      aria-label={`${machine.name} projects`}
      data-testid={machine.bound ? "bound-machine-section" : "remote-machine-section"}
    >
      <MachineSectionHeader
        machine={machine}
        collapsed={collapsed}
        onToggle={() => setMachineCollapsed(machine.connectionId)}
        dragHandle={
          sortable ? { ...attributes, ...listeners, ref: setActivatorNodeRef } : undefined
        }
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
  const sensors = useDragSensors(machineKeyboardCoordinates);
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
    // A machine's section spans its heading and its whole tree, so comparing
    // centres sends a drop on an expanded machine's heading to its neighbour.
    // The section under the pointer is the target, with a nearest-section
    // fallback outside the list. Keyboard movement aligns adjacent headings.
    <DndContext
      sensors={sensors}
      collisionDetection={machineCollisionDetection}
      onDragEnd={handleDragEnd}
    >
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
 * The repository heading that opened what the window shows, while it still
 * shows that project with nothing else selected; `null` otherwise.
 */
function useShownRepositoryHeading(machines: readonly MachineView[]): OpenedRepository | null {
  const opened = useMachineViewStore((state) => state.openedRepository);
  const target = opened
    ? machines.find((machine) =>
        machine.projects.some((project) => project.key === opened.projectKey),
      )
    : undefined;
  const projectId = target?.projects.find((project) => project.key === opened?.projectKey)?.ref
    .projectId;
  const homeId = target?.environmentsByProject
    .get(projectId ?? "")
    ?.find((environment) => environment.isProjectHome && !environment.deleting)?.ref.environmentId;
  const localHomeId = useEnvironmentStore(
    (state) =>
      state.environments.find(
        (environment) => environment.projectId === projectId && environment.projectHome,
      )?.id,
  );
  const remoteShown = useRemoteWorkspaceStore((state) =>
    state.active === null
      ? null
      : state.active.nodeId === target?.connectionId &&
        state.active.projectId === projectId &&
        (state.active.environmentId === null ||
          state.active.projectHome === true ||
          state.active.environmentId === homeId),
  );
  const localShown = useUIStore(
    (state) =>
      state.selectedProjectId === projectId &&
      (state.selectedEnvironmentId === null || state.selectedEnvironmentId === localHomeId),
  );
  if (!opened || !target || projectId === undefined) return null;
  return (remoteShown ?? (target.bound && localShown)) ? opened : null;
}

/**
 * A repository heading's context menu, acting on the member the heading opens:
 * the same project, machine and dialogs that member's own header menu reaches.
 */
function repositoryMenuActions(
  repository: string,
  opens: MergedProject,
  openCoordinator: (() => void) | undefined,
): RepositoryMenuActions {
  const { machine, project } = opens;
  const githubUrl = getGitHubRepositoryUrl(`https://${repository}`);
  const target = {
    connectionId: machine.connectionId,
    projectId: project.ref.projectId,
    title: project.name,
  };
  return {
    machineName: machine.name,
    writable: isMachineWritable(machine),
    ...(openCoordinator ? { openCoordinator } : {}),
    openBoard: () => openMachineWorkspace({ ...target, boardTab: "kanban" }),
    ...(githubUrl ? { openGithub: () => openWebPage(githubUrl) } : {}),
    openSettings: () => openMachineWorkspace({ ...target, dialog: "repository-settings" }),
    newEnvironment: () => newFederatedEnvironment(machine, project),
  };
}

/** Where a merged list's folder (or repository group) keeps its collapsed state. */
export function mergedFolderCollapseKey(mode: "project" | "repository", name: string): string {
  return sidebarFolderKey(mode, mode === "repository" ? name : projectFolderKey(name));
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
  boundLoading = false,
  onAddProject,
}: {
  /** Every known machine, in machine order. */
  machines: readonly MachineView[];
  /** Machines whose projects are shown (connected, and not filtered out). */
  shownIds: ReadonlySet<string>;
  mode: "project" | "repository";
  /** A project of this window's own machine, with its drag id and the label to show. */
  renderBoundProject: (
    projectId: string,
    sortableId: string,
    label: string | undefined,
  ) => ReactNode;
  /** An environment of this window's own machine was dropped. */
  onBoundEnvironmentDragEnd: (activeId: string, overId: string) => void;
  /** This window's own projects are still loading. */
  boundLoading?: boolean;
  /** "Add your first project" while the list is empty: this window's Add Project dialog. */
  onAddProject?: () => void;
}) {
  const layout = usePortalLayout();
  const { portalState } = useFederation();
  const collapsedProjectKeys = useMachineViewStore((state) => state.collapsedProjectKeys);
  const collapsedFolderKeys = useMachineViewStore((state) => state.collapsedFolderKeys);
  const setProjectKeyCollapsed = useMachineViewStore((state) => state.setProjectKeyCollapsed);
  const setFolderKeyCollapsed = useMachineViewStore((state) => state.setFolderKeyCollapsed);
  const { environmentsOf, reorder } = useRemoteEnvironments();
  const openedRepository = useShownRepositoryHeading(machines);
  const [draggingProject, setDraggingProject] = useState(false);
  const [dragItem, setDragItem] = useState<SidebarDragItem>(null);
  const sensors = useDragSensors();

  const { list, tree } = useMemo(
    () => mergedProjectView(machines, shownIds, mode, layout, portalState.selfId),
    [layout, machines, mode, portalState.selfId, shownIds],
  );
  const projectIds = useMemo(() => new Set(list.shown.map((item) => item.id)), [list.shown]);
  const folderCollapseKey = (name: string) => mergedFolderCollapseKey(mode, name);
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
  // A repository's members reorder only among themselves.
  const sortingStrategy = projectTreeSortingStrategy(tree, sortableIds, {
    crossFolderMoves: mode === "project",
  });
  const isProjectDrag = (id: string) => parseProjectFolderDragId(id) !== null || projectIds.has(id);
  const apply = (arrangement: ProjectArrangement | null) => {
    const update =
      mode === "project"
        ? mergedArrangementUpdate(list, machines, layout, arrangement)
        : repositoryArrangementUpdate(list, machines, arrangement);
    if (update) updatePortalLayout(update).catch(reportLayoutError);
  };

  const handleDragStart = ({ active }: DragStartEvent) => {
    const id = String(active.id);
    setDraggingProject(isProjectDrag(id));
    const project = list.shown.find((item) => item.id === id);
    setDragItem(
      folderDragItem(tree, id, mode === "repository" ? repositoryLabel : undefined) ??
        (project
          ? { kind: "project", name: project.project.name }
          : machineEnvironmentDragItem(machines, id)),
    );
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setDraggingProject(false);
    setDragItem(null);
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
        grouping={mode}
        showMachine={mode === "project"}
        label={label}
        labelClassName={
          mode === "repository" ? machineTextClass(item.machine.colorToken) : undefined
        }
      />
    );
  const commandNode = machines.find((machine) => machine.backendId === portalState.selfId);
  const repositorySummary = (group: readonly MergedProject[]) => {
    const machineCount = new Set(group.map((item) => item.machine.connectionId)).size;
    const environmentCount = group.reduce(
      (total, item) => total + environmentsOf(item.machine, item.project).length,
      0,
    );
    return `${plural(machineCount, "machine")} · ${plural(environmentCount, "environment")}`;
  };

  const renderEntry = (entry: ProjectTreeEntry<MergedProject>, index: number) => {
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
      mode === "repository" ? repositoryOpenTarget(entry.projects, portalState.selfId) : null;
    const coordinatorGated = opens?.machine.bound === true && portalState.status?.mode === "leaf";
    const openOpens = opens
      ? () =>
          openRepository({
            repository: entry.name,
            projectKey: opens.id,
            connectionId: opens.machine.connectionId,
            projectId: opens.project.ref.projectId,
            coordinatorGated,
            title: opens.name,
          })
      : undefined;
    return (
      <SortableProjectFolder
        key={`folder:${entry.key}`}
        name={entry.name}
        sortableId={mode === "repository" ? `project-folder:${entry.key}` : undefined}
        label={mode === "repository" ? repositoryLabel(entry.name) : entry.name}
        repository={mode === "repository"}
        repositorySeparator={mode === "repository" && index > 0}
        {...(mode === "repository"
          ? {
              icon: (
                <CommandNodeHomeIcon
                  colorToken={repositoryTileColor(commandNode, entry.name, opens)}
                  projectIcon={repositoryIcon(machines, commandNode, entry.name)}
                />
              ),
              subtitle: repositorySummary(entry.projects),
            }
          : {})}
        projectCount={entry.projects.length}
        isCollapsed={isFolderCollapsed(entry.name)}
        onToggleCollapse={() => setFolderKeyCollapsed(folderCollapseKey(entry.name))}
        selected={opens !== null && openedRepository?.name === entry.name}
        onOpen={openOpens}
        openMachineName={opens?.machine.name}
        {...(opens
          ? {
              repositoryMenu: repositoryMenuActions(
                entry.name,
                opens,
                coordinatorGated ? undefined : openOpens,
              ),
            }
          : {})}
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
  };

  return (
    <div
      className="py-1"
      data-testid={mode === "project" ? "federated-project-list" : "federated-repository-list"}
    >
      {list.shown.length === 0 ? (
        <SidebarEmptyState
          loading={
            boundLoading ||
            machines.some(
              (machine) =>
                !machine.bound && shownIds.has(machine.connectionId) && machine.loadedAt === null,
            )
          }
          onAdd={onAddProject}
        />
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={sidebarCollisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          setDraggingProject(false);
          setDragItem(null);
        }}
      >
        <SortableContext items={sortableIds} strategy={sortingStrategy}>
          {tree.map(renderEntry)}
          <SidebarRootDropZone active={draggingProject && mode === "project"} />
        </SortableContext>
        <SidebarDragOverlay item={dragItem} />
      </DndContext>
    </div>
  );
}

/**
 * "By activity" across machines: the same list this window shows on its own,
 * over every shown machine's environments in the shared activity order. This
 * window's rows and homes are drawn by its own components; other machines'
 * by theirs, from their summaries.
 */
export function FederatedActivityList({
  machines,
  order = "priority",
  renderBoundRow,
  boundActivity,
  renderBoundHome = () => null,
  boundSelectedId = null,
  onCreateBound,
  boundWaitingCount = 0,
}: {
  machines: readonly MachineView[];
  order?: ActivitySortOrder;
  /** A row of this window's own machine. */
  renderBoundRow: (environmentId: string) => ReactNode;
  /** The activity those rows display, so they sort on what they show. */
  boundActivity?: (environmentId: string) => AgentActivityState | undefined;
  /** The activity button of one of this window's project homes (nothing while quiet). */
  renderBoundHome?: (environmentId: string) => ReactNode;
  /** The environment this window shows, when it is one of its own. */
  boundSelectedId?: string | null;
  /** Opens this window's New Environment dialog for one of its projects. */
  onCreateBound?: (projectId: string) => void;
  /** This window's waiting count, from its runtime activity. */
  boundWaitingCount?: number;
}) {
  const active = useRemoteWorkspaceStore((state) => state.active);
  const multiSelecting = useUIStore((state) => state.selectedEnvironmentIds.length > 0);
  const rows = activityRows(machines, order, boundActivity);
  const mixed = machines.length > 1;
  const createTargets: ActivityCreateTarget[] = machines.flatMap((machine) =>
    isMachineWritable(machine)
      ? machine.projects.map((project) => ({
          key: project.key,
          name: mixed ? `${project.name} · ${machine.name}` : project.name,
          ...(mixed ? { machine: { name: machine.name, colorToken: machine.colorToken } } : {}),
          onSelect: () =>
            machine.bound
              ? onCreateBound?.(project.ref.projectId)
              : newFederatedEnvironment(machine, project),
        }))
      : [],
  );
  const homes = activityHomes(machines, order);
  const remoteWaiting = machines
    .filter((machine) => !machine.bound)
    .flatMap((machine) => [...machine.environmentsByProject.values()].flat())
    .filter(
      (environment) =>
        !environment.deleting &&
        (environment.hasUnreadWork ||
          (environment.isProjectHome && environment.activity === "waiting")),
    ).length;
  return (
    <ActivityEnvironmentList
      testId="federated-activity-list"
      createTargets={createTargets}
      totalCount={rows.length}
      waitingCount={
        (machines.some((machine) => machine.bound) ? boundWaitingCount : 0) + remoteWaiting
      }
      homes={homes.map(({ machine, environment, project }) =>
        machine.bound ? (
          <div key={environment.key}>{renderBoundHome(environment.ref.environmentId)}</div>
        ) : (
          <RemoteActivityHome
            key={environment.key}
            machine={machine}
            environment={environment}
            projectName={project?.name ?? "Unknown project"}
          />
        ),
      )}
      rows={rows.map((row) => {
        const environmentId = row.environment.ref.environmentId;
        return row.machine.bound
          ? {
              key: row.environment.key,
              environmentId,
              selected: boundSelectedId === environmentId,
              content: renderBoundRow(environmentId),
            }
          : {
              key: row.environment.key,
              environmentId,
              selected:
                !multiSelecting &&
                active?.nodeId === row.machine.connectionId &&
                active.environmentId === environmentId,
              offline: row.machine.transport !== "connected",
              data: {
                "data-testid": "federated-environment-row",
                "data-machine": row.machine.connectionId,
                "data-selected":
                  (active?.nodeId === row.machine.connectionId &&
                    active.environmentId === environmentId) ||
                  undefined,
              },
              content: (
                <RemoteEnvironmentItem
                  machine={row.machine}
                  environment={row.environment}
                  subtitle={row.project?.name ?? "Unknown project"}
                />
              ),
            };
      })}
    />
  );
}

/** Every shown machine's project homes, in the shared activity order. */
function activityHomes(machines: readonly MachineView[], order: ActivitySortOrder) {
  return machines
    .flatMap((machine) =>
      machine.projects.flatMap((project) =>
        (machine.environmentsByProject.get(project.ref.projectId) ?? [])
          .filter((environment) => environment.isProjectHome && !environment.deleting)
          .map((environment) => ({ machine, project, environment })),
      ),
    )
    .sort((a, b) =>
      compareActivity(
        activitySortKey(a.machine, a.environment, a.project.order),
        activitySortKey(b.machine, b.environment, b.project.order),
        order,
      ),
    );
}

function activitySortKey(
  machine: MachineView,
  environment: FederatedEnvironment,
  projectOrder: number,
): ActivitySortKey {
  return {
    hasUnreadWork: environment.hasUnreadWork,
    activity: environment.buildActive ? "working" : environment.activity,
    activityUpdatedAt: environment.activityUpdatedAt,
    lastActivityAt: environment.lastActivityAt,
    prState: environment.prState,
    machineId: machine.backendId,
    projectOrder,
    order: environment.order,
    id: environment.ref.environmentId,
  };
}

/** Another machine's project home in the activity list, by the rule this window's homes follow. */
function RemoteActivityHome({
  machine,
  environment,
  projectName,
}: {
  machine: MachineView;
  environment: FederatedEnvironment;
  projectName: string;
}) {
  const status =
    machine.transport === "connected"
      ? projectHomeStatus({
          deleting: environment.deleting,
          buildActive: environment.buildActive === true,
          activity: environment.buildActive ? "working" : environment.activity,
          hasUnreadWork: environment.hasUnreadWork,
        })
      : null;
  if (!status) return null;
  return (
    <ProjectHomeActivityButton
      status={status}
      projectName={projectName}
      onOpen={() =>
        openMachineWorkspace({
          connectionId: machine.connectionId,
          projectId: environment.projectId,
          environmentId: environment.ref.environmentId,
          boardTab: "home",
          title: projectName,
        })
      }
    />
  );
}
