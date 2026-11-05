/**
 * What a sidebar multi-selection refers to: each selected row's environment and
 * the machine that owns it. See `lib/sidebar-selection.ts` for the selection ids.
 */
import { parseEnvironmentKey, type EnvironmentRef } from "@orkestrator/protocol/federation";
import type { Environment } from "@/types";
import { isMachineWritable, type MachineView } from "./aggregate";

export interface SelectedEnvironment {
  selectionId: string;
  name: string;
  status: string;
  environmentType: string | undefined;
  /** Where it lives when another machine owns it; null for this window's machine. */
  remote: { machine: MachineView; ref: EnvironmentRef; dockerAvailable: boolean } | null;
}

/**
 * A merge cleanup failed on this window's environment and nothing here is
 * retrying it. The record keeps its deletion marker, and when the failure came
 * through the PR monitor's recovery also `lifecycleOperation: "deleting"`, so
 * only the error separates it from a delete still running: a new delete clears
 * the error when it starts.
 */
export function isLocalDeletionRetryable(
  environment: Pick<Environment, "id" | "cleanupAfterMergeError">,
  deletingEnvironments: ReadonlySet<string>,
): boolean {
  return Boolean(environment.cleanupAfterMergeError) && !deletingEnvironments.has(environment.id);
}

function isLocalDeletionInFlight(
  environment: Environment,
  deletingEnvironments: ReadonlySet<string>,
): boolean {
  if (deletingEnvironments.has(environment.id)) return true;
  if (isLocalDeletionRetryable(environment, deletingEnvironments)) return false;
  return Boolean(environment.deletionRequestedAt) || environment.lifecycleOperation === "deleting";
}

/**
 * The selection's environments, in selection order. A row that no longer exists
 * has no entry, so nothing can act on (or count) an environment that has gone.
 * Neither can it act on a delete in flight, but a failed merge cleanup stays
 * selectable so a bulk delete can retry it.
 */
export function resolveSelectedEnvironments(
  selectionIds: readonly string[],
  localEnvironments: readonly Environment[],
  machines: readonly MachineView[],
  deletingEnvironments: ReadonlySet<string> = new Set(),
): SelectedEnvironment[] {
  return selectionIds.flatMap((selectionId): SelectedEnvironment[] => {
    const ref = parseEnvironmentKey(selectionId);
    if (!ref) {
      const environment = localEnvironments.find((candidate) => candidate.id === selectionId);
      if (!environment || isLocalDeletionInFlight(environment, deletingEnvironments)) return [];
      return [
        {
          selectionId,
          name: environment.name,
          status: environment.status,
          environmentType: environment.environmentType,
          remote: null,
        },
      ];
    }
    const machine = machines.find((candidate) => candidate.backendId === ref.backendId);
    if (!machine) return [];
    for (const environments of machine.environmentsByProject.values()) {
      const environment = environments.find((candidate) => candidate.key === selectionId);
      if (
        environment &&
        (!environment.deleting || environment.deletionRetryable) &&
        environment.status !== "deleting"
      ) {
        return [
          {
            selectionId,
            name: environment.name,
            status: environment.status,
            environmentType: environment.environmentType,
            remote: {
              machine,
              ref: environment.ref,
              // A machine that predates the field is treated as having Docker.
              dockerAvailable: environment.dockerAvailable !== false,
            },
          },
        ];
      }
    }
    return [];
  });
}

/** Its machine accepts writes; this window's own always does. */
export function isSelectedEnvironmentReachable(selected: SelectedEnvironment): boolean {
  return !selected.remote || isMachineWritable(selected.remote.machine);
}

/** Stop and Restart apply to it, its machine's reachability aside. */
export function isSelectedEnvironmentRunning(
  selected: SelectedEnvironment,
  localDockerAvailable: boolean,
): boolean {
  const dockerAvailable = selected.remote ? selected.remote.dockerAvailable : localDockerAvailable;
  return selected.status === "running" && (selected.environmentType === "local" || dockerAvailable);
}
