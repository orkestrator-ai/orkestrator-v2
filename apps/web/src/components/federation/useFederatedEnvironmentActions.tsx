import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  FEDERATED_LINK_PARAM,
  encodeResourceLink,
  type EnvironmentRef,
} from "@orkestrator/protocol/federation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { isMachineWritable, type MachineView } from "@/lib/federation/aggregate";
import type { FederatedEnvironment, FederatedProject } from "@/lib/federation/summaries";
import {
  createFederatedEnvironment,
  deleteFederatedEnvironment,
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
  start: () => void;
  stop: () => void;
  requestDelete: () => void;
  /** The delete confirmation; render it alongside the row. */
  deleteDialog: ReactNode;
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
  const [pendingDelete, setPendingDelete] = useState<EnvironmentRef | null>(null);
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

  const deleteDialog = (
    <AlertDialog
      open={pendingDelete !== null}
      onOpenChange={(next) => !next && setPendingDelete(null)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete “{environment.name}” on {machine.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This deletes the environment on <strong>{machine.name}</strong>, including its
            container, storage and recovery copies. Environments on other machines are not affected.
            This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => {
              // The reference captured when the dialog opened, whatever is focused now.
              const ref = pendingDelete;
              setPendingDelete(null);
              if (ref) void run("Delete", () => deleteFederatedEnvironment(portal, ref));
            }}
          >
            Delete on {machine.name}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

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
    requestDelete: () => setPendingDelete(environment.ref),
    deleteDialog,
  };
}

/** "New environment" inside a project instance: always on the project's own machine. */
export function useCreateFederatedEnvironment(
  machine: MachineView,
  project: FederatedProject,
): { creating: boolean; create: () => Promise<void> } {
  const { portal } = useFederation();
  const [creating, setCreating] = useState(false);

  const create = async () => {
    // The project instance's own machine; there is no placement.
    const ref = project.ref;
    setCreating(true);
    try {
      const environment = await createFederatedEnvironment(portal, ref);
      openMachineWorkspace({
        connectionId: machine.connectionId,
        projectId: ref.projectId,
        environmentId: environment.id,
        title: project.name,
      });
    } catch (error) {
      if (error instanceof OutcomeUnknownError) {
        toast.warning(`Create environment: outcome unknown on ${machine.name}`, {
          description: error.message,
        });
      } else {
        toast.error(`Could not create an environment on ${machine.name}`, {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setCreating(false);
    }
  };

  return { creating, create };
}
