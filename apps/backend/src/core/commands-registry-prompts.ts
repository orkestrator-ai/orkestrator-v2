import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { withAsyncArgumentFailures } from "./commands-registry-async-args.js";
import {
  createAgentHandoffCommand,
  deleteAgentHandoffCommand,
  deleteComposeDraftCommand,
  deleteFileDraftCommand,
  enqueuePromptQueueMessageCommand,
  getAgentHandoffCapabilitiesCommand,
  getAgentHandoffCommand,
  getComposeDraftCommand,
  getFileDraftCommand,
  getPromptQueueCommand,
  listEnvironmentHydrationCommand,
  listPromptQueuesCommand,
  movePromptQueueMessageCommand,
  pruneAgentHandoffsCommand,
  removePromptQueueMessageCommand,
  retryPromptQueueDispatchCommand,
  saveAgentHandoffCommand,
  saveComposeDraftCommand,
  saveFileDraftCommand,
} from "@orkestrator/protocol/contract/domains/native-sessions";
import { webAnnotationQueueOrigin } from "@orkestrator/protocol/web-annotations";
import {
  MAX_ENVIRONMENT_HYDRATION_IDS,
  type EnvironmentHydrationBatch,
  type EnvironmentHydrationPart,
} from "@orkestrator/protocol/environment-hydration";
import { asString, asNumber, stripWorkflowRendererSecrets } from "./commands-helpers.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import { isFrozenPromptQueueMessage } from "./storage-prompts.js";
import { resetAgentMailBudget } from "./commands-registry-mail.js";
import {
  AGENT_HANDOFF_CAPABILITIES,
  createAgentHandoff,
  parseCreateAgentHandoffInput,
} from "./agent-handoffs.js";

export function registerPromptCommands(
  registerCommand: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  // `async` handlers keep rejecting on bad arguments (`commands-registry-async-args.ts`).
  const register = withAsyncArgumentFailures(registerCommand);
  const { conditionalManifestSnapshot } = dependencies;
  register(getPromptQueueCommand, ({ queueKey }, { storage }) =>
    storage.getPromptQueue(asString(queueKey, "queueKey")),
  );
  register(listPromptQueuesCommand, (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "prompt-queue", () =>
      storage.listPromptQueues(asString(args.environmentId, "environmentId")),
    ),
  );
  // A renderer's boot restore for many environments in one request; see
  // `@orkestrator/protocol/environment-hydration`. Each list is the same read
  // `list_prompt_queues` and `list_multi_review_workflows` serve, and each
  // environment's lists fail on their own.
  register(listEnvironmentHydrationCommand, async (args, { storage }) => {
    const environmentIds = environmentHydrationIds(args.environmentIds);
    const part = async <T>(load: () => Promise<T[]>): Promise<EnvironmentHydrationPart<T>> => {
      try {
        return { status: "ok", records: await load() };
      } catch {
        return { status: "failed" };
      }
    };
    const environments = await Promise.all(
      environmentIds.map(async (environmentId) => ({
        environmentId,
        promptQueues: await part(() => storage.listPromptQueues(environmentId)),
        multiReviewWorkflows: await part(async () =>
          (await storage.listMultiReviewWorkflows(environmentId)).map(stripWorkflowRendererSecrets),
        ),
      })),
    );
    return { environments } satisfies EnvironmentHydrationBatch;
  });
  register(
    enqueuePromptQueueMessageCommand,
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
      // A queued prompt is a person typing into this tab, just not yet sent.
      const separator = key.indexOf("\0");
      if (separator > 0) {
        await resetAgentMailBudget(
          { storage },
          asString(environmentId, "environmentId"),
          key.slice(separator + 1),
        );
      }
      // Persistence is the hand-off edge. From here the backend owns dispatch,
      // even if the renderer changes environment or the destination tab never
      // mounts. Optional chaining keeps lightweight command harnesses working.
      nativeAgents?.notifyPromptQueueChanged?.(key);
      return queue;
    },
  );
  register(
    removePromptQueueMessageCommand,
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
    movePromptQueueMessageCommand,
    ({ queueKey, environmentId, messageId, direction }, { storage }) =>
      storage.movePromptQueueMessage(
        asString(queueKey, "queueKey"),
        asString(environmentId, "environmentId"),
        asString(messageId, "messageId"),
        asString(direction, "direction") as "up" | "down",
      ),
  );
  register(retryPromptQueueDispatchCommand, ({ queueKey }, { storage }) =>
    storage.retryPromptQueueDispatch(asString(queueKey, "queueKey")),
  );
  register(getComposeDraftCommand, ({ draftKey }, { storage }) =>
    storage.getComposeDraft(asString(draftKey, "draftKey")),
  );
  register(
    saveComposeDraftCommand,
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
  register(deleteComposeDraftCommand, ({ draftKey, expectedRevision }, { storage }) =>
    storage.deleteComposeDraft(
      asString(draftKey, "draftKey"),
      expectedRevision === undefined ? undefined : asNumber(expectedRevision, "expectedRevision"),
    ),
  );
  register(getFileDraftCommand, ({ draftKey }, { storage }) =>
    storage.getFileDraft(asString(draftKey, "draftKey")),
  );
  register(
    saveFileDraftCommand,
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
  register(deleteFileDraftCommand, ({ draftKey, expectedRevision }, { storage }) =>
    storage.deleteFileDraft(
      asString(draftKey, "draftKey"),
      expectedRevision === undefined ? undefined : asNumber(expectedRevision, "expectedRevision"),
    ),
  );
  register(getAgentHandoffCommand, ({ handoffId }, { storage }) =>
    storage.getAgentHandoff(asString(handoffId, "handoffId")),
  );
  register(
    saveAgentHandoffCommand,
    ({ handoffId, environmentId, version, snapshot }, { storage }) => {
      // Only a renderer older than `create_agent_handoff` still builds its own.
      compatibilityPathUsage.record("agent-handoff.renderer-saved");
      return storage.saveAgentHandoff(
        asString(handoffId, "handoffId"),
        asString(environmentId, "environmentId"),
        asNumber(version, "version"),
        snapshot,
      );
    },
  );
  register(createAgentHandoffCommand, (args, context) =>
    createAgentHandoff(context, parseCreateAgentHandoffInput(args)),
  );
  register(getAgentHandoffCapabilitiesCommand, () => AGENT_HANDOFF_CAPABILITIES);
  // Older renderers still call these; current ones leave deletion to the backend.
  register(deleteAgentHandoffCommand, ({ handoffId, environmentId }, { storage }) =>
    storage.deleteAgentHandoff(
      asString(handoffId, "handoffId"),
      asString(environmentId, "environmentId"),
    ),
  );
  register(pruneAgentHandoffsCommand, ({ environmentId, referencedHandoffIds }, { storage }) => {
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

function environmentHydrationIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("environmentIds must be a non-empty array");
  }
  if (value.length > MAX_ENVIRONMENT_HYDRATION_IDS) {
    throw new Error(`environmentIds accepts at most ${MAX_ENVIRONMENT_HYDRATION_IDS} ids`);
  }
  const ids = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || id.trim().length === 0 || id.length > 256) {
      throw new Error("environmentIds must hold environment ids");
    }
    ids.add(id);
  }
  return Array.from(ids);
}
