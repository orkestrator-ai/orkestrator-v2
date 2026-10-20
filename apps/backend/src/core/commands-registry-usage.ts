import {
  normalizeUsageHistoryQuery,
  type UsageHistoryReport,
} from "@orkestrator/protocol/usage-history";
import { assertOnlyKeys } from "./commands-validation.js";
import type { CommandRegistrar } from "./commands-registry-types.js";

/**
 * The usage pane's one read. Everything it returns is derived from the
 * recorded usage rows, with environment and project names joined on at the
 * last moment: a usage row outlives the environment it came from, and a row
 * whose environment is gone keeps its counts and simply has no name.
 */
export function registerUsageCommands(register: CommandRegistrar): void {
  register("get_usage_history", async (args, context) => {
    assertOnlyKeys(args, ["days", "platform", "environmentId"], "arguments");
    const query = normalizeUsageHistoryQuery(args);
    const report = context.storage.getAgentUsageHistory(query);
    if (report.environments.length === 0) return report;
    const environments = await context.storage.loadEnvironments();
    const projects = await context.storage.loadProjects();
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    const named = new Map(
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
      environments: report.environments.map((entry) => {
        const match = named.get(entry.environmentId);
        return {
          ...entry,
          ...(match?.name ? { name: match.name } : {}),
          ...(match?.projectName ? { projectName: match.projectName } : {}),
        };
      }),
    };
    return decorated;
  });
}
