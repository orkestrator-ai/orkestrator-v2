import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { webAnnotationQueueOrigin } from "@orkestrator/protocol/web-annotations";
import { asString, asNumber } from "./commands-helpers.js";
import { isFrozenPromptQueueMessage } from "./storage-prompts.js";

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
      storage.listPromptQueues(asString(args.environmentId, "environmentId")),
    ),
  );
  register(
    "enqueue_prompt_queue_message",
    async ({ queueKey, environmentId, message }, { storage, nativeAgents }) => {
      // Typed origins are backend-authored (annotation requests publish
      // through their own idempotent path). A client cannot declare one.
      if (isFrozenPromptQueueMessage(message)) {
        throw new Error("Prompt queue message origin is assigned by the backend");
      }
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
  register("requeue_prompt_queue_message", ({ queueKey, environmentId, message }, { storage }) =>
    storage.requeuePromptQueueMessage(
      asString(queueKey, "queueKey"),
      asString(environmentId, "environmentId"),
      message,
    ),
  );
  register(
    "remove_prompt_queue_message",
    async ({ queueKey, environmentId, messageId }, { storage, webAnnotations }) => {
      const key = asString(queueKey, "queueKey");
      const environment = asString(environmentId, "environmentId");
      const id = asString(messageId, "messageId");
      // Removing an annotation request from the chat queue is a cancellation
      // of that request: route it through annotation cancellation so its
      // thread settles and its reservation is released. The storage removal
      // below still records a tombstone if this path is unavailable.
      const queue = webAnnotations ? await storage.getPromptQueue(key) : null;
      const message = queue?.messages.find(
        (candidate) =>
          typeof candidate === "object" &&
          candidate !== null &&
          (candidate as { id?: unknown }).id === id,
      );
      const origin = webAnnotationQueueOrigin(message);
      if (origin && webAnnotations && queue?.environmentId === environment) {
        const cancelled = await webAnnotations
          .cancelFromChatQueue(environment, origin.requestId)
          .catch(() => null);
        if (cancelled) {
          return {
            removed: cancelled.removed ? (message ?? null) : null,
            queue: await storage.getPromptQueue(key),
          };
        }
      }
      return storage.removePromptQueueMessage(key, environment, id);
    },
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
  register("reject_prompt_queue_claim", ({ queueKey, environmentId, claimToken }, { storage }) =>
    storage.rejectPromptQueueClaim(
      asString(queueKey, "queueKey"),
      asString(environmentId, "environmentId"),
      asString(claimToken, "claimToken"),
    ),
  );
  register(
    "transfer_prompt_queue_message_to_compose_draft",
    (
      { queueKey, environmentId, messageId, draftKey, ownerType, ownerId, expectedDraftRevision },
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
    async (
      { draftKey, ownerType, ownerId, value, expectedRevision },
      { storage, webAnnotations },
    ) => {
      // A legacy browser note that already lives in a web annotation thread is
      // saved as a lightweight migrated reference instead of fanning out again.
      const mapped = webAnnotations
        ? await webAnnotations.mapMigratedComposeDraft(String(ownerType), String(ownerId), value)
        : null;
      const saved = await storage.saveComposeDraft(
        asString(draftKey, "draftKey"),
        asString(ownerType, "ownerType") as "environment" | "project",
        asString(ownerId, "ownerId"),
        mapped?.value ?? value,
        expectedRevision === undefined ? undefined : asNumber(expectedRevision, "expectedRevision"),
      );
      return mapped && mapped.references.length > 0
        ? { ...saved, webAnnotationMigration: { references: mapped.references } }
        : saved;
    },
  );
  register("delete_compose_draft", ({ draftKey, expectedRevision }, { storage }) =>
    storage.deleteComposeDraft(
      asString(draftKey, "draftKey"),
      expectedRevision === undefined ? undefined : asNumber(expectedRevision, "expectedRevision"),
    ),
  );
  register("get_file_draft", ({ draftKey }, { storage }) =>
    storage.getFileDraft(asString(draftKey, "draftKey")),
  );
  register(
    "save_file_draft",
    (
      { draftKey, environmentId, filePath, content, originalContent, expectedRevision },
      { storage },
    ) =>
      storage.saveFileDraft(
        asString(draftKey, "draftKey"),
        asString(environmentId, "environmentId"),
        asString(filePath, "filePath"),
        asString(content, "content"),
        asString(originalContent, "originalContent"),
        expectedRevision === undefined ? undefined : asNumber(expectedRevision, "expectedRevision"),
      ),
  );
  register("delete_file_draft", ({ draftKey, expectedRevision }, { storage }) =>
    storage.deleteFileDraft(
      asString(draftKey, "draftKey"),
      expectedRevision === undefined ? undefined : asNumber(expectedRevision, "expectedRevision"),
    ),
  );
  register("get_agent_handoff", ({ handoffId }, { storage }) =>
    storage.getAgentHandoff(asString(handoffId, "handoffId")),
  );
  register("save_agent_handoff", ({ handoffId, environmentId, version, snapshot }, { storage }) =>
    storage.saveAgentHandoff(
      asString(handoffId, "handoffId"),
      asString(environmentId, "environmentId"),
      asNumber(version, "version"),
      snapshot,
    ),
  );
  register("delete_agent_handoff", ({ handoffId, environmentId }, { storage }) =>
    storage.deleteAgentHandoff(
      asString(handoffId, "handoffId"),
      asString(environmentId, "environmentId"),
    ),
  );
  register("prune_agent_handoffs", ({ environmentId, referencedHandoffIds }, { storage }) => {
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
  });
}
