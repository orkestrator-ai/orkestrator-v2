import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { useState } from "react";
import { toast } from "sonner";
import { FEDERATED_LINK_PARAM, encodeResourceLink } from "@orkestrator/protocol/federation";
import { isMachineWritable, type MachineView } from "@/lib/federation/aggregate";
import type { FederatedEnvironment, FederatedProject } from "@/lib/federation/summaries";
import {
  deleteFederatedEnvironment,
  forkFederatedEnvironment,
  restartFederatedEnvironment,
  startFederatedEnvironment,
  stopFederatedEnvironment,
} from "@/lib/federation/federated-actions";
import { OutcomeUnknownError } from "@/lib/portal/portal-store";
import { useUIStore } from "@/stores";
import { useFederation } from "./FederationProvider";

export interface FederatedEnvironmentActions {
  busy: boolean;
  writable: boolean;
  /** Selects a row of this window's machine; switches to another machine's workspace. */
  open: () => void;
  copyLink: () => void;
  /** Opens the environment's settings dialog, on its own machine. */
  openSettings: () => void;
  start: () => void;
  stop: () => void;
  restart: () => void;
  /** Forks it on its own machine, starts the fork there and opens it. */
  fork: (environmentType: "local" | "containerized") => void;
  /** Deletes it on its own machine; the row asks for confirmation first. */
  remove: () => void;
}

/**
 * Actions on one environment of a (possibly other) machine. Every action
 * carries the row's captured reference, so a confirmation always names — and
 * reaches — the machine it was opened for.
 */
export function useFederatedEnvironmentActions(
  machine: MachineView,
  environment: FederatedEnvironment,
): FederatedEnvironmentActions {
  const { portal } = useFederation();
  const selectProjectAndEnvironment = useUIStore((state) => state.selectProjectAndEnvironment);
  const [busy, setBusy] = useState(false);

  const open = () => {
    if (machine.bound) {
      selectProjectAndEnvironment(environment.projectId, environment.ref.environmentId);
      return;
    }
    openMachineWorkspace({
      connectionId: machine.connectionId,
      projectId: environment.projectId,
      environmentId: environment.ref.environmentId,
      title: environment.name,
    });
  };

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      if (error instanceof OutcomeUnknownError) {
        toast.warning(`${label}: outcome unknown on ${machine.name}`, {
          description: error.message,
        });
      } else {
        toast.error(`${label} failed on ${machine.name}`, {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const copyLink = () => {
    // A machine-qualified link: machine identity plus resource, never a
    // route, forwarded port or credential.
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set(FEDERATED_LINK_PARAM, encodeResourceLink(environment.ref));
    const text = url.toString();
    const write =
      window.orkestrator?.clipboard?.writeText(text) ?? navigator.clipboard?.writeText(text);
    void Promise.resolve(write).then(
      () =>
        toast.success("Copied link", {
          description: `${environment.name} on ${machine.name}`,
        }),
      () => toast.error("Could not copy the link"),
    );
  };

  return {
    busy,
    writable: isMachineWritable(machine),
    open,
    copyLink,
    start: () => {
      const ref = environment.ref;
      void run("Start", () => startFederatedEnvironment(portal, ref));
    },
    stop: () => {
      const ref = environment.ref;
      void run("Stop", () => stopFederatedEnvironment(portal, ref));
    },
    openSettings: () =>
      openMachineWorkspace({
        connectionId: machine.connectionId,
        projectId: environment.projectId,
        environmentId: environment.ref.environmentId,
        dialog: "environment-settings",
        title: environment.name,
      }),
    restart: () => {
      const ref = environment.ref;
      void run("Restart", async () => {
        await restartFederatedEnvironment(portal, ref);
      });
    },
    fork: (environmentType) => {
      const ref = environment.ref;
      void run("Fork", async () => {
        const fork = await forkFederatedEnvironment(portal, ref, environmentType);
        toast.success(
          environmentType === "local" ? "Local environment forked" : "Container environment forked",
          { description: `On ${machine.name}` },
        );
        openMachineWorkspace({
          connectionId: machine.connectionId,
          projectId: fork.projectId,
          environmentId: fork.environmentId,
          title: fork.name,
        });
        await run(`Start fork ${fork.name}`, () =>
          startFederatedEnvironment(portal, {
            backendId: ref.backendId,
            environmentId: fork.environmentId,
          }),
        );
      });
    },
    remove: () => {
      // The reference this row was drawn for, whatever is focused now.
      const ref = environment.ref;
      void run("Delete", () => deleteFederatedEnvironment(portal, ref));
    },
  };
}

/**
 * "New environment" inside a project instance: always on the project's own
 * machine, and always through that machine's New Environment dialog. The
 * window moves to the machine first when it is another one, so the dialog's
 * defaults, agent settings and start are the machine's own.
 */
export function newFederatedEnvironment(machine: MachineView, project: FederatedProject): void {
  openMachineWorkspace({
    connectionId: machine.connectionId,
    projectId: project.ref.projectId,
    createEnvironment: true,
    title: project.name,
  });
}
