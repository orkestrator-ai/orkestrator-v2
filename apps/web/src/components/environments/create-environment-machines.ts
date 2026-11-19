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
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { scopeRowsSource } from "@/lib/federation/scope-overlay";
import type { CreateEnvironmentHandoff } from "@/lib/federation/workspace-request";
import { domainApi } from "@/lib/node-scope/domains/domain-api";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { portalStore } from "@/lib/portal/portal-store";

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

/** Opens the destination's own form with the data from this switch request. */
export function openCreateEnvironmentOnMachine(
  machine: CreateEnvironmentMachine,
  title: string,
  handoff: CreateEnvironmentHandoff,
): void {
  openMachineWorkspace({
    connectionId: machine.nodeId ?? "",
    projectId: machine.projectId,
    createEnvironment: true,
    createEnvironmentHandoff: handoff,
    title,
  });
}
