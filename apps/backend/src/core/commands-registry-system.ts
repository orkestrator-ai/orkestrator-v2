import { APP_VERSION } from "./constants.js";
import { assertOnlyKeys } from "./commands-validation.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { createSystemUsageReader, type SystemUsageSnapshot } from "./system-usage.js";

export function registerSystemCommands(
  register: CommandRegistrar,
  readSystemUsage: (diskPath: string) => Promise<SystemUsageSnapshot> = createSystemUsageReader(),
): void {
  register("get_app_version", (args) => {
    assertOnlyKeys(args, [], "arguments");
    return APP_VERSION;
  });
  register("get_system_usage", (_args, context) => readSystemUsage(context.storage.getDataDir()));
}
