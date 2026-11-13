import type {
  SelfImprovementRunStart,
  SelfImprovementStatus,
} from "@orkestrator/protocol/self-improvement";
import { asSystemModel, systemApi } from "@/lib/node-scope/domains/system";
import { commandBackendClient } from "./client";

/**
 * Self-improvement on this window's backend: its status, and starting a run.
 * Both are the machine's own (`admin`): Settings → Self-improvement uses this
 * window's backend, so the file has no `createXApi(client)` factory (plan
 * item 3002): no scope ever wired one in, and it was removed (7571 task 14).
 */
const system = () => systemApi(commandBackendClient);

export function getSelfImprovementStatus(): Promise<SelfImprovementStatus> {
  return asSystemModel(system().get_self_improvement_status({}));
}

/** Starts a run in the background; `dryRun` reports what it would file without filing it. */
export function runSelfImprovement(
  options: { dryRun?: boolean } = {},
): Promise<SelfImprovementRunStart> {
  return asSystemModel(system().run_self_improvement(options.dryRun ? { dryRun: true } : {}));
}
