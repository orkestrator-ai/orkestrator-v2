import type { NativeAgentService } from "./native-agent-service.js";
import type { MultiReviewServiceOptions } from "./multi-review-service.js";

/** Production mapping shared by settlement and publication admission. */
export function multiReviewNativeAddressFindingsOptions(
  nativeAgents: Pick<NativeAgentService, "sessionRequestOutcome" | "withSessionWorkFence">,
): Pick<
  MultiReviewServiceOptions,
  "interactiveAddressFindingsTurnOutcome" | "withInteractiveAddressFindingsSessionFence"
> {
  return {
    interactiveAddressFindingsTurnOutcome: async (workflow, session) =>
      (
        await nativeAgents.sessionRequestOutcome({
          environmentId: workflow.environmentId,
          agent: session.agent,
          logicalSessionKey: session.sessionKey,
          expectedProviderSessionId: session.providerSessionId,
          requestId: session.requestIds.at(-1)!,
        })
      ).outcome,
    withInteractiveAddressFindingsSessionFence: (workflow, session, operation) =>
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
