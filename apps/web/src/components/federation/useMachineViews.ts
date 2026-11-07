import { useMemo } from "react";
import { FALLBACK_MACHINE_COLOR } from "@orkestrator/protocol/backend-profile";
import type { NodeConnectionState } from "@orkestrator/protocol/command-nodes";
import type { ConnectionTransportState } from "@orkestrator/protocol/connections";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import {
  environmentDeletionFailure,
  environmentDeletionStep,
  environmentHasDeletionTombstone,
  NODE_DELETE_FAILURE,
  type NodeSummary,
} from "@orkestrator/protocol/node-summaries";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useEnvironmentStore, useProjectStore } from "@/stores";
import type { MachineView } from "@/lib/federation/aggregate";
import { orderMachines, registryOrder } from "@/lib/federation/sidebar-layout";
import { usePortalLayout } from "@/lib/portal/portal-layout";
import {
  boundedText,
  repositoryHint,
  type FederatedEnvironment,
  type FederatedProject,
} from "@/lib/federation/summaries";
import type { Environment, Project } from "@/types";
import type { MachineRelease } from "@orkestrator/protocol/fleet-currency";
import type { PortalState } from "@/lib/portal/portal-store";
import { useFederation } from "./FederationProvider";

const TRANSPORT_FOR_STATE: Record<NodeConnectionState, ConnectionTransportState> = {
  connecting: "connecting",
  connected: "connected",
  degraded: "connected",
  unavailable: "unreachable",
  quarantined: "trust-blocked",
  "needs-credential": "authentication-required",
  "needs-update": "incompatible",
  suspended: "disabled",
  disabled: "disabled",
};

/** One node of the portal, as the command node reports it. */
export function viewFromNodeSummary(node: NodeSummary): MachineView {
  const environmentsByProject = new Map<string, FederatedEnvironment[]>();
  for (const environment of node.environments) {
    const list = environmentsByProject.get(environment.projectId) ?? [];
    list.push(environment);
    environmentsByProject.set(environment.projectId, list);
  }
  const lastError = node.view.connection.lastError?.message;
  return {
    connectionId: node.nodeId,
    backendId: node.nodeId,
    name: node.view.displayName,
    colorToken: node.view.colorToken ?? FALLBACK_MACHINE_COLOR,
    bound: false,
    freshness: node.freshness,
    transport: TRANSPORT_FOR_STATE[node.view.connection.state] ?? "unreachable",
    ...(lastError && node.view.connection.state !== "connected"
      ? { transportDetail: lastError }
      : {}),
    projects: node.projects,
    environmentsByProject,
    truncated: node.truncated,
    loadedAt: node.loadedAt,
    ...(node.version !== undefined
      ? { release: { version: node.version, domains: node.domains ?? null } }
      : {}),
  };
}

function boundProjects(backendId: BackendId, projects: readonly Project[]): FederatedProject[] {
  return projects.map((project) => {
    const ref = projectRef(backendId, project.id);
    const hint = repositoryHint(project.gitUrl);
    return {
      ref,
      key: projectKey(ref),
      name: boundedText(project.name) || "Untitled project",
      order: project.order,
      ...(project.folder ? { folder: project.folder } : {}),
      ...(hint ? { repositoryHint: hint } : {}),
      ...(project.icon ? { icon: project.icon } : {}),
    };
  });
}

function boundEnvironments(
  backendId: BackendId,
  environments: readonly Environment[],
  activeBuildEnvironmentIds: ReadonlySet<string>,
): Map<string, FederatedEnvironment[]> {
  const byProject = new Map<string, FederatedEnvironment[]>();
  for (const environment of environments) {
    const ref = environmentRef(backendId, environment.id);
    const list = byProject.get(environment.projectId) ?? [];
    list.push({
      ref,
      key: environmentKey(ref),
      projectId: environment.projectId,
      name: environment.name,
      order: environment.order,
      ...(environment.branch ? { branch: environment.branch } : {}),
      status: environment.status,
      activity: environment.agentActivityState ?? "idle",
      ...(activeBuildEnvironmentIds.has(environment.id) ? { buildActive: true as const } : {}),
      ...(environment.agentActivityUpdatedAt
        ? { activityUpdatedAt: environment.agentActivityUpdatedAt }
        : {}),
      ...(environment.lastActivityAt ? { lastActivityAt: environment.lastActivityAt } : {}),
      ...(environment.prState ? { prState: environment.prState } : {}),
      hasUnreadWork: environment.hasUnreadWork === true,
      ...(environment.environmentType ? { environmentType: environment.environmentType } : {}),
      deleting: environmentHasDeletionTombstone(environment),
      ...(environmentDeletionFailure(environment) ? { deleteFailure: NODE_DELETE_FAILURE } : {}),
      ...(!environmentDeletionFailure(environment) &&
      environmentHasDeletionTombstone(environment) &&
      environment.lifecycleOperationStartedAt
        ? { deletingSince: environment.lifecycleOperationStartedAt }
        : {}),
      ...(environmentDeletionStep(environment)
        ? { deletingStep: environmentDeletionStep(environment)! }
        : {}),
      ...(environment.cleanupAfterMergeError ? { deletionRetryable: true as const } : {}),
      isProjectHome: environment.projectHome === true,
    });
    byProject.set(environment.projectId, list);
  }
  return byProject;
}

const BOUND_MACHINE_LOADED = 1;

/**
 * The bound machine's release, from the same command-node read as every
 * other machine's: the command node's own, or the node summary's.
 */
function boundRelease(
  boundId: BackendId | null,
  portalState: Pick<PortalState, "selfId" | "nodes" | "commandRelease">,
): MachineRelease | null {
  if (!boundId) return null;
  if (boundId === portalState.selfId) return portalState.commandRelease;
  const node = portalState.nodes.find((entry) => entry.nodeId === boundId);
  return node ? (viewFromNodeSummary(node).release ?? null) : null;
}

/** The machine this window is bound to, projected from its own full stores. */
export function useBoundMachineView(): MachineView | null {
  const { bound, portalState } = useFederation();
  const boundId = bound?.backendId ?? null;
  const { selfId, nodes, commandRelease } = portalState;
  const release = useMemo(
    () => boundRelease(boundId, { selfId, nodes, commandRelease }),
    [boundId, selfId, nodes, commandRelease],
  );
  const projects = useProjectStore((state) => state.projects);
  const environments = useEnvironmentStore((state) => state.environments);
  const activeBuildEnvironmentIds = useBuildPipelineStore(
    (state) => state.activeBuildEnvironmentIds,
  );
  return useMemo(() => {
    if (!bound) return null;
    return {
      connectionId: bound.connectionId,
      backendId: bound.backendId,
      name: bound.name,
      colorToken: bound.colorToken,
      bound: true,
      freshness: "current",
      transport: "connected",
      projects: boundProjects(bound.backendId, projects),
      environmentsByProject: boundEnvironments(
        bound.backendId,
        environments,
        activeBuildEnvironmentIds,
      ),
      truncated: false,
      // This window's own stores are its machine's live state.
      loadedAt: BOUND_MACHINE_LOADED,
      ...(release ? { release } : {}),
    };
  }, [bound, environments, projects, activeBuildEnvironmentIds, release]);
}

/** Every machine but the window's own, from the command node's read model: its other nodes. */
export function useRemoteMachineViews(): MachineView[] {
  const { portalState, bound } = useFederation();
  const boundId = bound?.backendId ?? null;
  return useMemo(() => {
    return portalState.nodes.filter((node) => node.nodeId !== boundId).map(viewFromNodeSummary);
  }, [boundId, portalState.nodes]);
}

/**
 * All machines, in the order the command node keeps for the sidebar: its own
 * first and the rest in its registry order until the user moves them. Which
 * machine the window works on never changes the order.
 */
export function useMachineViews(): MachineView[] {
  const bound = useBoundMachineView();
  const remote = useRemoteMachineViews();
  const { portalState } = useFederation();
  const layout = usePortalLayout();
  return useMemo(() => {
    const machines = registryOrder(bound ? [bound, ...remote] : remote, [
      ...(portalState.selfId ? [portalState.selfId] : []),
      ...portalState.nodes.map((node) => node.nodeId),
    ]);
    return orderMachines(machines, layout, portalState.selfId);
  }, [bound, layout, portalState.nodes, portalState.selfId, remote]);
}

export function useMachineView(connectionId: string | null): MachineView | null {
  const machines = useMachineViews();
  return useMemo(
    () => machines.find((machine) => machine.connectionId === connectionId) ?? null,
    [connectionId, machines],
  );
}
