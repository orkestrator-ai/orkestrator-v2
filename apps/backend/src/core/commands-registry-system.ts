import { APP_VERSION } from "./constants.js";
import { assertOnlyKeys } from "./commands-validation.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import {
  readEnvironmentProcessUsage as defaultReadEnvironmentProcessUsage,
  type EnvironmentProcessUsageSnapshot,
  type ProcessUsageEnvironment,
} from "./environment-process-usage.js";
import { createSystemUsageReader, type SystemUsageSnapshot } from "./system-usage.js";

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
    return readProcesses(await context.storage.loadEnvironments());
  });
}
