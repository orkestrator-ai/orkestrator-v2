/**
 * `native-sessions` commands for what a person has committed to send or is
 * still writing: prompt queues, compose and file drafts, "Continue in…"
 * handoffs and the renderer's boot hydration batch. Registered by the
 * backend's `commands-registry-prompts.ts`. The argument rules are those of
 * `commands-agent.ts`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { mutableArray } from "../../model-schema.js";
import { nativeSessionsDomain } from "./domain.js";
import {
  AgentHandoffCapabilitiesSchema,
  AgentHandoffSchema,
  ComposeDraftSchema,
  conditionalSnapshotOf,
  EnvironmentHydrationBatchSchema,
  FileDraftSchema,
  PromptQueueRemovalSchema,
  PromptQueueSchema,
} from "./schemas.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);
const optionalRevision = Schema.optionalKey(Schema.Finite);

const PromptQueues = Schema.Array(PromptQueueSchema);
const NullablePromptQueue = Schema.NullOr(PromptQueueSchema);

export const getPromptQueueCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_prompt_queue",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ queueKey: Schema.String }),
  result: NullablePromptQueue,
  critical: [],
});

/** An environment's prompt queues, or the conditional answer. */
export const listPromptQueuesCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "list_prompt_queues",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Schema.String,
    knownManifestGeneration: optionalUnknown,
    knownResourceRevision: optionalUnknown,
  }),
  result: Schema.Union([PromptQueues, conditionalSnapshotOf(PromptQueues)]),
  critical: [],
});

/**
 * A renderer's boot restore for many environments in one request
 * (`environment-hydration.ts`): each environment's prompt queues and Multi
 * Review workflows, each list failing on its own.
 */
export const listEnvironmentHydrationCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "list_environment_hydration",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ environmentIds: optionalUnknown }),
  result: EnvironmentHydrationBatchSchema,
  critical: [],
});

/** Queues a prompt; from here the backend owns its dispatch. */
export const enqueuePromptQueueMessageCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "enqueue_prompt_queue_message",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    queueKey: Schema.String,
    environmentId: Schema.String,
    message: optionalUnknown,
  }),
  result: PromptQueueSchema,
  critical: [],
});

/** Removes a queued prompt (an annotation request's removal cancels the request). */
export const removePromptQueueMessageCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "remove_prompt_queue_message",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    queueKey: Schema.String,
    environmentId: Schema.String,
    messageId: Schema.String,
  }),
  result: PromptQueueRemovalSchema,
  critical: [],
});

export const movePromptQueueMessageCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "move_prompt_queue_message",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    queueKey: Schema.String,
    environmentId: Schema.String,
    messageId: Schema.String,
    direction: Schema.String,
  }),
  result: NullablePromptQueue,
  critical: [],
});

/** Clears a queue's dispatch error so its head is sent again. */
export const retryPromptQueueDispatchCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "retry_prompt_queue_dispatch",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ queueKey: Schema.String }),
  result: NullablePromptQueue,
  critical: [],
});

export const getComposeDraftCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_compose_draft",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ draftKey: Schema.String }),
  result: Schema.NullOr(ComposeDraftSchema),
  critical: [],
});

export const listComposeDraftsCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "list_compose_drafts",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ ownerType: Schema.String, ownerId: Schema.String }),
  result: Schema.Array(ComposeDraftSchema),
  critical: [],
});

// expectedRevision on the draft writes: the compare-and-swap guard; a receiver
// ignoring it would overwrite (or delete) another client's newer draft.

export const saveComposeDraftCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "save_compose_draft",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    draftKey: Schema.String,
    ownerType: Schema.String,
    ownerId: Schema.String,
    value: optionalUnknown,
    expectedRevision: optionalRevision,
  }),
  result: ComposeDraftSchema,
  critical: ["expectedRevision"],
});

export const deleteComposeDraftCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "delete_compose_draft",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ draftKey: Schema.String, expectedRevision: optionalRevision }),
  result: Schema.Void,
  critical: ["expectedRevision"],
});

export const getFileDraftCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_file_draft",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ draftKey: Schema.String }),
  result: Schema.NullOr(FileDraftSchema),
  critical: [],
});

export const saveFileDraftCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "save_file_draft",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    draftKey: Schema.String,
    environmentId: Schema.String,
    filePath: Schema.String,
    content: Schema.String,
    originalContent: Schema.String,
    expectedRevision: optionalRevision,
  }),
  result: FileDraftSchema,
  critical: ["expectedRevision"],
});

export const deleteFileDraftCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "delete_file_draft",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ draftKey: Schema.String, expectedRevision: optionalRevision }),
  result: Schema.Void,
  critical: ["expectedRevision"],
});

export const getAgentHandoffCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_agent_handoff",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ handoffId: Schema.String }),
  result: Schema.NullOr(AgentHandoffSchema),
  critical: [],
});

/** A renderer-built handoff: only a renderer older than `create_agent_handoff` sends one. */
export const saveAgentHandoffCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "save_agent_handoff",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    handoffId: Schema.String,
    environmentId: Schema.String,
    version: Schema.Finite,
    snapshot: optionalUnknown,
  }),
  result: AgentHandoffSchema,
  critical: [],
});

/** Builds a handoff from the source session's transcript and stores it (idempotent). */
export const createAgentHandoffCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "create_agent_handoff",
  since: 1,
  access: "workspace",
  read: false,
  // Every key is checked by `parseCreateAgentHandoffInput` with its own message.
  args: Schema.Struct({
    handoffId: optionalUnknown,
    environmentId: optionalUnknown,
    sourceAgent: optionalUnknown,
    logicalSessionKey: optionalUnknown,
    sourceSessionId: optionalUnknown,
    destinationProvider: optionalUnknown,
    priorHandoffId: optionalUnknown,
    sourceTitle: optionalUnknown,
    sourceModel: optionalUnknown,
  }),
  result: AgentHandoffSchema,
  critical: [],
});

/**
 * What this backend does for handoffs (a capability command). All of it is
 * part of `native-sessions` version 1; the command stays for pre-contract
 * clients until the register row retires.
 */
export const getAgentHandoffCapabilitiesCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_agent_handoff_capabilities",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: AgentHandoffCapabilitiesSchema,
  critical: [],
});

/** Older renderers still delete their handoffs; current ones leave it to the backend. */
export const deleteAgentHandoffCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "delete_agent_handoff",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ handoffId: Schema.String, environmentId: Schema.String }),
  result: Schema.Boolean,
  critical: [],
});

/** Deletes the environment's handoffs no layout references; answers their ids. */
export const pruneAgentHandoffsCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "prune_agent_handoffs",
  since: 1,
  access: "workspace",
  read: false,
  // `referencedHandoffIds` is checked strictly by the handler (a non-array must
  // never read as "nothing is referenced").
  args: Schema.Struct({ environmentId: Schema.String, referencedHandoffIds: optionalUnknown }),
  result: mutableArray(Schema.String),
  critical: [],
});

export const PROMPT_COMMANDS = [
  getPromptQueueCommand,
  listPromptQueuesCommand,
  listEnvironmentHydrationCommand,
  enqueuePromptQueueMessageCommand,
  removePromptQueueMessageCommand,
  movePromptQueueMessageCommand,
  retryPromptQueueDispatchCommand,
  getComposeDraftCommand,
  listComposeDraftsCommand,
  saveComposeDraftCommand,
  deleteComposeDraftCommand,
  getFileDraftCommand,
  saveFileDraftCommand,
  deleteFileDraftCommand,
  getAgentHandoffCommand,
  saveAgentHandoffCommand,
  createAgentHandoffCommand,
  getAgentHandoffCapabilitiesCommand,
  deleteAgentHandoffCommand,
  pruneAgentHandoffsCommand,
] as const;
