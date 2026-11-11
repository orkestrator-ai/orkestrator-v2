import type {
  SelfImprovementRunStart,
  SelfImprovementStatus,
} from "@orkestrator/protocol/self-improvement";
import { asSystemModel, systemApi } from "@/lib/node-scope/domains/system";
import { commandBackendClient, type BackendClient } from "./client";

/**
 * Self-improvement on `client`'s node: its status, and starting a run. Both are
 * the machine's own (`admin`): Settings → Self-improvement uses this window's
 * backend.
 */
export function createSelfImprovementApi(client: BackendClient) {
  const system = () => systemApi(client);

  function getSelfImprovementStatus(): Promise<SelfImprovementStatus> {
    return asSystemModel(system().get_self_improvement_status({}));
  }

  /** Starts a run in the background; `dryRun` reports what it would file without filing it. */
  function runSelfImprovement(
    options: { dryRun?: boolean } = {},
  ): Promise<SelfImprovementRunStart> {
    return asSystemModel(system().run_self_improvement(options.dryRun ? { dryRun: true } : {}));
  }

  return { getSelfImprovementStatus, runSelfImprovement };
}

export type SelfImprovementApi = ReturnType<typeof createSelfImprovementApi>;

/** The window's command-scope binding. */
export const { getSelfImprovementStatus, runSelfImprovement } =
  createSelfImprovementApi(commandBackendClient);
