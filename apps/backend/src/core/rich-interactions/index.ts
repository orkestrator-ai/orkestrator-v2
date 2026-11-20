import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import { nativeAgentSessionStorageKey } from "../native-agent-session-key.js";
import type { StorageService } from "../storage.js";
import { isPromptQueueMessageConflict } from "../storage-prompts.js";
import { ProductCommandRegistry, graphWorkflowCommands, type GraphRunControls } from "./product-commands.js";
import { RichInteractionService, type FollowupDelivery } from "./service.js";

export { RichInteractionError, RichInteractionService } from "./service.js";
export { RichInteractionStore } from "./store.js";

/**
 * Builds the rich interaction service over the backend's storage and native
 * agent prompt queues. Follow-ups use the same persistent, idempotent queue
 * as goal continuations and web annotation requests: the receipt id is the
 * queue request id, so a retry can never queue the decision twice.
 */
export function createRichInteractionService(options: {
  storage: StorageService;
  nativeAgents: { notifyPromptQueueChanged(queueKey: string): void } | undefined;
  graphRuns: () => GraphRunControls | undefined;
}): RichInteractionService {
  const { storage } = options;
  const delivery: FollowupDelivery = {
    async resolveAgent(environmentId, logicalSessionKey) {
      const sessions = await storage.readNativeAgentSessionsSnapshot();
      return sessions.find((s) => s.environmentId === environmentId && s.logicalSessionKey === logicalSessionKey)?.agent;
    },
    async enqueue(input) {
      try {
        const { status } = await storage.enqueuePromptQueueMessageIfAbsent(input.queueKey, input.environmentId, {
          id: input.requestId,
          requestId: input.requestId,
          text: input.text,
          // A decision summary is literal text: never a provider slash command.
          command: { kind: "literal" },
          preserveSessionMode: true,
          origin: input.origin,
        });
        return status;
      } catch (error) {
        if (isPromptQueueMessageConflict(error)) return "conflict";
        throw error;
      }
    },
    notify(queueKey) {
      options.nativeAgents?.notifyPromptQueueChanged(queueKey);
    },
    async dispatched(environmentId, agent, logicalSessionKey, requestId) {
      const session = await storage.getNativeAgentSession(
        nativeAgentSessionStorageKey(environmentId, agent as BuildPipelineAgent, logicalSessionKey),
      );
      if (!session) return undefined;
      return session.dispatchedRequestIds?.includes(requestId) ?? false;
    },
  };
  const commands = new ProductCommandRegistry();
  for (const command of graphWorkflowCommands(options.graphRuns)) commands.register(command);
  return new RichInteractionService({ store: () => storage.richInteractionStore(), delivery, commands });
}
