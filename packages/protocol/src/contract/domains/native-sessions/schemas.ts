/**
 * Result shapes of the `native-sessions` commands (plan item 7001), derived
 * from the backend's model types (`apps/backend/src/core/models.ts`) and the
 * protocol's native-agent types (`native-agent.ts`, `agent-interactions.ts`,
 * `suborks.ts`, `pane-layout.ts`, `resource-events.ts`). Plan item 7010
 * converges the models on these.
 *
 * Model-shaped records are **open structs** ({@link openRecord}): the fields
 * listed are checked and typed, and every other key the backend sends is
 * kept. A domain client decodes results tolerantly, and `Schema.Struct` drops
 * the keys it does not declare, so a closed struct would silently strip the
 * many optional fields a projection or a session record carries. The listed
 * fields are the ones a reader routes on; deeper parts (transcript rows,
 * composer catalogues, interaction payloads) stay open objects until 7010.
 *
 * Values a newer backend may extend (providers, phases, statuses) are
 * `Schema.String`, not literals, so an older client still reads them.
 *
 * A record's fields are optional (`optionalKey`) apart from the
 * discriminators a reader branches on (`outcome`, `status`) and fields the
 * registering handler itself always writes: the services behind these
 * commands are faked in tests with partial records, and results are
 * validated there. A field's type is still checked whenever it is present.
 * Which fields are always present is converged with the models in 7010.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { OpenObject, openRecord } from "../../model-schema.js";

const optionalString = Schema.optional(Schema.String);
const optionalBoolean = Schema.optional(Schema.Boolean);
const optionalNumber = Schema.optional(Schema.Finite);
const optionalObject = Schema.optional(OpenObject);
const StringArray = Schema.Array(Schema.String);

/** `string | number`, as `generation` is. */
export const Generation = Schema.Union([Schema.String, Schema.Finite]);

// --- Terminal sessions, buffers and pane layouts ------------------------------

// The terminal session record, the pane layout and the drafts are the models
// themselves (plan item 7010): every field the storage always writes is
// required, and `apps/backend/src/core/models.ts` and the web's types
// re-export the types below. They stay open records, so a newer backend's
// added field passes through a decode.

/** `SessionType`: what a terminal tab runs. A new kind bumps the domain. */
export const SessionTypeSchema = Schema.Literals(["plain", "claude", "opencode", "codex", "root"]);
export type SessionType = typeof SessionTypeSchema.Type;

/** `SessionStatus`: whether the terminal is attached. */
export const SessionStatusSchema = Schema.Literals(["connected", "disconnected"]);
export type SessionStatus = typeof SessionStatusSchema.Type;

/** `Session`: one terminal tab's session record. */
export const TerminalSessionSchema = openRecord({
  /** Unique session ID (UUID). */
  id: Schema.String,
  environmentId: Schema.String,
  /** Docker container ID (from the environment). */
  containerId: Schema.String,
  /** Frontend tab ID for session restoration. */
  tabId: Schema.String,
  sessionType: SessionTypeSchema,
  status: SessionStatusSchema,
  /** ISO timestamps. */
  createdAt: Schema.String,
  lastActivityAt: Schema.String,
  /** Custom name for the session (user-defined). */
  name: optionalString,
  /** Display order within the environment (lower is higher in the list). */
  order: Schema.Finite,
});
export type Session = Mutable<typeof TerminalSessionSchema.Type>;

/**
 * `PersistedPaneLayout`: the versioned pane/tab layout the backend stores for
 * restore-on-connect. `root` is opaque to the backend; the renderer owns the
 * PaneNode schema and validates it before installing a restored layout.
 */
export const PaneLayoutSchema = openRecord({
  version: Schema.Finite,
  environmentId: Schema.String,
  containerId: Schema.NullOr(Schema.String),
  activePaneId: Schema.String,
  root: Schema.Unknown,
  updatedAt: Schema.String,
  revision: Schema.Finite,
});
export type PersistedPaneLayout = Mutable<typeof PaneLayoutSchema.Type>;

/**
 * `ConditionalResourceSnapshot<T>` (resource-events.ts): the answer to a read
 * that sent `knownManifestGeneration` and `knownResourceRevision`.
 */
export function conditionalSnapshotOf<S extends Schema.Top>(snapshot: S) {
  return Schema.Union([
    Schema.Struct({
      status: Schema.Literal("unchanged"),
      generation: Schema.String,
      revision: Schema.String,
    }),
    Schema.Struct({
      status: Schema.Literal("changed"),
      generation: Schema.String,
      revision: Schema.String,
      snapshot,
    }),
  ]);
}

/** One `test_domain_resolution` answer. */
export const DomainResolutionSchema = Schema.Struct({
  domain: Schema.String,
  valid: Schema.Boolean,
  resolvable: Schema.Boolean,
  ips: StringArray,
  error: Schema.NullOr(Schema.String),
});

// --- Prompt queues, drafts and handoffs ---------------------------------------

/** `PersistedPromptQueue` (models.ts). Queued messages are each agent's own shape. */
export const PromptQueueSchema = openRecord({
  queueKey: Schema.optional(Schema.String),
  environmentId: Schema.optional(Schema.String),
  messages: Schema.optional(Schema.Array(Schema.Unknown)),
  inFlight: optionalObject,
  dispatchError: optionalObject,
  jobReceipts: Schema.optional(Schema.Array(OpenObject)),
  removedOrigins: Schema.optional(Schema.Array(OpenObject)),
  updatedAt: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.Finite),
});

/** `remove_prompt_queue_message`: the removed message (or `null`) and the queue after it. */
export const PromptQueueRemovalSchema = openRecord({
  removed: Schema.optional(Schema.Unknown),
  queue: Schema.optional(Schema.NullOr(PromptQueueSchema)),
});

/**
 * `PersistedComposeDraft`: unsent input owned by an environment or project.
 * `value` is each composer's own shape; the backend owns durability and
 * revisions while each frontend validates its own value.
 */
export const ComposeDraftSchema = openRecord({
  draftKey: Schema.String,
  ownerType: Schema.Literals(["environment", "project"]),
  ownerId: Schema.String,
  value: Schema.Unknown,
  sourcePromptQueue: Schema.optional(
    Schema.Struct({ queueKey: Schema.String, messageId: Schema.String }),
  ),
  /** Set when a legacy browser note was saved as references to annotation threads. */
  webAnnotationMigration: Schema.optional(
    Schema.Struct({ references: Schema.Array(Schema.Unknown) }),
  ),
  updatedAt: Schema.String,
  revision: Schema.Finite,
});
export type PersistedComposeDraft = Mutable<typeof ComposeDraftSchema.Type>;

/** `PersistedFileDraft`: a recoverable unsaved text-file buffer. */
export const FileDraftSchema = openRecord({
  draftKey: Schema.String,
  environmentId: Schema.String,
  filePath: Schema.String,
  content: Schema.String,
  originalContent: Schema.String,
  updatedAt: Schema.String,
  revision: Schema.Finite,
});
export type PersistedFileDraft = Mutable<typeof FileDraftSchema.Type>;

/**
 * `PersistedAgentHandoff`: an immutable provider-to-provider handoff. The
 * backend owns the sensitive envelope; `snapshot` is the renderer-validated,
 * provider-neutral transcript, opaque to the backend.
 */
export const AgentHandoffSchema = openRecord({
  version: Schema.Finite,
  id: Schema.String,
  environmentId: Schema.String,
  snapshot: Schema.Unknown,
  createdAt: Schema.String,
});
export type PersistedAgentHandoff = Mutable<typeof AgentHandoffSchema.Type>;

/** `AGENT_HANDOFF_CAPABILITIES` (backend `agent-handoffs.ts`). */
export const AgentHandoffCapabilitiesSchema = openRecord({
  create: optionalBoolean,
  delivery: optionalBoolean,
  pruning: optionalBoolean,
});

/** `EnvironmentHydrationPart<T>` (environment-hydration.ts). */
const HydrationPartSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok"), records: Schema.Array(OpenObject) }),
  Schema.Struct({ status: Schema.Literal("failed") }),
]);

/** `EnvironmentHydrationBatch` (environment-hydration.ts). */
export const EnvironmentHydrationBatchSchema = Schema.Struct({
  environments: Schema.Array(
    Schema.Struct({
      environmentId: Schema.String,
      promptQueues: HydrationPartSchema,
      multiReviewWorkflows: HydrationPartSchema,
    }),
  ),
});

// --- Native agent sessions ----------------------------------------------------

/** `PersistedNativeAgentSession` (models.ts): the durable record of one native session. */
const nativeAgentSessionFields = {
  version: Schema.optional(Schema.Finite),
  key: Schema.optional(Schema.String),
  environmentId: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  logicalSessionKey: Schema.optional(Schema.String),
  providerSessionId: Schema.optional(Schema.String),
  origin: Schema.optional(Schema.Unknown),
  interactionPolicy: Schema.optional(Schema.Unknown),
  owner: optionalObject,
  controls: optionalObject,
  dispatchedRequestIds: Schema.optional(StringArray),
  pendingDispatch: optionalObject,
  retiredDispatch: optionalObject,
  goal: optionalObject,
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
};

export const NativeAgentSessionSchema = openRecord(nativeAgentSessionFields);

/** `NativeAgentModelSubstitution` (native-agent.ts). */
export const ModelSubstitutionSchema = Schema.Struct({
  requestedModelId: Schema.String,
  modelId: Schema.String,
  message: Schema.String,
});

/** `EnsuredNativeAgentSession`: the record plus a substitution reported to the caller only. */
export const EnsuredNativeAgentSessionSchema = openRecord({
  ...nativeAgentSessionFields,
  modelSubstitution: Schema.optional(ModelSubstitutionSchema),
});

/**
 * `NativeAgentSessionProjection` (native-agent.ts): the interactive view of
 * one session. `messages` are the provider-neutral transcript rows, which the
 * renderer validates itself.
 */
export const NativeAgentProjectionSchema = openRecord({
  platform: Schema.optional(Schema.String),
  environmentId: Schema.optional(Schema.String),
  sessionId: optionalString,
  title: optionalString,
  shareUrl: Schema.optional(Schema.NullOr(Schema.String)),
  connection: Schema.optional(Schema.String),
  turn: Schema.optional(openRecord({ phase: Schema.String })),
  messages: Schema.optional(Schema.Array(Schema.Unknown)),
  messageWindow: optionalObject,
  interactions: Schema.optional(Schema.Array(OpenObject)),
  composerControls: Schema.optional(Schema.Array(OpenObject)),
  composer: optionalObject,
  capabilities: Schema.optional(OpenObject),
  queue: optionalObject,
  notices: Schema.optional(Schema.Array(OpenObject)),
  recoverableDispatch: optionalObject,
  suggestedPrompt: optionalString,
  revision: Schema.optional(Schema.Finite),
  generation: Schema.optional(Generation),
  cursor: optionalString,
});

export const NullableProjectionSchema = Schema.NullOr(NativeAgentProjectionSchema);

/** `NativeAgentDispatchOutcome` (native-agent.ts): accepted, rejected or unknown. */
export const DispatchOutcomeSchema = openRecord({
  outcome: Schema.String,
  requestId: optionalString,
  error: optionalString,
  instructionsIgnored: optionalBoolean,
  requestIdRetired: optionalBoolean,
  origin: optionalString,
});

/** `NativeAgentSessionActionOutcome` (native-agent.ts), including a verified steer refusal. */
export const SessionActionOutcomeSchema = openRecord({
  outcome: Schema.String,
  instructionsIgnored: optionalBoolean,
  shareUrl: optionalString,
  preview: Schema.optional(Schema.Unknown),
  requestId: optionalString,
});

/** `AgentInteractionApplyOutcome` (agent-interactions.ts). */
export const InteractionApplyOutcomeSchema = openRecord({
  result: Schema.optional(Schema.String),
  interactionId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.Finite),
});

/** `NativeAgentResumeEntry` (native-agent.ts). */
export const ResumeEntrySchema = openRecord({
  sessionId: Schema.optional(Schema.String),
  title: optionalString,
  createdAt: optionalString,
  updatedAt: optionalString,
  status: optionalString,
  detail: optionalString,
  parentId: optionalString,
  branchLabel: optionalString,
  archived: optionalBoolean,
});

/** `NativeAgentForkOutcome` (native-agent.ts). */
export const ForkOutcomeSchema = openRecord({
  sessionId: Schema.optional(Schema.String),
  controls: optionalObject,
  title: optionalString,
  draft: optionalString,
});

/** `NativeAgentAuthStatus` (native-agent.ts). */
export const AuthStatusSchema = openRecord({
  state: Schema.optional(Schema.String),
  pendingSignIn: Schema.optional(
    Schema.NullOr(
      openRecord({ url: Schema.String, code: Schema.String, expiresAt: Schema.Finite }),
    ),
  ),
  account: optionalObject,
  providers: Schema.optional(Schema.Array(OpenObject)),
  signIn: optionalObject,
  signOut: optionalBoolean,
});

/** `NativeAgentToolDetails` (native-agent.ts): heavy tool fields read on expansion. */
export const ToolDetailsSchema = openRecord({
  detailRef: Schema.optional(Schema.String),
  toolOutput: optionalString,
  toolError: optionalString,
  fileDataUrl: optionalString,
});

/** `refresh_native_agent_commands`: the outcome and the projection after it. */
export const CommandRefreshResultSchema = openRecord({
  outcome: Schema.String,
  message: optionalString,
  projection: Schema.optional(NullableProjectionSchema),
});

/** `GoalCommandResult` (backend `native-agent-goal-service.ts`). */
export const GoalCommandResultSchema = openRecord({
  message: Schema.optional(Schema.String),
  goal: optionalObject,
});

/** The goal detail `get_native_agent_goal` reads from the session record. */
export const GoalDetailSchema = openRecord({
  goal: optionalObject,
  history: Schema.optional(Schema.Array(OpenObject)),
});

/** `NativeAgentSuborkTranscript`: one subork's stored transcript, or why there is none. */
export const SuborkTranscriptSchema = openRecord({
  status: Schema.String,
  messages: Schema.optional(Schema.Array(Schema.Unknown)),
  agent: optionalString,
  startIndex: optionalNumber,
  messageCount: optionalNumber,
  truncated: optionalBoolean,
  transcript: Schema.optional(Schema.Unknown),
});

/** `AgentInteractionObservation` (backend `native-agent-service-shared.ts`). */
export const InteractionObservationSchema = openRecord({
  provider: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  workflowSurface: Schema.optional(Schema.Unknown),
  phase: Schema.optional(Schema.String),
  firstDetectedAt: Schema.optional(Schema.Finite),
  lastDetectedAt: Schema.optional(Schema.Finite),
  count: Schema.optional(Schema.Finite),
  providerState: Schema.optional(Schema.String),
  eventualOutcome: optionalString,
  eventualAt: optionalNumber,
});

/** `ViewRevisionStamp` (view-sync.ts). */
export const ViewRevisionStampSchema = Schema.Struct({
  generation: Schema.String,
  revision: Schema.Finite,
});

const VersionList = Schema.Array(Schema.Int);

/**
 * `get_native_agent_sync_capabilities`: the sync protocols the backend
 * speaks. Folded into `native-sessions` version 1; kept for pre-contract
 * clients.
 */
export const SyncCapabilitiesSchema = openRecord({
  projectionSyncVersions: VersionList,
  historyPagingVersions: VersionList,
  progressiveViewVersions: Schema.optional(VersionList),
  observationEventVersions: Schema.optional(VersionList),
  transcriptPatchVersions: Schema.optional(VersionList),
  liveUpdateVersions: Schema.optional(VersionList),
  observation: Schema.optional(ViewRevisionStampSchema),
});

/** `NativeAgentViewIdentity` (native-agent.ts). */
export const ViewIdentitySchema = openRecord({
  backendInstanceId: Schema.optional(Schema.String),
  environmentId: Schema.optional(Schema.String),
  platform: Schema.optional(Schema.String),
  logicalSessionKey: Schema.optional(Schema.String),
  providerSessionId: Schema.optional(Schema.String),
  sourceGeneration: Schema.optional(Generation),
});

/**
 * One progressive view update (`NativeAgentDomainUpdate<T>` and the
 * transcript's `delta`, native-agent.ts): `status` says which fields are
 * present (`snapshot`: `token` and `value`; `unchanged`: `token` and
 * `identity`; `delta`: `baseToken`, `token`, `identity` and `delta`;
 * `missing`; `unavailable`: `retryable`), and the renderer's own
 * `isNativeAgent*Update` guards check the combination.
 */
export const ViewUpdateSchema = openRecord({
  viewVersion: Schema.optional(Schema.Finite),
  status: Schema.String,
  token: optionalString,
  baseToken: optionalString,
  value: optionalObject,
  identity: Schema.optional(ViewIdentitySchema),
  delta: optionalObject,
  resetReason: optionalString,
  retryable: optionalBoolean,
  error: optionalString,
});

/** `NativeAgentLiveUpdate` (native-agent.ts): transcript and state in one read. */
export const LiveUpdateSchema = openRecord({
  viewVersion: Schema.optional(Schema.Finite),
  transcript: Schema.optional(ViewUpdateSchema),
  state: Schema.optional(ViewUpdateSchema),
});

/** `NativeAgentProjectionUpdate` (native-agent.ts), the sync-v1 projection read. */
export const ProjectionUpdateSchema = openRecord({
  syncVersion: Schema.optional(Schema.Finite),
  status: Schema.String,
  token: optionalString,
  baseToken: optionalString,
  projection: Schema.optional(NativeAgentProjectionSchema),
  delta: optionalObject,
  historyCursor: optionalString,
  historyEpoch: optionalString,
  historyComplete: optionalBoolean,
  resetReason: optionalString,
});

/** `NativeAgentMessagePage` (native-agent.ts): one page of older transcript rows. */
export const MessagePageSchema = openRecord({
  syncVersion: Schema.optional(Schema.Finite),
  messages: Schema.optional(Schema.Array(Schema.Unknown)),
  historyEpoch: Schema.optional(Schema.String),
  nextCursor: optionalString,
  complete: Schema.optional(Schema.Boolean),
  truncated: Schema.optional(Schema.Boolean),
});
