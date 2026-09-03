import type { CommandRegistrar } from "./commands-registry-types.js";
import { createSystemUsageReader, type SystemUsageSnapshot } from "./system-usage.js";

export function registerSystemCommands(
  register: CommandRegistrar,
  readSystemUsage: (diskPath: string) => Promise<SystemUsageSnapshot> = createSystemUsageReader(),
): void {
  register("get_system_usage", (_args, context) => readSystemUsage(context.storage.getDataDir()));
}
