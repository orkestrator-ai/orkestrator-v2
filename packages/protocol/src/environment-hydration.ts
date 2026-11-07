/**
 * `list_environment_hydration`: the per-environment lists a renderer restores
 * when it boots (prompt queues and Multi Review workflows), for many
 * environments in one call. It replaces one `list_prompt_queues` and one
 * `list_multi_review_workflows` request per environment on a cold boot.
 * Each environment and each list answers on its own, so one failed read does
 * not fail its neighbours.
 */

export const LIST_ENVIRONMENT_HYDRATION_COMMAND = "list_environment_hydration";

/** Environment ids per call. A renderer splits a longer list into several calls. */
export const MAX_ENVIRONMENT_HYDRATION_IDS = 100;

export type EnvironmentHydrationPart<T> = { status: "ok"; records: T[] } | { status: "failed" };

export interface EnvironmentHydrationEntry<TQueue = unknown, TWorkflow = unknown> {
  environmentId: string;
  promptQueues: EnvironmentHydrationPart<TQueue>;
  multiReviewWorkflows: EnvironmentHydrationPart<TWorkflow>;
}

export interface EnvironmentHydrationBatch<TQueue = unknown, TWorkflow = unknown> {
  environments: Array<EnvironmentHydrationEntry<TQueue, TWorkflow>>;
}

function isPart(value: unknown): value is EnvironmentHydrationPart<unknown> {
  if (!value || typeof value !== "object") return false;
  const part = value as { status?: unknown; records?: unknown };
  return part.status === "failed" || (part.status === "ok" && Array.isArray(part.records));
}

export function isEnvironmentHydrationBatch(value: unknown): value is EnvironmentHydrationBatch {
  if (!value || typeof value !== "object") return false;
  const environments = (value as { environments?: unknown }).environments;
  return (
    Array.isArray(environments) &&
    environments.every(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as EnvironmentHydrationEntry).environmentId === "string" &&
        isPart((entry as EnvironmentHydrationEntry).promptQueues) &&
        isPart((entry as EnvironmentHydrationEntry).multiReviewWorkflows),
    )
  );
}
