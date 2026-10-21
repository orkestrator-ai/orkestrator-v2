import { useEffect, useMemo, useState } from "react";
import { FALLBACK_MACHINE_COLOR, defaultMachineColor } from "@orkestrator/protocol/backend-profile";
import type { ConnectionSummary } from "@orkestrator/protocol/connections";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  provisionalBackendId,
  type BackendId,
} from "@orkestrator/protocol/federation";
import { useEnvironmentStore, useProjectStore } from "@/stores";
import type { MachineView } from "@/lib/federation/aggregate";
import {
  backendIdForConnection,
  boundedText,
  repositoryHint,
  type FederatedEnvironment,
  type FederatedProject,
  type MachineSummaryState,
} from "@/lib/federation/backend-runtime";
import type { Environment, Project } from "@/types";
import { machineDisplayName, useFederation } from "./FederationProvider";

function colorFor(connection: ConnectionSummary, backendId: BackendId): string {
  if (connection.profile?.colorToken) return connection.profile.colorToken;
  // An older backend without a profile: a stable colour from a proved
  // identity, otherwise a labelled neutral (never a random colour).
  return connection.identity === "verified"
    ? defaultMachineColor(backendId)
    : FALLBACK_MACHINE_COLOR;
}

function viewFromSummary(state: MachineSummaryState): MachineView {
  return {
    connectionId: state.connectionId,
    backendId: state.backendId,
    name: machineDisplayName(state.connection),
    colorToken: colorFor(state.connection, state.backendId),
    bound: false,
    freshness: state.freshness,
    transport: state.connection.transport ?? "connecting",
    ...(state.connection.transportDetail
      ? { transportDetail: state.connection.transportDetail }
      : {}),
    projects: state.projects,
    environmentsByProject: state.environmentsByProject,
    truncated: state.truncated,
    loadedAt: state.loadedAt,
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

const BOUND_MACHINE_LOADED = 1;

/** The machine this realm is bound to, projected from its own full stores. */
export function useBoundMachineView(): MachineView | null {
  const { bound } = useFederation();
  const projects = useProjectStore((state) => state.projects);
  const environments = useEnvironmentStore((state) => state.environments);
  return useMemo(() => {
    if (!bound) return null;
    const backendId =
      bound.backendId && bound.identity === "verified"
        ? bound.backendId
        : provisionalBackendId(bound.id);
    return {
      connectionId: bound.id,
      backendId,
      name: machineDisplayName(bound),
      colorToken: colorFor(bound, backendId),
      bound: true,
      freshness: "current",
      transport: bound.transport ?? "connected",
      projects: boundProjects(backendId, projects),
      environmentsByProject: boundEnvironments(backendId, environments),
      truncated: false,
      // This realm's own stores are its machine's live state.
      loadedAt: BOUND_MACHINE_LOADED,
    };
  }, [bound, environments, projects]);
}

/** Summaries of every other machine, re-rendered only when one of them changes. */
export function useRemoteMachineViews(): MachineView[] {
  const { registry } = useFederation();
  const [views, setViews] = useState<MachineView[]>(() =>
    registry.list().map((runtime) => viewFromSummary(runtime.getSnapshot())),
  );

  useEffect(() => {
    let runtimeUnsubscribers: Array<() => void> = [];
    const publish = () =>
      setViews(registry.list().map((runtime) => viewFromSummary(runtime.getSnapshot())));
    const watchRuntimes = () => {
      for (const unsubscribe of runtimeUnsubscribers) unsubscribe();
      runtimeUnsubscribers = registry.list().map((runtime) => runtime.store.subscribe(publish));
      publish();
    };
    watchRuntimes();
    const unsubscribeRegistry = registry.store.subscribe(watchRuntimes);
    return () => {
      unsubscribeRegistry();
      for (const unsubscribe of runtimeUnsubscribers) unsubscribe();
    };
  }, [registry]);

  return views;
}

/** All machines, this one first. */
export function useMachineViews(): MachineView[] {
  const bound = useBoundMachineView();
  const remote = useRemoteMachineViews();
  return useMemo(() => (bound ? [bound, ...remote] : remote), [bound, remote]);
}

export function useMachineView(connectionId: string | null): MachineView | null {
  const machines = useMachineViews();
  return useMemo(
    () => machines.find((machine) => machine.connectionId === connectionId) ?? null,
    [connectionId, machines],
  );
}

export { backendIdForConnection };
