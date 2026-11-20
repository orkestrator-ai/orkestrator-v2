import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { dockerClient } from "@orkestrator/protocol/contract/domains/docker";
import { buildLaunchMachines, type BuildLaunchMachine } from "@/components/build/build-machines";
import { useLinearMachineTargets } from "@/components/linear/linear-machines";
import {
  machineBackendClient,
  scopeBackendClient,
  type AccountMachine,
} from "@/lib/backend/client";
import { toast } from "sonner";
import { watchCreateEnvironmentRequest } from "@/lib/federation/create-environment-handoff";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { scopeRowsSource } from "@/lib/federation/scope-overlay";
import type { CreateEnvironmentHandoff } from "@/lib/federation/workspace-request";
import { domainApi } from "@/lib/node-scope/domains/domain-api";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { portalStore } from "@/lib/portal/portal-store";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";

export type CreateEnvironmentMachine = BuildLaunchMachine;

/** The current machine stays visible. Alternatives need a usable environment type. */
export function createEnvironmentMachines(
  machines: readonly BuildLaunchMachine[],
  docker: ReadonlyMap<string, boolean>,
): CreateEnvironmentMachine[] {
  return machines.filter(
    (machine) =>
      machine.current ||
      (machine.available && (machine.hasCheckout || docker.get(machine.key) === true)),
  );
}

export function useCreateEnvironmentMachines(
  projectId: string | null | undefined,
): CreateEnvironmentMachine[] {
  const { scope, windowScope } = useScopesWithCommandFallback();
  const source = scopeRowsSource(windowScope, "projects");
  const liveProjects = useSyncExternalStore(
    source.subscribe,
    source.getSnapshot,
    source.getSnapshot,
  );
  const targets = useLinearMachineTargets(projectId ?? "", liveProjects);
  const machines = useMemo(() => buildLaunchMachines(targets), [targets]);
  const nodes = useStore(portalStore.store, (state) => state.nodes);
  const observedDocker = useMemo(() => {
    const docker = new Map<string, boolean>();
    for (const node of nodes) {
      const available = node.environments.find(
        (row) => row.dockerAvailable !== undefined,
      )?.dockerAvailable;
      if (available !== undefined) docker.set(`node:${node.nodeId}`, available);
    }
    return docker;
  }, [nodes]);

  // A remote-only project with no advertised Docker status needs a probe.
  // Keep it out of the picker while the result is unknown or unreadable.
  // Depend on the identities, so a summary refresh with the same candidates
  // cannot restart their checks or temporarily remove a confirmed machine.
  const pendingChecks = JSON.stringify(
    machines
      .filter(
        (machine) =>
          !machine.current &&
          machine.available &&
          !machine.hasCheckout &&
          !observedDocker.has(machine.key),
      )
      .map(({ key, machine }) => [key, machine]),
  );
  const [probed, setProbed] = useState<{
    pendingChecks: string;
    docker: ReadonlyMap<string, boolean>;
  }>();
  useEffect(() => {
    const targets = JSON.parse(pendingChecks) as [string, AccountMachine][];
    if (!targets.length) return;
    let active = true;
    for (const [key, machine] of targets) {
      const client = machineBackendClient(scopeBackendClient(scope), machine);
      void domainApi(client, dockerClient)
        .checkDocker()
        .then(
          (result) => result?.available === true,
          () => false,
        )
        .then((available) => {
          if (!active) return;
          setProbed((previous) => {
            const docker = new Map(
              previous?.pendingChecks === pendingChecks ? previous.docker : [],
            );
            docker.set(key, available);
            return { pendingChecks, docker };
          });
        });
    }
    return () => {
      active = false;
    };
  }, [scope, pendingChecks]);
  return useMemo(
    () =>
      createEnvironmentMachines(
        machines,
        new Map([
          ...observedDocker,
          ...(probed?.pendingChecks === pendingChecks ? probed.docker : []),
        ]),
      ),
    [machines, observedDocker, pendingChecks, probed],
  );
}

/** Where a machine switch started: reopened with the form when the destination fails. */
export interface CreateEnvironmentSwitchSource {
  /** The source node (`""`: the window's own node). */
  connectionId: string;
  projectId: string;
  /** The source machine's name, for the message. */
  machineName: string;
  title: string;
}

/**
 * Opens the destination's own form with the data from this switch request.
 *
 * Another node's workspace opens its dialog once its stores have loaded. When
 * it cannot (its workspace fails to open, the project is not there, or
 * nothing opens within `CREATE_ENVIRONMENT_HANDOFF_TIMEOUT_MS`), the user is
 * told and the form opens again on `source` with what they entered. A request
 * the user navigated away from is left cancelled.
 */
export function openCreateEnvironmentOnMachine(
  machine: CreateEnvironmentMachine,
  title: string,
  handoff: CreateEnvironmentHandoff,
  source?: CreateEnvironmentSwitchSource,
): void {
  const connectionId = machine.nodeId ?? "";
  openMachineWorkspace({
    connectionId,
    projectId: machine.projectId,
    createEnvironment: true,
    createEnvironmentHandoff: handoff,
    title,
  });
  // The window's own node opens its dialog from its own loaded stores.
  const selfId = portalStore.getState().selfId;
  if (!source || !connectionId || connectionId === selfId) return;
  const seq = useRemoteWorkspaceStore.getState().requests[connectionId]?.seq;
  if (seq === undefined) return;
  watchCreateEnvironmentRequest(connectionId, seq, (outcome) => {
    if (outcome.kind !== "failed") return;
    toast.error(`Could not open the new environment form on ${machine.name}`, {
      description: `${outcome.reason} It is open again on ${source.machineName} with what you entered.`,
    });
    openMachineWorkspace({
      connectionId: source.connectionId,
      projectId: source.projectId,
      createEnvironment: true,
      createEnvironmentHandoff: handoff,
      title: source.title,
    });
  });
}
