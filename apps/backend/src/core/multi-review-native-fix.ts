import type { NativeAgentService } from "./native-agent-service.js";
import type { MultiReviewServiceOptions } from "./multi-review-service.js";

/** Production mapping shared by settlement and publication admission. */
export function multiReviewNativeFixOptions(
  nativeAgents: Pick<NativeAgentService, "sessionRequestOutcome" | "withSessionWorkFence">,
): Pick<MultiReviewServiceOptions, "interactiveFixTurnOutcome" | "withInteractiveFixSessionFence"> {
  return {
    interactiveFixTurnOutcome: async (workflow, session) =>
      (
        await nativeAgents.sessionRequestOutcome({
          environmentId: workflow.environmentId,
          agent: session.agent,
          logicalSessionKey: session.sessionKey,
          expectedProviderSessionId: session.providerSessionId,
          requestId: session.requestIds.at(-1)!,
        })
      ).outcome,
    withInteractiveFixSessionFence: (workflow, session, operation) =>
      nativeAgents.withSessionWorkFence(
        {
          environmentId: workflow.environmentId,
          agent: session.agent,
          logicalSessionKey: session.sessionKey,
        },
        operation,
      ),
  };
}
