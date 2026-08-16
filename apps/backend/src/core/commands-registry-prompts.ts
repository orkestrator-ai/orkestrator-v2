import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { asString, asNumber } from "./commands-helpers.js";

export function registerPromptCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { conditionalManifestSnapshot } = dependencies;
  register("get_prompt_queue", ({ queueKey }, { storage }) =>
    storage.getPromptQueue(asString(queueKey, "queueKey")),
  );
  register("list_prompt_queues", (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "prompt-queue", () =>
      storage.listPromptQueues(asString(args.environmentId, "environmentId"))
    ),
  );
  register(
    "enqueue_prompt_queue_message",
    async ({ queueKey, environmentId, message }, { storage, nativeAgents }) => {
      const key = asString(queueKey, "queueKey");
      const queue = await storage.enqueuePromptQueueMessage(
        key,
        asString(environmentId, "environmentId"),
        message,
      );
      // Persistence is the hand-off edge. From here the backend owns dispatch,
      // even if the renderer changes environment or the destination tab never
      // mounts. Optional chaining keeps lightweight command harnesses working.
      nativeAgents?.notifyPromptQueueChanged?.(key);
      return queue;
    },
  );
  register(
    "requeue_prompt_queue_message",
    ({ queueKey, environmentId, message }, { storage }) =>
      storage.requeuePromptQueueMessage(
        asString(queueKey, "queueKey"),
        asString(environmentId, "environmentId"),
        message,
      ),
  );
  register(
    "remove_prompt_queue_message",
    ({ queueKey, environmentId, messageId }, { storage }) =>
      storage.removePromptQueueMessage(
        asString(queueKey, "queueKey"),
        asString(environmentId, "environmentId"),
        asString(messageId, "messageId"),
      ),
  );
  register(
    "move_prompt_queue_message",
    ({ queueKey, environmentId, messageId, direction }, { storage }) =>
      storage.movePromptQueueMessage(
        asString(queueKey, "queueKey"),
        asString(environmentId, "environmentId"),
        asString(messageId, "messageId"),
        asString(direction, "direction") as "up" | "down",
      ),
  );
  register(
    "claim_prompt_queue_head",
    ({ queueKey, environmentId, expectedMessageId }, { storage }) =>
      storage.claimPromptQueueHead(
        asString(queueKey, "queueKey"),
        asString(environmentId, "environmentId"),
        asString(expectedMessageId, "expectedMessageId"),
      ),
  );
  register(
    "acknowledge_prompt_queue_claim",
    ({ queueKey, environmentId, claimToken }, { storage }) =>
      storage.acknowledgePromptQueueClaim(
        asString(queueKey, "queueKey"),
        asString(environmentId, "environmentId"),
        asString(claimToken, "claimToken"),
      ),
  );
  register(
    "reject_prompt_queue_claim",
    ({ queueKey, environmentId, claimToken }, { storage }) =>
      storage.rejectPromptQueueClaim(
        asString(queueKey, "queueKey"),
        asString(environmentId, "environmentId"),
        asString(claimToken, "claimToken"),
      ),
  );
  register(
    "transfer_prompt_queue_message_to_compose_draft",
    (
      {
        queueKey,
        environmentId,
        messageId,
        draftKey,
        ownerType,
        ownerId,
        expectedDraftRevision,
      },
      { storage },
    ) =>
      storage.transferPromptQueueMessageToComposeDraft(
        asString(queueKey, "queueKey"),
        asString(environmentId, "environmentId"),
        asString(messageId, "messageId"),
        asString(draftKey, "draftKey"),
        asString(ownerType, "ownerType") as "environment" | "project",
        asString(ownerId, "ownerId"),
        expectedDraftRevision === undefined
          ? undefined
          : asNumber(expectedDraftRevision, "expectedDraftRevision"),
      ),
  );
  register("retry_prompt_queue_dispatch", ({ queueKey }, { storage }) =>
    storage.retryPromptQueueDispatch(asString(queueKey, "queueKey")),
  );
  register("get_compose_draft", ({ draftKey }, { storage }) =>
    storage.getComposeDraft(asString(draftKey, "draftKey")),
  );
  register("list_compose_drafts", ({ ownerType, ownerId }, { storage }) =>
    storage.listComposeDrafts(
      asString(ownerType, "ownerType") as "environment" | "project",
      asString(ownerId, "ownerId"),
    ),
  );
  register(
    "save_compose_draft",
    ({ draftKey, ownerType, ownerId, value, expectedRevision }, { storage }) =>
      storage.saveComposeDraft(
        asString(draftKey, "draftKey"),
        asString(ownerType, "ownerType") as "environment" | "project",
        asString(ownerId, "ownerId"),
        value,
        expectedRevision === undefined
          ? undefined
          : asNumber(expectedRevision, "expectedRevision"),
      ),
  );
  register("delete_compose_draft", ({ draftKey, expectedRevision }, { storage }) =>
    storage.deleteComposeDraft(
      asString(draftKey, "draftKey"),
      expectedRevision === undefined
        ? undefined
        : asNumber(expectedRevision, "expectedRevision"),
    ),
  );
  register("get_file_draft", ({ draftKey }, { storage }) =>
    storage.getFileDraft(asString(draftKey, "draftKey")),
  );
  register(
    "save_file_draft",
    (
      {
        draftKey,
        environmentId,
        filePath,
        content,
        originalContent,
        expectedRevision,
      },
      { storage },
    ) =>
      storage.saveFileDraft(
        asString(draftKey, "draftKey"),
        asString(environmentId, "environmentId"),
        asString(filePath, "filePath"),
        asString(content, "content"),
        asString(originalContent, "originalContent"),
        expectedRevision === undefined
          ? undefined
          : asNumber(expectedRevision, "expectedRevision"),
      ),
  );
  register("delete_file_draft", ({ draftKey, expectedRevision }, { storage }) =>
    storage.deleteFileDraft(
      asString(draftKey, "draftKey"),
      expectedRevision === undefined
        ? undefined
        : asNumber(expectedRevision, "expectedRevision"),
    ),
  );
  register("get_agent_handoff", ({ handoffId }, { storage }) =>
    storage.getAgentHandoff(asString(handoffId, "handoffId")),
  );
  register(
    "save_agent_handoff",
    ({ handoffId, environmentId, version, snapshot }, { storage }) =>
      storage.saveAgentHandoff(
        asString(handoffId, "handoffId"),
        asString(environmentId, "environmentId"),
        asNumber(version, "version"),
        snapshot,
      ),
  );
  register(
    "delete_agent_handoff",
    ({ handoffId, environmentId }, { storage }) =>
      storage.deleteAgentHandoff(
        asString(handoffId, "handoffId"),
        asString(environmentId, "environmentId"),
      ),
  );
  register(
    "prune_agent_handoffs",
    ({ environmentId, referencedHandoffIds }, { storage }) => {
      // Deliberately strict rather than `asStringArray`, which coerces a
      // non-array to `[]`. Here that would mean "nothing is referenced" and
      // delete every transcript in the environment.
      if (!Array.isArray(referencedHandoffIds)) {
        throw new Error("Expected referencedHandoffIds to be an array");
      }
      if (referencedHandoffIds.some((id) => typeof id !== "string")) {
        throw new Error("Expected referencedHandoffIds to contain only strings");
      }
      return storage.pruneAgentHandoffs(
        asString(environmentId, "environmentId"),
        referencedHandoffIds as string[],
      );
    },
  );


}
