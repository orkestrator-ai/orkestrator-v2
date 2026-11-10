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
import type { DeepMutable, Mutable } from "effect/Types";
import {
  AGENT_INTERACTION_ORIGINS,
  type AgentInteractionPolicy,
} from "../../../agent-interactions.js";
import { AGENT_PLATFORMS } from "../../../agent-platforms.js";
import type { TurnFailureKind } from "../../../agent-usage-limits.js";
import type { AgentSessionOwner } from "../../../coordinator.js";
import type {
  NativeAgentCommandIntent,
  NativeAgentControlUpdate,
  NativeAgentExecutionPolicy,
  NativeAgentModelSubstitution,
} from "../../../native-agent.js";
import type { NativeAgentGoal } from "../../../native-agent-goal.js";
import type { TrustedUserPromptPresentation } from "../../../review-evidence-frames.js";
import { asModel, mutableArray, OpenObject, openRecord } from "../../model-schema.js";

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
/** `DomainTestResult`: the web's type for one domain check (plan item 7010). */
export type DomainResolution = DeepMutable<typeof DomainResolutionSchema.Type>;

// --- Prompt queues, drafts and handoffs ---------------------------------------

/**
 * A part another protocol module declares as an interface, checked as an
 * object (every key kept) and typed as that interface.
 */
function protocolObject<T>() {
  return asModel<T>(OpenObject);
}

/**
 * A field the backend reads through its own validating reader, where a
 * malformed value reads as absent rather than making the whole record
 * unreadable (`retiredDispatch`, `signInResend`, `goal`, `backendTitle`, ...):
 * typed as `T`, not checked in a decode.
 */
function selfValidated<T>() {
  return Schema.optional(asModel<T>(Schema.Unknown));
}

const ConversationModeSchema = Schema.Literals(["plan", "build"]);

/** A dispatch's attachments: images and files by path, with an inline copy when small. */
const DispatchAttachmentsField = Schema.optional(
  mutableArray(
    openRecord({
      type: Schema.Literals(["image", "file"]),
      path: Schema.String,
      dataUrl: optionalString,
      filename: optionalString,
    }),
  ),
);

// The prompt queue and the native agent session are the models themselves
// (plan item 7010): every field the storage always writes is required, the
// vocabularies are literals (a new value bumps the domain), and
// `apps/backend/src/core/models.ts` re-exports the types below (the web's
// queue is a view generic over its messages). Message bodies stay opaque.

/** `NativeAgentJobReceipt`: a job request's binding to the prompt it admitted. */
export const NativeAgentJobReceiptSchema = openRecord({
  requestId: Schema.String,
  /** Coalesced presses follow the original admission, including its eventual settlement. */
  dispatchRequestId: optionalString,
  fingerprint: Schema.String,
  status: Schema.Literals(["accepted", "unknown"]),
  queued: Schema.optional(Schema.Literal(true)),
});
export type NativeAgentJobReceipt = Mutable<typeof NativeAgentJobReceiptSchema.Type>;

/**
 * `PersistedPromptQueue`: prompts a user has committed to sending but which
 * have not been dispatched yet, for one agent tab. It lives in the backend
 * because a queued prompt is a user decision, not a view: it must survive a
 * reload, be visible to every client, and still drain when the tab that
 * queued it is closed. Each agent defines its own message shape.
 */
export const PromptQueueSchema = openRecord({
  /** Bounded job request bindings, published before dispatch and kept after queue settlement. */
  jobReceipts: Schema.optional(mutableArray(NativeAgentJobReceiptSchema)),
  /** Only older backends write this lease; retain exclusion until settlement or expiry. */
  outstandingClaim: Schema.optional(
    openRecord({
      token: Schema.String,
      message: Schema.Record(Schema.String, Schema.Unknown),
      claimedAt: Schema.String,
      expiresAt: Schema.String,
    }),
  ),
  queueKey: Schema.String,
  environmentId: Schema.String,
  messages: mutableArray(Schema.Unknown),
  /**
   * A backend-owned dispatch lease. The item remains durable here until the
   * provider acknowledges its stable request id, so a backend restart cannot
   * lose a prompt between dequeue and network dispatch.
   */
  inFlight: Schema.optional(
    openRecord({
      message: Schema.Unknown,
      requestId: Schema.String,
      reservedAt: Schema.String,
      /** Manual steering reservations must never drain as ordinary prompts. */
      steer: Schema.optional(Schema.Literal(true)),
      /**
       * A steer reservation taken from behind the head: the id of the item
       * that was ahead of it, so a restored steer returns to its slot.
       */
      restoreAfterId: optionalString,
      /** Persisted immediately before crossing the irreversible dispatch boundary. */
      submittingAt: optionalString,
      /** Persisted after the provider accepted the prompt, before queue acknowledgement. */
      submittedAt: optionalString,
    }),
  ),
  /**
   * Terminal provider rejection. The original message is restored to the head
   * of `messages`; this marker prevents unattended retries until a caller
   * explicitly clears it.
   */
  dispatchError: Schema.optional(
    openRecord({
      requestId: Schema.String,
      /** Stable identity of the restored queue item that was rejected. */
      messageId: Schema.String,
      /** SHA-256 of the rejected message's JSON; saves keep the latch only while it is unchanged. */
      messageFingerprint: Schema.String,
      message: Schema.String,
      failedAt: Schema.String,
    }),
  ),
  /**
   * Bounded tombstones for backend-authored items that left `messages`
   * without being reserved (removed or replaced before dispatch).
   */
  removedOrigins: Schema.optional(
    mutableArray(openRecord({ requestId: Schema.String, removedAt: Schema.String })),
  ),
  updatedAt: Schema.String,
  revision: Schema.Finite,
});
export type PersistedPromptQueue = Mutable<typeof PromptQueueSchema.Type>;

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

/** `NativeAgentProvider`: the platforms a native agent session runs on. */
export const NativeAgentProviderSchema = Schema.Literals(AGENT_PLATFORMS);
export type NativeAgentProvider = typeof NativeAgentProviderSchema.Type;

/** `IncompleteTurnNotice`: the content-free outcome of an automatic incomplete-turn recovery. */
export const IncompleteTurnNoticeSchema = openRecord({
  kind: Schema.Literals(["failed", "exhausted"]),
  assistantMessageId: Schema.String,
  updatedAt: Schema.String,
});
export type IncompleteTurnNotice = Mutable<typeof IncompleteTurnNoticeSchema.Type>;

/**
 * `PersistedNativeAgentPendingDispatch`: exact replay data for a dispatch
 * whose provider acknowledgement was lost. Projections expose only its
 * request id and timestamp, never prompt or attachment content.
 */
export const PendingDispatchSchema = openRecord({
  /** The provider proved this mail send was refused; cleanup may be retried safely. */
  mailRefused: Schema.optional(Schema.Literal(true)),
  requestId: Schema.String,
  prompt: Schema.String,
  images: Schema.optional(
    mutableArray(openRecord({ filename: Schema.String, data: Schema.String })),
  ),
  attachments: DispatchAttachmentsField,
  schema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  mode: Schema.optional(ConversationModeSchema),
  fastMode: optionalBoolean,
  subAgent: optionalString,
  executionAgent: optionalString,
  includeLocalSettings: optionalBoolean,
  promptSuggestions: optionalBoolean,
  model: optionalString,
  reasoningEffort: optionalString,
  /** The resolved command intent; a retry reuses it verbatim. */
  command: Schema.optional(protocolObject<NativeAgentCommandIntent>()),
  /** The "Continue in…" handoff this request carries. */
  agentHandoffId: optionalString,
  createdAt: Schema.String,
});
export type PersistedNativeAgentPendingDispatch = Mutable<typeof PendingDispatchSchema.Type>;

/**
 * `PersistedNativeAgentSignInResend`: a prompt held for re-sending after a
 * Claude sign-in; the resend gets its own request id, derived from the
 * refused one.
 */
export const SignInResendSchema = openRecord({
  /** The refused request. The session's latest dispatch must still be this one. */
  requestId: Schema.String,
  providerSessionId: Schema.String,
  prompt: Schema.String,
  attachments: DispatchAttachmentsField,
  model: optionalString,
  reasoningEffort: optionalString,
  mode: Schema.optional(ConversationModeSchema),
  fastMode: optionalBoolean,
  subAgent: optionalString,
  includeLocalSettings: optionalBoolean,
  promptSuggestions: optionalBoolean,
  recordedAt: Schema.String,
});
export type PersistedNativeAgentSignInResend = Mutable<typeof SignInResendSchema.Type>;

/**
 * `PersistedNativeAgentPendingSteer`: one steering instruction whose
 * provider admission is still unresolved. The backend owns its request id.
 */
export const PendingSteerSchema = openRecord({
  requestId: Schema.String,
  text: Schema.String,
  inputDigest: Schema.String,
  expectedRunId: Schema.String,
  onMissedTurn: Schema.optional(Schema.Literals(["refuse", "new-turn"])),
  turnRequestId: optionalString,
  state: Schema.Literals(["prepared", "unknown"]),
  /** Source reservation survives until delivery or definitive non-delivery. */
  sourceQueue: Schema.optional(Schema.Literal(true)),
  queueSettlement: Schema.optional(Schema.Literals(["applied", "restore", "discard"])),
  createdAt: Schema.String,
});
export type PersistedNativeAgentPendingSteer = Mutable<typeof PendingSteerSchema.Type>;

/** `PersistedNativeAgentRetiredDispatch`: the last parked dispatch the backend retired. */
export const RetiredDispatchSchema = openRecord({
  requestId: Schema.String,
  retiredAt: Schema.String,
});
export type PersistedNativeAgentRetiredDispatch = Mutable<typeof RetiredDispatchSchema.Type>;

/** `PersistedNativeAgentTurnOutcome`: a recent turn's content-free outcome. */
export const TurnOutcomeSchema = openRecord({
  requestId: Schema.String,
  outcome: Schema.Literals(["completed", "failed"]),
  /** Bounded provider error detail for a failed turn. */
  error: optionalString,
  /**
   * `usage-limit` for a failed turn that stopped on the account's plan
   * allowance. A string here: an older backend ignores the field, and
   * readers classify an unknown kind by `error`.
   */
  failureKind: Schema.optional(asModel<TurnFailureKind>(Schema.String)),
  observedAt: Schema.String,
});
export type PersistedNativeAgentTurnOutcome = Mutable<typeof TurnOutcomeSchema.Type>;

/** `NativeAgentSessionBackendTitle`: the title the backend chose for a provider session. */
export const BackendTitleSchema = openRecord({
  providerSessionId: Schema.String,
  title: Schema.String,
  source: Schema.Literals(["generated", "fallback"]),
  /** The provider confirmed it holds this title. */
  pushed: optionalBoolean,
});
export type NativeAgentSessionBackendTitle = Mutable<typeof BackendTitleSchema.Type>;

/**
 * `PersistedNativeAgentSession`: the durable mapping between a logical UI tab
 * and the provider session that owns its transcript. The backend creates it
 * atomically, so every renderer asking for the same tab receives the same
 * provider session. The fields the backend reads through its own validating
 * reader ({@link selfValidated}) are typed but not checked here, so a
 * malformed value reads as absent there instead of failing the record.
 */
const nativeAgentSessionFields = {
  version: Schema.Literal(1),
  key: Schema.String,
  environmentId: Schema.String,
  /** Explicit durable owner. Records written before v2 migrate to environment ownership. */
  owner: Schema.optional(protocolObject<AgentSessionOwner>()),
  /** Immutable backend-owned execution policy; renderer inputs never replace it. */
  executionPolicy: Schema.optional(Schema.Literal("coordinator-read-only")),
  /** Immutable normalised policy passed to the provider when this session was created. */
  policy: Schema.optional(protocolObject<NativeAgentExecutionPolicy>()),
  agent: NativeAgentProviderSchema,
  logicalSessionKey: Schema.String,
  providerSessionId: Schema.String,
  /**
   * The OpenCode line serving `providerSessionId`: `v2` for an OpenCode 2.x
   * session. Absent means legacy (1.x), as for every record written before
   * the 2.x preview. Set once, at creation; never changes.
   */
  openCodeProtocol: Schema.optional(Schema.Literal("v2")),
  origin: Schema.Literals(AGENT_INTERACTION_ORIGINS),
  interactionPolicy: protocolObject<AgentInteractionPolicy>(),
  /** Provider-neutral interactive choices that survive renderer and backend restarts. */
  controls: Schema.optional(protocolObject<NativeAgentControlUpdate>()),
  /** Observed OpenCode model, written only when host controls have no `modelId`. */
  inferredComposerSelection: Schema.optional(
    openRecord({ modelId: Schema.String, reasoningId: optionalString }),
  ),
  /** Exact backend-authored frame that may be hidden on the first matching user echo. */
  initialPromptPresentation: Schema.optional(protocolObject<TrustedUserPromptPresentation>()),
  dispatchedRequestIds: Schema.optional(mutableArray(Schema.String)),
  /** The mode the newest accepted turn was sent in. */
  lastDispatchedTurn: Schema.optional(
    openRecord({ requestId: Schema.String, mode: Schema.optional(ConversationModeSchema) }),
  ),
  /** Retained only while the provider outcome is ambiguous. */
  pendingDispatch: Schema.optional(PendingDispatchSchema),
  /** Retained until an ambiguous steer is reconciled or discarded. */
  pendingSteer: Schema.optional(PendingSteerSchema),
  /** The last parked dispatch the backend retired (content-free; read through its reader). */
  retiredDispatch: selfValidated<PersistedNativeAgentRetiredDispatch>(),
  /**
   * Content-free authoritative recovery outcome rehydrated by every tab. The
   * name is the one it was first persisted under, when OpenCode was the only
   * platform with turn recovery.
   */
  openCodeIncompleteTurnNotice: Schema.optional(IncompleteTurnNoticeSchema),
  /**
   * The model this session was created on in place of the one it asked for, and
   * the message saying so. Set once, at creation, so every tab reading the
   * session shows it, including when the first dispatch created the session
   * and no renderer saw the ensure answer.
   */
  modelSubstitutionNotice: selfValidated<NativeAgentModelSubstitution>(),
  /** Bounded, content-free outcomes of recent turns keyed by their request id. */
  turnOutcomes: Schema.optional(mutableArray(TurnOutcomeSchema)),
  /** "Continue in…" handoffs this session's journal delivered. */
  deliveredAgentHandoffIds: selfValidated<string[]>(),
  /** A prompt Claude refused before a sign-in, held to be sent again. */
  signInResend: selfValidated<PersistedNativeAgentSignInResend>(),
  /** Last applied activity for a request; settled roots may still own background work. */
  activityTurn: Schema.optional(
    openRecord({
      providerSessionId: Schema.String,
      requestId: optionalString,
      state: Schema.Literals(["active", "settled"]),
    }),
  ),
  /** The session's goal. */
  goal: selfValidated<NativeAgentGoal>(),
  /** The last few ended goals, without their check output. */
  goalHistory: selfValidated<NativeAgentGoal[]>(),
  /** Bounded request ids whose turn was still active when a stop was requested. */
  interruptedRequestIds: Schema.optional(mutableArray(Schema.String)),
  /** The identity a later resume of this conversation names (Codex's thread id). */
  resumeIdentity: selfValidated<{ providerSessionId: string; resumableSessionId: string }>(),
  /** The title the backend chose for `providerSessionId`, and whether the provider holds it. */
  backendTitle: selfValidated<NativeAgentSessionBackendTitle>(),
  createdAt: Schema.String,
  updatedAt: Schema.String,
};

export const NativeAgentSessionSchema = openRecord(nativeAgentSessionFields);
export type PersistedNativeAgentSession = Mutable<typeof NativeAgentSessionSchema.Type>;

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
  /** A temporary refusal with nothing sent: a new request id may succeed. */
  transient: optionalBoolean,
  origin: optionalString,
  /** A retried steer that missed its turn: `new-turn` or `queued`. */
  deliveredAs: optionalString,
});

/** `NativeAgentSessionActionOutcome` (native-agent.ts), including a verified steer refusal. */
export const SessionActionOutcomeSchema = openRecord({
  outcome: Schema.String,
  instructionsIgnored: optionalBoolean,
  shareUrl: optionalString,
  preview: Schema.optional(Schema.Unknown),
  requestId: optionalString,
  /** A steer that missed its turn: `new-turn` or `queued` (0005 task 10). */
  deliveredAs: optionalString,
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
