import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import {
  MULTI_REVIEW_ADDRESS_PROMPT,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import {
  NativeAgentProviderSessionMissingError,
  type NativeAgentService,
} from "./native-agent-service.js";

export class MissingMultiReviewAddressSessionError extends Error {
  constructor() {
    super("The consolidation session is no longer available");
    this.name = "MissingMultiReviewAddressSessionError";
  }
}

type AddressNativeAgents = Pick<NativeAgentService, "adoptSession" | "dispatchIntent">;

/** Adopt the consolidated session and deliver the stable, at-most-once address request. */
export async function dispatchMultiReviewAddressPrompt(
  nativeAgents: AddressNativeAgents,
  workflow: MultiReviewWorkflow,
): Promise<void> {
  const session = workflow.fixSession;
  if (!session) throw new MissingMultiReviewAddressSessionError();
  const logicalSessionKey = `multi-review:${workflow.id}:interactive`;
  const model = workflow.fixModel.model === "default" ? undefined : workflow.fixModel.model;
  try {
    await nativeAgents.adoptSession({
      environmentId: workflow.environmentId,
      agent: workflow.fixModel.agent,
      logicalSessionKey,
      origin: "interactive-native",
      interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      providerSessionId: session.providerSessionId,
      title: "Multi Review · Fix",
      model,
      reasoningEffort: workflow.fixModel.reasoningEffort,
      phase: "fix",
      sessionMode: "build",
    });
  } catch (error) {
    if (error instanceof NativeAgentProviderSessionMissingError) {
      throw new MissingMultiReviewAddressSessionError();
    }
    throw error;
  }
  const outcome = await nativeAgents.dispatchIntent({
    environmentId: workflow.environmentId,
    agent: workflow.fixModel.agent,
    logicalSessionKey,
    origin: "interactive-native",
    interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
    title: "Multi Review · Fix",
    model,
    reasoningEffort: workflow.fixModel.reasoningEffort,
    phase: "fix",
    prompt: MULTI_REVIEW_ADDRESS_PROMPT,
    requestId: `multi-review-address:${workflow.id}`,
    mode: "build",
  });
  if (outcome.outcome !== "accepted") {
    throw new Error(outcome.error ?? "The address prompt dispatch was not confirmed");
  }
}
