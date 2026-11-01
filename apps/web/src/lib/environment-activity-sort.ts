import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import {
  compareEnvironmentsByActivity,
  displayedEnvironmentActivity,
  type ActivitySortOrder,
} from "@orkestrator/protocol/environment-activity-order";
import { resolveEnvironmentAgentActivity } from "@/lib/environment-agent-activity";
import type { Environment, Project } from "@/types";

/** Resolves the activity a sidebar row displays for an environment. */
export type DisplayedActivityResolver = (environment: Environment) => AgentActivityState;

/** The persisted snapshot alone, for callers with no runtime or build state. */
export const persistedEnvironmentActivity: DisplayedActivityResolver = (environment) =>
  environment.agentActivityState ?? "idle";

/**
 * The resolver `useEnvironmentDisplayActivity` applies to one row, for a whole
 * list: the freshest of the runtime and persisted observations, shown as
 * working while a build pipeline is active.
 */
export function displayedActivityResolver(
  runtimeStates: Record<string, AgentActivityState>,
  runtimeUpdatedAt: Record<string, string>,
  activeBuildEnvironmentIds: ReadonlySet<string>,
): DisplayedActivityResolver {
  return (environment) =>
    displayedEnvironmentActivity(
      resolveEnvironmentAgentActivity(environment, runtimeStates, runtimeUpdatedAt),
      activeBuildEnvironmentIds.has(environment.id),
    );
}

/**
 * The local "By activity" list, in the shared order
 * (`@orkestrator/protocol/environment-activity-order`) applied to the activity
 * each row displays. Project order, environment order and id break ties in
 * every order.
 */
export function sortEnvironmentsByActivity(
  environments: Environment[],
  projects: Project[],
  order: ActivitySortOrder = "priority",
  displayedActivity: DisplayedActivityResolver = persistedEnvironmentActivity,
): Environment[] {
  const projectOrder = new Map(projects.map((project) => [project.id, project.order]));
  const entries = environments.map((environment) => ({
    environment,
    fields: {
      activity: displayedActivity(environment),
      hasUnreadWork: environment.hasUnreadWork,
      lastActivityAt: environment.lastActivityAt,
      activityUpdatedAt: environment.agentActivityUpdatedAt,
    },
  }));
  entries.sort(
    (left, right) =>
      compareEnvironmentsByActivity(left.fields, right.fields, order) ||
      (projectOrder.get(left.environment.projectId) ?? Number.MAX_SAFE_INTEGER) -
        (projectOrder.get(right.environment.projectId) ?? Number.MAX_SAFE_INTEGER) ||
      left.environment.order - right.environment.order ||
      left.environment.id.localeCompare(right.environment.id),
  );
  return entries.map(({ environment }) => environment);
}
