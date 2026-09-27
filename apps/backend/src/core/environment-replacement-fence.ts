import { formatContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";

/**
 * Environments whose runtime is being replaced or reset. For the whole
 * operation — quiescing, copying, validating the candidate — no new agent
 * prompt is dispatched: it would reach a runtime about to stop, or none. The
 * refusal happens before anything is journaled, so the prompt definitely did
 * not run and can simply be sent again. In memory on purpose: the operation
 * runs inside one lifecycle queue task of this backend.
 */
const replacingEnvironments = new Map<string, number>();

export function isEnvironmentBeingReplaced(environmentId: string): boolean {
  return (replacingEnvironments.get(environmentId) ?? 0) > 0;
}

export function assertEnvironmentAcceptsAgentWork(environmentId: string): void {
  if (isEnvironmentBeingReplaced(environmentId)) {
    throw new Error(
      formatContainerLifecycleError(
        "operation-in-progress",
        "This environment's container is being rebuilt. The prompt was not sent; send it again when the rebuild finishes.",
      ),
    );
  }
}

export async function withEnvironmentReplacement<T>(
  environmentId: string,
  run: () => Promise<T>,
): Promise<T> {
  replacingEnvironments.set(environmentId, (replacingEnvironments.get(environmentId) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const remaining = (replacingEnvironments.get(environmentId) ?? 1) - 1;
    if (remaining > 0) replacingEnvironments.set(environmentId, remaining);
    else replacingEnvironments.delete(environmentId);
  }
}
