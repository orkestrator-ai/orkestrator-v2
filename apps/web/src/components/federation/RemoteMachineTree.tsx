import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { projectLandingBoardTab, type RealmGrouping } from "@/lib/federation/workspace-realm";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { BackendId } from "@orkestrator/protocol/federation";
import { AddToFolderDialog } from "@/components/projects/AddToFolderDialog";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { EnvironmentRow } from "@/components/environments/EnvironmentRow";
import {
  nodeEnvironmentRowFacts,
  nodeEnvironmentTooltipDetails,
} from "@/components/environments/environment-row-facts";
import { EnvironmentAgentSummary } from "@/components/environments/EnvironmentAgentSummary";
import { useHoverTooltip } from "@/components/ui/hover-tooltip";
import { SortableProjectFolder } from "@/components/sidebar/SortableProjectFolder";
import { SidebarRootDropZone } from "@/components/sidebar/SidebarRootDropZone";
import { projectTreeSortingStrategy } from "@/lib/sidebar-sorting";
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
import { SortableEnvironmentRowFrame } from "@/components/sidebar/EnvironmentRowFrame";
import { ProjectGroupHeader } from "@/components/sidebar/ProjectGroupHeader";
import {
  ProjectHomeActivityButton,
  projectHomeStatus,
} from "@/components/sidebar/ProjectHomeActivity";
import { useFederation } from "./FederationProvider";
import { MachineHomeIcon, ProjectIconImage } from "./MachineDot";
import {
  newFederatedEnvironment,
  useFederatedEnvironmentActions,
} from "./useFederatedEnvironmentActions";

const NO_ENVIRONMENTS: readonly FederatedEnvironment[] = [];

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
  const sortingStrategy = projectTreeSortingStrategy(tree, sortableIds);

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
      showMachine
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
      <SortableContext items={sortableIds} strategy={sortingStrategy}>
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
  /** Mark the machine with a home before the name, in lists that name machines. */
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
  const everyEnvironment =
    machine.environmentsByProject.get(project.ref.projectId) ?? NO_ENVIRONMENTS;
  // Shown with its home or nothing else, as this window's own project rows are.
  const home = everyEnvironment.find(
    (environment) => environment.isProjectHome && !environment.deleting,
  );
  const shown = useRemoteProjectHomeShown(
    machine.connectionId,
    project.ref.projectId,
    home?.ref.environmentId,
  );
  const live = machine.transport === "connected";
  const homeStatus =
    home && live
      ? projectHomeStatus({
          deleting: home.deleting,
          buildActive: home.buildActive === true,
          activity: home.activity,
          hasUnreadWork: home.hasUnreadWork,
        })
      : null;
  // Mail is counted per environment on the machine; the project sums them,
  // home included, as this window's project header sums its mailboxes.
  const unreadMail = everyEnvironment.reduce(
    (total, environment) => total + (environment.agentMailUnread ?? 0),
    0,
  );
  const failedMail = everyEnvironment.some((environment) => environment.agentMailFailed);
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
        <ProjectGroupHeader
          projectName={project.name}
          accessibleLabel={`Open ${project.name} on ${machine.name}`}
          label={label}
          labelClassName={labelClassName}
          icon={
            showMachine ? (
              <MachineHomeIcon
                colorToken={machine.colorToken}
                machineName={machine.name}
                projectIcon={project.icon}
              />
            ) : project.icon ? (
              <ProjectIconImage src={project.icon} />
            ) : null
          }
          card={{
            ...(project.repositoryHint ? { repository: project.repositoryHint } : {}),
            ...(project.pathName ? { path: project.pathName } : {}),
            environmentCount: environments.length,
            runningCount: environments.filter((environment) => environment.status === "running")
              .length,
            openHint: `Click to open on ${machine.name}`,
          }}
          unreadMail={unreadMail}
          failedMail={failedMail}
          highlighted={shown || revealed}
          ariaCurrent={shown ? "page" : revealed ? "true" : undefined}
          sortable={sortable}
          dragAttributes={attributes}
          dragListeners={listeners}
          rowRef={rowRef}
          isCollapsed={isCollapsed}
          onOpen={() => openProject()}
          writable={writable}
          menu={{
            openBoard: () => openProject(true),
            ...(githubRepositoryUrl ? { openGithub: () => openWebPage(githubRepositoryUrl) } : {}),
            openSettings: () => openProjectDialog("repository-settings"),
            newEnvironment: () => newFederatedEnvironment(machine, project),
            copyToMachine: () =>
              useProjectCopyStore.getState().open({
                source: { nodeId: machine.backendId, projectId: project.ref.projectId },
              }),
            ...(onAddToFolder ? { addToFolder: onAddToFolder } : {}),
            ...(onRemoveFromFolder ? { removeFromFolder: onRemoveFromFolder } : {}),
            deleteProject: () => openProjectDialog("delete-project"),
          }}
          homeActivity={
            home && homeStatus ? (
              <ProjectHomeActivityButton
                status={homeStatus}
                projectName={project.name}
                compact
                onOpen={() =>
                  openMachineWorkspace({
                    connectionId: machine.connectionId,
                    projectId: project.ref.projectId,
                    environmentId: home.ref.environmentId,
                    boardTab: "home",
                    title: project.name,
                  })
                }
              />
            ) : null
          }
          newEnvironment={{
            label: `New environment in ${project.name} on ${machine.name}`,
            title: writable
              ? `New environment on ${machine.name}`
              : `${machine.name} is unavailable`,
          }}
        />
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
 * An environment of another machine in a project, in the frame this window's
 * rows use. Its drag id is its node-qualified key.
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
  const shown = useRemoteEnvironmentShown(machine.connectionId, environment.ref.environmentId);
  return (
    <SortableEnvironmentRowFrame
      sortableId={environment.key}
      // Read-only while the owner is unavailable.
      sortable={sortable}
      selected={shown}
      offline={machine.transport !== "connected"}
      name={environment.name}
      data={{
        "data-testid": "federated-environment-row",
        "data-machine": machine.connectionId,
        "data-selected": shown || undefined,
      }}
    >
      <RemoteEnvironmentItem machine={machine} environment={environment} />
    </SortableEnvironmentRowFrame>
  );
}

/**
 * The row content of another machine's environment: the same `EnvironmentRow`
 * this window's rows draw, fed from the machine's node summary. Selecting it
 * moves the window to the owner's workspace.
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
  const actions = useFederatedEnvironmentActions(machine, environment);
  const shown = useRemoteEnvironmentShown(machine.connectionId, environment.ref.environmentId);
  // The same `environment-net` projection the machine's own rows show, read
  // through the command node and kept current by the machine's relayed events.
  const changeProjection = useNodeEnvironmentChangeProjection(environment.ref);
  // The hover card reads the full record and agent summary from the machine
  // while it or the delete dialog is open; until then it shows the summary.
  const tooltip = useHoverTooltip();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const details = useNodeEnvironment(environment.ref, tooltip.open || deleteOpen);
  const live = machine.transport === "connected";
  const facts = nodeEnvironmentRowFacts(machine, environment, actions);

  return (
    <EnvironmentRow
      facts={facts}
      selected={shown}
      subtitle={subtitle}
      onActivate={actions.open}
      actions={{
        open: actions.open,
        copyLink: actions.copyLink,
        openSettings: actions.openSettings,
        fork: actions.fork,
        start: actions.start,
        stop: actions.stop,
        restart: actions.restart,
        confirmDelete: actions.remove,
      }}
      changes={changeProjection ? { kind: "projection", projection: changeProjection } : null}
      tooltip={tooltip}
      tooltipDetails={details ?? nodeEnvironmentTooltipDetails(environment)}
      onDeleteOpenChange={setDeleteOpen}
      agentSummary={
        live ? (
          <EnvironmentAgentSummary
            environmentId={environment.ref.environmentId}
            open={tooltip.open}
            source={nodeAgentSummarySource(environment.ref.backendId)}
          />
        ) : null
      }
    />
  );
}
