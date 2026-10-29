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
import type { NodeSummary, SelfNodeSummary } from "@orkestrator/protocol/node-summaries";
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
      ...(environment.agentActivityUpdatedAt
        ? { activityUpdatedAt: environment.agentActivityUpdatedAt }
        : {}),
      ...(environment.lastActivityAt ? { lastActivityAt: environment.lastActivityAt } : {}),
      hasUnreadWork: environment.hasUnreadWork === true,
      ...(environment.environmentType ? { environmentType: environment.environmentType } : {}),
      deleting:
        environment.lifecycleOperation === "deleting" || Boolean(environment.deletionRequestedAt),
      isProjectHome: environment.projectHome === true,
    });
    byProject.set(environment.projectId, list);
  }
  return byProject;
}

/**
 * The command node itself, from its self summary, while the window's
 * workspace (and so its full stores) is on another node.
 */
export function viewFromSelfSummary(self: SelfNodeSummary): MachineView {
  const environmentsByProject = new Map<string, FederatedEnvironment[]>();
  for (const environment of self.environments) {
    const list = environmentsByProject.get(environment.projectId) ?? [];
    list.push(environment);
    environmentsByProject.set(environment.projectId, list);
  }
  return {
    connectionId: self.nodeId,
    backendId: self.nodeId,
    name: self.displayName,
    colorToken: self.colorToken ?? FALLBACK_MACHINE_COLOR,
    bound: false,
    freshness: "current",
    transport: "connected",
    projects: self.projects,
    environmentsByProject,
    truncated: self.truncated,
    loadedAt: self.loadedAt,
  };
}

const BOUND_MACHINE_LOADED = 1;

/** The machine this realm is bound to, projected from its own full stores. */
export function useBoundMachineView(): MachineView | null {
  const { bound } = useFederation();
  const projects = useProjectStore((state) => state.projects);
  const environments = useEnvironmentStore((state) => state.environments);
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
      environmentsByProject: boundEnvironments(bound.backendId, environments),
      truncated: false,
      // This realm's own stores are its machine's live state.
      loadedAt: BOUND_MACHINE_LOADED,
    };
  }, [bound, environments, projects]);
}

/**
 * Every machine but the one the window's workspace is on, from the command
 * node's read model: its other nodes, and the command node itself while the
 * workspace is on one of them.
 */
export function useRemoteMachineViews(): MachineView[] {
  const { portalState, bound } = useFederation();
  const boundId = bound?.backendId ?? null;
  return useMemo(() => {
    const nodes = portalState.nodes
      .filter((node) => node.nodeId !== boundId)
      .map(viewFromNodeSummary);
    return portalState.self && portalState.self.nodeId !== boundId
      ? [viewFromSelfSummary(portalState.self), ...nodes]
      : nodes;
  }, [boundId, portalState.nodes, portalState.self]);
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
