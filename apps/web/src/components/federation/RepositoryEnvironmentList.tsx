import { useMemo, useState, type ReactNode } from "react";
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
  verticalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { toast } from "sonner";
import { SortableProjectFolder } from "@/components/sidebar/SortableProjectFolder";
import { SortableEnvironmentRowFrame } from "@/components/sidebar/EnvironmentRowFrame";
import { SidebarDragOverlay, type SidebarDragItem } from "@/components/sidebar/SidebarDragOverlay";
import { SidebarEmptyState } from "@/components/sidebar/SidebarEmptyState";
import { isMachineWritable, type MachineView } from "@/lib/federation/aggregate";
import {
  byMachineDropTarget,
  manualOrderAfterDrop,
  orderRepository,
  repositoryEntries,
  repositoryOrderAfterMove,
  type EnvironmentOrdering,
  type ListedEnvironment,
  type OrderedRepository,
  type RepositoryEntry,
} from "@/lib/federation/environment-list";
import { openRepository } from "@/lib/federation/open-workspace";
import { repositoryIcon, repositoryTileColor } from "@/lib/federation/sidebar-layout";
import { getGitHubRepositoryUrl } from "@/lib/gitUrl";
import { updatePortalLayout, usePortalLayout } from "@/lib/portal/portal-layout";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import {
  machineCollisionDetection,
  machineKeyboardCoordinates,
  sidebarCollisionDetection,
} from "@/lib/sidebar-collision";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useProjectCopyStore } from "@/stores/projectCopyStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIStore } from "@/stores/uiStore";
import type { RepositoryMenuActions } from "@/components/sidebar/SortableProjectFolder";
import { useFederation } from "./FederationProvider";
import { CommandNodeHomeIcon } from "./MachineDot";
import {
  openWebPage,
  RemoteProjectHomeActivity,
  RemoteSortableEnvironmentItem,
  useRemoteEnvironments,
} from "./RemoteMachineTree";
import { UnknownOutcomesNotice } from "./UnknownOutcomesNotice";
import { newFederatedEnvironment } from "./useFederatedEnvironmentActions";
import { repositoryCollapseKey } from "./useRevealMachineProject";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function reportLayoutError(error: unknown): void {
  toast.error("Could not save the sidebar order", {
    description: error instanceof Error ? error.message : String(error),
  });
}

/** "2 machines · 5 environments", or only the machines while it has no environments. */
export function repositorySubtitle(machineCount: number, environmentCount: number): string {
  return environmentCount === 0
    ? plural(machineCount, "machine")
    : `${plural(machineCount, "machine")} · ${plural(environmentCount, "environment")}`;
}

/**
 * The project the window shows at project level (its page, or its home),
 * by node-qualified key, or null while it shows an environment or nothing.
 */
function useShownProjectKey(machines: readonly MachineView[]): string | null {
  const active = useRemoteWorkspaceStore((state) => state.active);
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const localHomeSelected = useEnvironmentStore((state) =>
    selectedEnvironmentId
      ? state.environments.find((environment) => environment.id === selectedEnvironmentId)
          ?.projectHome === true
      : false,
  );
  if (active) {
    const machine = machines.find((candidate) => candidate.connectionId === active.nodeId);
    const project = machine?.projects.find((entry) => entry.ref.projectId === active.projectId);
    if (!machine || !project) return null;
    const homeId = machine.environmentsByProject
      .get(project.ref.projectId)
      ?.find((environment) => environment.isProjectHome && !environment.deleting)
      ?.ref.environmentId;
    const projectLevel =
      active.environmentId === null ||
      active.projectHome === true ||
      active.environmentId === homeId;
    return projectLevel ? project.key : null;
  }
  const bound = machines.find((machine) => machine.bound);
  if (!bound || !selectedProjectId || (selectedEnvironmentId && !localHomeSelected)) return null;
  return bound.projects.find((project) => project.ref.projectId === selectedProjectId)?.key ?? null;
}

export interface BoundEnvironmentRendering {
  /** A row of this window's own machine, with its full controls. */
  renderEnvironment: (environmentId: string) => ReactNode;
  /** The environment this window shows, when it is one of its own. */
  selectedEnvironmentId: string | null;
  /** A drop among this window's own rows (environment IDs). */
  onDragEnd: (activeId: string, overId: string) => void;
  /** The compact activity button of one of its project homes (nothing while quiet). */
  renderHome?: (projectId: string) => ReactNode;
  /** Opens this window's New Environment dialog for one of its projects. */
  onCreate: (projectId: string) => void;
}

/**
 * The multi-machine sidebar's list (design EL01): one heading per repository
 * with every environment listed flat beneath it, whichever machine it is on;
 * each row's status marker names the machine by colour. A project that
 * reports no repository is a heading of its own.
 *
 * Headings are dragged to reorder repositories (`repositoryOrder`). Rows
 * follow `ordering`: by machine, a row moves only within its own machine's
 * run and the order is written to that machine; manually, a row goes
 * anywhere in its repository and the order is kept on the command node
 * (`environment-list.ts`).
 */
export function RepositoryEnvironmentList({
  machines,
  shownIds,
  listedIds = shownIds,
  ordering,
  bound,
  boundLoading = false,
  onAddProject,
  showEmptyState = true,
}: {
  /** Every known machine, in machine order. */
  machines: readonly MachineView[];
  /** Machines whose environments are shown (connected, and not filtered out). */
  shownIds: ReadonlySet<string>;
  /** Machines the filter shows, connected or not: their notices are shown. */
  listedIds?: ReadonlySet<string>;
  ordering: EnvironmentOrdering;
  bound: BoundEnvironmentRendering;
  /** This window's own projects are still loading. */
  boundLoading?: boolean;
  /** "Add your first project" while the list is empty: this window's Add Project dialog. */
  onAddProject?: () => void;
  /** Off where another list above already says the sidebar is empty. */
  showEmptyState?: boolean;
}) {
  const layout = usePortalLayout();
  const { portalState } = useFederation();
  const collapsedFolderKeys = useMachineViewStore((state) => state.collapsedFolderKeys);
  const setFolderKeyCollapsed = useMachineViewStore((state) => state.setFolderKeyCollapsed);
  const revealed = useMachineViewStore((state) => state.revealedProject);
  const { environmentsOf, reorder } = useRemoteEnvironments();
  const shownProjectKey = useShownProjectKey(machines);
  const headingSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: machineKeyboardCoordinates }),
  );

  const repositories = useMemo(
    () => repositoryEntries(machines, shownIds, layout, portalState.selfId),
    [layout, machines, portalState.selfId, shownIds],
  );
  const commandNode = machines.find((machine) => machine.backendId === portalState.selfId);

  const handleHeadingDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const update = repositoryOrderAfterMove(
      repositories,
      machines,
      String(active.id),
      String(over.id),
    );
    if (update) updatePortalLayout(update).catch(reportLayoutError);
  };

  const renderEntry = (entry: RepositoryEntry) => {
    const ordered = orderRepository(entry, machines, ordering, layout, environmentsOf);
    const opens =
      entry.members.find((member) => member.machine.backendId === portalState.selfId) ??
      entry.members[0]!;
    const collapsed = collapsedFolderKeys.includes(repositoryCollapseKey(entry.key));
    const coordinatorGated = opens.machine.bound && portalState.status?.mode === "leaf";
    const open = (coordinator = false) =>
      openRepository({
        repository: entry.key,
        projectKey: opens.id,
        connectionId: opens.machine.connectionId,
        projectId: opens.project.ref.projectId,
        coordinatorGated,
        coordinator,
        title: opens.name,
      });
    const create = (member: RepositoryEntry["members"][number]) =>
      member.machine.bound
        ? bound.onCreate(member.project.ref.projectId)
        : newFederatedEnvironment(member.machine, member.project);
    const githubUrl = entry.repository
      ? getGitHubRepositoryUrl(`https://${entry.repository}`)
      : null;
    const target = {
      connectionId: opens.machine.connectionId,
      projectId: opens.project.ref.projectId,
      title: opens.project.name,
    };
    const menu: RepositoryMenuActions = {
      machineName: opens.machine.name,
      writable: isMachineWritable(opens.machine),
      ...(coordinatorGated ? {} : { openCoordinator: () => open(true) }),
      openBoard: () => openMachineWorkspace({ ...target, boardTab: "kanban" }),
      ...(githubUrl ? { openGithub: () => openWebPage(githubUrl) } : {}),
      openSettings: () => openMachineWorkspace({ ...target, dialog: "repository-settings" }),
      newEnvironment: () => create(opens),
      copyToMachine: () =>
        useProjectCopyStore.getState().open({
          source: { nodeId: opens.machine.backendId, projectId: opens.project.ref.projectId },
        }),
      deleteProject: () => openMachineWorkspace({ ...target, dialog: "delete-project" }),
      newEnvironmentOn: entry.members
        .filter((member) => member !== opens)
        .map((member) => ({
          key: member.id,
          machineName:
            member.machine === opens.machine
              ? `${member.machine.name} (${member.name})`
              : member.machine.name,
          writable: isMachineWritable(member.machine),
          onSelect: () => create(member),
        })),
    };
    const homes = entry.members.map((member) => {
      if (member.machine.bound) {
        const home = bound.renderHome?.(member.project.ref.projectId);
        return home ? <span key={member.id}>{home}</span> : null;
      }
      const home = (
        member.machine.environmentsByProject.get(member.project.ref.projectId) ?? []
      ).find((environment) => environment.isProjectHome && !environment.deleting);
      return home ? (
        <RemoteProjectHomeActivity
          key={member.id}
          machine={member.machine}
          environment={home}
          projectName={member.name}
          compact
        />
      ) : null;
    });
    const machineCount = new Set(entry.members.map((member) => member.machine.connectionId)).size;
    const isRevealed = revealed !== null && entry.allMembers.some((m) => m.id === revealed.key);
    return (
      <SortableProjectFolder
        key={entry.dragId}
        name={entry.key}
        sortableId={entry.dragId}
        label={entry.label}
        repository
        icon={
          <CommandNodeHomeIcon
            colorToken={repositoryTileColor(commandNode, entry.repository ?? "", opens)}
            projectIcon={
              entry.repository
                ? repositoryIcon(machines, commandNode, entry.repository)
                : opens.project.icon
            }
          />
        }
        subtitle={repositorySubtitle(machineCount, ordered.rows.length)}
        projectCount={entry.members.length}
        isCollapsed={collapsed}
        onToggleCollapse={() => setFolderKeyCollapsed(repositoryCollapseKey(entry.key))}
        selected={shownProjectKey !== null && entry.members.some((m) => m.id === shownProjectKey)}
        revealRevision={isRevealed ? revealed.revision : null}
        onOpen={() => open()}
        openMachineName={opens.machine.name}
        repositoryMenu={menu}
        trailing={homes.some(Boolean) ? <span className="flex shrink-0">{homes}</span> : null}
        addAction={{
          label: `New environment in ${entry.label}`,
          title: isMachineWritable(opens.machine)
            ? `New environment on ${opens.machine.name}`
            : `${opens.machine.name} is unavailable`,
          disabled: !isMachineWritable(opens.machine),
          onAdd: () => create(opens),
        }}
      >
        {ordered.rows.length > 0 ? (
          <RepositoryRows
            entry={entry}
            ordered={ordered}
            machines={machines}
            ordering={ordering}
            bound={bound}
            onRemoteReorder={(row, overId) => reorder(row.machine, row.project, row.id, overId)}
          />
        ) : null}
      </SortableProjectFolder>
    );
  };

  return (
    <div className="py-1" data-testid="federated-repository-list" data-ordering={ordering}>
      <MachineListNotices
        machines={machines.filter((m) => !m.bound && listedIds.has(m.connectionId))}
      />
      {showEmptyState && repositories.entries.length === 0 ? (
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
        sensors={headingSensors}
        collisionDetection={machineCollisionDetection}
        onDragEnd={handleHeadingDragEnd}
      >
        <SortableContext
          items={repositories.entries.map((entry) => entry.dragId)}
          strategy={verticalListSortingStrategy}
        >
          {repositories.entries.map(renderEntry)}
        </SortableContext>
      </DndContext>
    </div>
  );
}

/** Whether two rows are in the same by-machine run: one project on one machine. */
function sameRun(left: ListedEnvironment, right: ListedEnvironment): boolean {
  return (
    left.machine.connectionId === right.machine.connectionId &&
    left.project.key === right.project.key
  );
}

/**
 * One repository's rows, in their own drag context: a row never leaves its
 * repository. By machine the preview moves only within the dragged row's run,
 * and a drop outside it is refused.
 */
function RepositoryRows({
  entry,
  ordered,
  machines,
  ordering,
  bound,
  onRemoteReorder,
}: {
  entry: RepositoryEntry;
  ordered: OrderedRepository;
  machines: readonly MachineView[];
  ordering: EnvironmentOrdering;
  bound: BoundEnvironmentRendering;
  onRemoteReorder: (row: ListedEnvironment, overId: string) => void;
}) {
  const layout = usePortalLayout();
  const multiSelecting = useUIStore((state) => state.selectedEnvironmentIds.length > 0);
  const [dragItem, setDragItem] = useState<SidebarDragItem>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const { rows } = ordered;
  const strategy: SortingStrategy = (args) => {
    const active = rows[args.activeIndex];
    const over = rows[args.overIndex];
    if (ordering === "machine" && active && over && !sameRun(active, over)) return null;
    return verticalListSortingStrategy(args);
  };
  const rowSortable = (row: ListedEnvironment) =>
    ordering === "manual" || (isMachineWritable(row.machine) && !row.machine.truncated);

  const handleDragStart = ({ active }: DragStartEvent) => {
    const row = rows.find((candidate) => candidate.id === String(active.id));
    setDragItem(row ? { kind: "environment", name: row.environment.name } : null);
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setDragItem(null);
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (ordering === "manual") {
      const environmentOrder = manualOrderAfterDrop(
        entry,
        ordered,
        machines,
        layout,
        activeId,
        overId,
      );
      if (environmentOrder) updatePortalLayout({ environmentOrder }).catch(reportLayoutError);
      return;
    }
    const target = byMachineDropTarget(rows, activeId, overId);
    if (!target || !rowSortable(target.active)) return;
    if (target.active.machine.bound) {
      bound.onDragEnd(
        target.active.environment.ref.environmentId,
        target.over.environment.ref.environmentId,
      );
    } else {
      onRemoteReorder(target.active, overId);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sidebarCollisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDragItem(null)}
    >
      <SortableContext items={rows.map((row) => row.id)} strategy={strategy}>
        {rows.map((row) =>
          row.machine.bound ? (
            <SortableEnvironmentRowFrame
              key={row.id}
              sortableId={row.id}
              sortable={rowSortable(row)}
              selected={
                !multiSelecting && bound.selectedEnvironmentId === row.environment.ref.environmentId
              }
              name={row.environment.name}
              data={{
                "data-testid": "repository-environment-row",
                "data-machine": row.machine.connectionId,
              }}
            >
              {bound.renderEnvironment(row.environment.ref.environmentId)}
            </SortableEnvironmentRowFrame>
          ) : (
            <RemoteSortableEnvironmentItem
              key={row.id}
              machine={row.machine}
              environment={row.environment}
              sortable={rowSortable(row)}
            />
          ),
        )}
      </SortableContext>
      <SidebarDragOverlay item={dragItem} />
    </DndContext>
  );
}

/**
 * What the list cannot show of the machines it lists: writes whose outcome is
 * unknown, and a machine whose list is incomplete. A machine that is not
 * connected is dimmed in its tile; its environments return when it reconnects.
 */
function MachineListNotices({ machines }: { machines: readonly MachineView[] }) {
  return (
    <>
      {machines.map((machine) => (
        <div key={machine.connectionId} data-machine={machine.connectionId}>
          <UnknownOutcomesNotice connectionId={machine.connectionId} />
          {machine.truncated ? (
            <p className="px-3 py-1 text-[11px] text-muted-foreground">
              Not every project or environment on {machine.name} is shown here.
            </p>
          ) : null}
        </div>
      ))}
    </>
  );
}
