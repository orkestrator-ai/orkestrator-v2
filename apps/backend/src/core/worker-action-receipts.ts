import type { CoordinatorSurfaceAction } from "@orkestrator/protocol/coordinator-surfaces";
import type { CommandContext } from "./commands-context.js";
import { withCoordinatorReceipt } from "./coordinator-action-scope.js";

/** Owning-node results must replay before mutable worker admission checks.
 * Reuse the bounded, durable action journal in a namespace separate from callers.
 * The controller route validates project ownership before entering this helper.
 */
export async function withWorkerActionReceipt(
  context: CommandContext,
  environmentId: string,
  requestId: string,
  action: CoordinatorSurfaceAction,
  payload: Record<string, unknown>,
  run: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error("Environment no longer exists");
  return withCoordinatorReceipt(
    context,
    {
      projectId: environment.projectId,
      coordinatorId: `worker:${environmentId}`,
      conversationId: "controller",
    },
    { requestId, action, payload },
    run,
  );
}
