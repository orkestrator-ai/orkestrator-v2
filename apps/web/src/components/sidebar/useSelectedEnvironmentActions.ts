import { useEffect } from "react";
import { toast } from "sonner";
import type { EnvironmentRef } from "@orkestrator/protocol/federation";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { useFederation } from "@/components/federation/FederationProvider";
import { reportFederatedActionError } from "@/components/federation/useFederatedEnvironmentActions";
import type { MachineView } from "@/lib/federation/aggregate";
import {
  deleteFederatedEnvironment,
  restartFederatedEnvironment,
  stopFederatedEnvironment,
} from "@/lib/federation/federated-actions";
import {
  isSelectedEnvironmentReachable,
  isSelectedEnvironmentRunning,
  resolveSelectedEnvironments,
  type SelectedEnvironment,
} from "@/lib/federation/selected-environments";
import type { PortalStore } from "@/lib/portal/portal-store";
import {
  claimSidebarAction,
  releaseSidebarAction,
  useSidebarActionStore,
} from "@/stores/sidebarActionStore";
import { useNodeScope } from "@/lib/node-scope/providers";
import { uiStore, useEnvironmentStore } from "@/stores";
import type { Environment } from "@/types";

const log = createLogger("web.sidebar");

type RemoteAction = (portal: PortalStore, ref: EnvironmentRef) => Promise<unknown>;

interface BulkAction {
  label: string;
  logEvent: "environment.stop-failed" | "environment.restart-failed" | "environment.delete-failed";
  local: (environmentId: string) => Promise<unknown>;
  remote: RemoteAction;
}

/**
 * The sidebar's multi-selection and the actions on it. Each environment's action
 * goes to the machine that owns it, through the same path its own row uses. A
 * machine that is not reachable cannot take writes, so its environments are
 * skipped and the user is told.
 */
export function useSelectedEnvironmentActions({
  selectionIds,
  localEnvironments,
  machines,
  dockerAvailable,
  stopEnvironment,
  restartEnvironment,
  deleteEnvironment,
}: {
  selectionIds: readonly string[];
  localEnvironments: readonly Environment[];
  machines: readonly MachineView[];
  dockerAvailable: boolean;
  stopEnvironment: (environmentId: string) => Promise<unknown>;
  restartEnvironment: (environmentId: string) => Promise<unknown>;
  deleteEnvironment: (environmentId: string) => Promise<unknown>;
}) {
  const { portal } = useFederation();
  const pending = useSidebarActionStore((state) => state.pending);
  const deletingEnvironments = useEnvironmentStore((state) => state.deletingEnvironments);
  const selected = resolveSelectedEnvironments(
    selectionIds,
    localEnvironments,
    machines,
    deletingEnvironments,
  );

  // An environment deleted elsewhere leaves the selection, whichever machine it was on.
  const resolvedCount = selected.length;
  const ui = useNodeScope().store(uiStore);
  useEffect(() => {
    if (resolvedCount === selectionIds.length) return;
    const { selectedEnvironmentIds, setMultiSelection } = ui.getState();
    const known = new Set(
      resolveSelectedEnvironments(
        selectedEnvironmentIds,
        localEnvironments,
        machines,
        deletingEnvironments,
      ).map((entry) => entry.selectionId),
    );
    setMultiSelection(selectedEnvironmentIds.filter((id) => known.has(id)));
  }, [deletingEnvironments, localEnvironments, machines, resolvedCount, selectionIds.length, ui]);

  const run = async (action: BulkAction, targets: readonly SelectedEnvironment[]) => {
    const available = targets.filter(isSelectedEnvironmentReachable);
    const skipped = targets.length - available.length;
    const reachable = available.filter((target) => claimSidebarAction(target.selectionId));
    if (skipped > 0) {
      toast.warning(
        `${action.label}: skipped ${skipped} ${skipped === 1 ? "environment" : "environments"} on unavailable machines`,
      );
    }
    const results = await Promise.allSettled(
      reachable.map(async (target) => {
        try {
          return await (target.remote
            ? action.remote(portal, target.remote.ref)
            : action.local(target.selectionId));
        } finally {
          releaseSidebarAction(target.selectionId);
        }
      }),
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      const target = reachable[index]!;
      log.error(action.logEvent, {
        environmentId: target.remote?.ref.environmentId ?? target.selectionId,
        error: formatLogError(result.reason),
      });
      // This window's own actions report their failures from `useEnvironments`.
      if (target.remote) {
        reportFederatedActionError(action.label, target.remote.machine, result.reason);
      }
    });
  };

  const running = selected.filter((entry) => isSelectedEnvironmentRunning(entry, dockerAvailable));

  return {
    selected,
    canStopOrRestart: running.some(
      (entry) => !pending.has(entry.selectionId) && isSelectedEnvironmentReachable(entry),
    ),
    canDelete: selected.some(
      (entry) => !pending.has(entry.selectionId) && isSelectedEnvironmentReachable(entry),
    ),
    stopSelected: () =>
      run(
        {
          label: "Stop",
          logEvent: "environment.stop-failed",
          local: stopEnvironment,
          remote: stopFederatedEnvironment,
        },
        running,
      ),
    restartSelected: () =>
      run(
        {
          label: "Restart",
          logEvent: "environment.restart-failed",
          local: restartEnvironment,
          remote: restartFederatedEnvironment,
        },
        running,
      ),
    deleteSelected: () =>
      run(
        {
          label: "Delete",
          logEvent: "environment.delete-failed",
          local: deleteEnvironment,
          remote: deleteFederatedEnvironment,
        },
        selected,
      ),
  };
}
