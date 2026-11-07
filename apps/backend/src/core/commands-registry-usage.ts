import {
  normalizeUsageHistoryQuery,
  type UsageEnvironmentSummary,
  type UsageHistoryReport,
} from "@orkestrator/protocol/usage-history";
import { getUsageHistoryCommand } from "@orkestrator/protocol/contract/domains/accounts";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";
import type { CommandRegistrar } from "./commands-registry-types.js";

/**
 * The usage pane's one read. Everything it returns is derived from the
 * recorded usage rows. A usage row outlives the environment it came from, so
 * an environment is named in order of preference by:
 *
 * 1. its live record, while it exists (a rename shows at once);
 * 2. the names stamped onto its usage rows when it was deleted;
 * 3. the terminal-PR tombstone deletion keeps for an environment whose PR was
 *    merged or closed, which also covers environments deleted before usage
 *    rows kept names.
 *
 * Anything else is a deleted environment nobody recorded a name for.
 */
export function registerUsageCommands(register: CommandRegistrar): void {
  register(
    getUsageHistoryCommand,
    async (args, context) => {
      const query = normalizeUsageHistoryQuery(args);
      const report = context.storage.getAgentUsageHistory(query);
      if (report.environments.length === 0) return report;
      const environments = await context.storage.loadEnvironments();
      const projects = await context.storage.loadProjects();
      const projectNames = new Map(projects.map((project) => [project.id, project.name]));
      const live = new Map(
        environments.map((environment) => [
          environment.id,
          {
            name: environment.name,
            projectName: projectNames.get(environment.projectId),
          },
        ]),
      );
      const decorated: UsageHistoryReport = {
        ...report,
        environments: await Promise.all(
          report.environments.map(async (entry): Promise<UsageEnvironmentSummary> => {
            const match = live.get(entry.environmentId);
            if (match) {
              return {
                ...entry,
                ...(match.name ? { name: match.name } : {}),
                ...(match.projectName ? { projectName: match.projectName } : {}),
              };
            }
            if (entry.name && entry.projectName) return { ...entry, deleted: true };
            const tombstone = await context.storage
              .getFinalEnvironmentPr(entry.environmentId)
              .catch(() => null);
            const name = entry.name ?? tombstone?.name;
            const projectName =
              entry.projectName ?? (tombstone ? projectNames.get(tombstone.projectId) : undefined);
            return {
              ...entry,
              ...(name ? { name } : {}),
              ...(projectName ? { projectName } : {}),
              deleted: true,
            };
          }),
        ),
      };
      return decorated;
    },
    ASYNC_HANDLER,
  );
}
