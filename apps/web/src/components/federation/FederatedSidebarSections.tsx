import type { ReactNode } from "react";
import { isMachineWritable, activityRows, type MachineView } from "@/lib/federation/aggregate";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIStore, type ActivitySortOrder } from "@/stores/uiStore";
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import {
  ActivityEnvironmentList,
  type ActivityCreateTarget,
} from "@/components/sidebar/ActivityEnvironmentList";
import { compareActivity, type ActivitySortKey } from "@/lib/activity-order";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import { RemoteEnvironmentItem, RemoteProjectHomeActivity } from "./RemoteMachineTree";
import { newFederatedEnvironment } from "./useFederatedEnvironmentActions";

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
          (environment.isProjectHome &&
            (environment.activity === "waiting" || environment.hasWaitingNativeTab))),
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
          <RemoteProjectHomeActivity
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
