import { APP_VERSION } from "./constants.js";
import { assertOnlyKeys } from "./commands-validation.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import {
  readEnvironmentProcessUsage as defaultReadEnvironmentProcessUsage,
  type EnvironmentProcessUsageSnapshot,
  type ProcessUsageEnvironment,
} from "./environment-process-usage.js";
import { createSystemUsageReader, type SystemUsageSnapshot } from "./system-usage.js";
import { recurringWorkDiagnostics } from "./recurring-diagnostics.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";

export function registerSystemCommands(
  register: CommandRegistrar,
  readSystemUsage?: (diskPath: string) => Promise<SystemUsageSnapshot>,
  readEnvironmentProcessUsage?: (
    environments: ProcessUsageEnvironment[],
  ) => Promise<EnvironmentProcessUsageSnapshot>,
): void {
  const readUsage = readSystemUsage ?? createSystemUsageReader();
  const readProcesses = readEnvironmentProcessUsage ?? defaultReadEnvironmentProcessUsage;
  register("get_app_version", (args) => {
    assertOnlyKeys(args, [], "arguments");
    return APP_VERSION;
  });
  register("get_system_usage", (_args, context) => readUsage(context.storage.getDataDir()));
  register("get_environment_process_usage", async (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    recurringWorkMetrics.requested("process-usage");
    return recurringWorkMetrics.observe("process-usage", async () =>
      readProcesses(await context.storage.loadEnvironments()),
    );
  });
  /**
   * Bounded, content-free recurring-work diagnostics: per-kind counters, active
   * attempts and worst ages, plus scheduler and admission-pool status. Reading
   * it performs no I/O. Also served additively on the gateway's `/api/metrics`.
   */
  register("get_recurring_work_diagnostics", (args) => {
    assertOnlyKeys(args, [], "arguments");
    return recurringWorkDiagnostics();
  });
}
