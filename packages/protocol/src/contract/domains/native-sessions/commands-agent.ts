/**
 * `native-sessions` commands for native agent sessions (plan item 7001):
 * creating and adopting a session, dispatching prompts, the projection and
 * the progressive views, session actions, sign-in, interactions and the
 * session's suborks. Registered by the backend's
 * `commands-registry-native.ts` and `commands-registry-suborks.ts`.
 *
 * Arguments: every key a handler reads is declared, because a defined
 * command drops the keys it does not declare. A key the handler reads as a
 * plain string, number or boolean (`asString`, `asNonBlankString`,
 * `asNumber`, `asRequiredBoolean`) is typed, which keeps the handler's text
 * (`Expected environmentId to be a string`). A key the handler reads
 * leniently (`typeof args.title === "string" ? ... : undefined`) or checks
 * with its own message (bounded strings, positive integers, nested records)
 * stays `Unknown`, so nothing accepted today is refused and every error text
 * is unchanged (§11.4).
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { nativeSessionsDomain } from "./domain.js";
import {
  AuthStatusSchema,
  CommandRefreshResultSchema,
  DispatchOutcomeSchema,
  EnsuredNativeAgentSessionSchema,
  ForkOutcomeSchema,
  GoalCommandResultSchema,
  GoalDetailSchema,
  InteractionApplyOutcomeSchema,
  InteractionObservationSchema,
  LiveUpdateSchema,
  MessagePageSchema,
  NativeAgentSessionSchema,
  NullableProjectionSchema,
  ProjectionUpdateSchema,
  ResumeEntrySchema,
  SessionActionOutcomeSchema,
  SuborkTranscriptSchema,
  SyncCapabilitiesSchema,
  ToolDetailsSchema,
  ViewUpdateSchema,
} from "./schemas.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);
const optionalString = Schema.optionalKey(Schema.String);

/** The three keys that name one native session. */
const sessionKey = {
  environmentId: Schema.String,
  agent: Schema.String,
  logicalSessionKey: Schema.String,
};

/** Session-creation fields `ensure_native_agent_session` and the dispatches share. */
const sessionCreation = {
  origin: optionalUnknown,
  interactionPolicy: optionalUnknown,
  title: optionalUnknown,
  model: optionalUnknown,
  modelSource: optionalUnknown,
  reasoningEffort: optionalUnknown,
  phase: optionalUnknown,
  sessionMode: optionalUnknown,
  fastMode: optionalUnknown,
  executionProfileId: optionalUnknown,
  parameterValues: optionalUnknown,
};

/** Creates the session record for a tab, or returns the one it has. */
export const ensureNativeAgentSessionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "ensure_native_agent_session",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...sessionKey, ...sessionCreation }),
  result: EnsuredNativeAgentSessionSchema,
  // interactionPolicy and executionProfileId: safety options; a receiver that
  // ignored them would run the session under its defaults.
  critical: ["interactionPolicy", "executionProfileId"],
});

/** Binds a tab to an existing provider session (resume, fork, handoff). */
export const adoptNativeAgentSessionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "adopt_native_agent_session",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ...sessionKey,
    origin: optionalUnknown,
    interactionPolicy: optionalUnknown,
    providerSessionId: Schema.String,
    expectedProviderSessionId: optionalString,
    title: optionalUnknown,
    controls: optionalUnknown,
    model: optionalUnknown,
    reasoningEffort: optionalUnknown,
    phase: optionalUnknown,
    sessionMode: optionalUnknown,
    fastMode: optionalUnknown,
    executionProfileId: optionalUnknown,
  }),
  result: NativeAgentSessionSchema,
  // expectedProviderSessionId: the compare-and-swap guard; ignoring it would
  // replace a session the caller did not mean to.
  critical: ["expectedProviderSessionId", "interactionPolicy", "executionProfileId"],
});

/** The arguments of both dispatches (`asDispatchNativeAgentPromptInput`). */
const dispatchArgs = Schema.Struct({
  ...sessionKey,
  ...sessionCreation,
  prompt: optionalUnknown,
  requestId: optionalUnknown,
  command: optionalUnknown,
  approvalMode: optionalUnknown,
  images: optionalUnknown,
  attachments: optionalUnknown,
  schema: optionalUnknown,
  mode: optionalUnknown,
  subAgent: optionalUnknown,
  executionAgent: optionalUnknown,
  includeLocalSettings: optionalUnknown,
  promptSuggestions: optionalUnknown,
  clientTimeZone: optionalUnknown,
});

// requestId: the idempotency key; a receiver ignoring it would run a retry twice.
// command: a non-literal intent read as typed text would run something else.
// schema: the caller parses structured output; ignored, the turn answers prose.
// images, attachments: ignoring them sends the prompt without its files.
// approvalMode, interactionPolicy, executionProfileId: safety options.
const dispatchCritical = [
  "requestId",
  "command",
  "schema",
  "images",
  "attachments",
  "approvalMode",
  "interactionPolicy",
  "executionProfileId",
] as const;

/** Sends a prompt to the tab's session (the older, session-returning form). */
export const dispatchNativeAgentPromptCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "dispatch_native_agent_prompt",
  since: 1,
  access: "workspace",
  read: false,
  args: dispatchArgs,
  result: NativeAgentSessionSchema,
  critical: dispatchCritical,
});

/** Sends a prompt and answers how the provider took it. */
export const dispatchNativeAgentIntentCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "dispatch_native_agent_intent",
  since: 1,
  access: "workspace",
  read: false,
  args: dispatchArgs,
  result: DispatchOutcomeSchema,
  critical: dispatchCritical,
});

const recoverableDispatchArgs = Schema.Struct({ ...sessionKey, requestId: Schema.String });

/** Sends a parked (ambiguous) dispatch again with its own request id. */
export const retryNativeAgentDispatchCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "retry_native_agent_dispatch",
  since: 1,
  access: "workspace",
  read: false,
  args: recoverableDispatchArgs,
  result: DispatchOutcomeSchema,
  critical: [],
});

/** Forgets a parked dispatch. */
export const discardNativeAgentDispatchCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "discard_native_agent_dispatch",
  since: 1,
  access: "workspace",
  read: false,
  args: recoverableDispatchArgs,
  result: Schema.Struct({ discarded: Schema.Boolean }),
  critical: [],
});

const sessionKeyArgs = Schema.Struct(sessionKey);

/** The stored session record, or `null`. */
export const getNativeAgentSessionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_native_agent_session",
  since: 1,
  access: "workspace",
  read: true,
  args: sessionKeyArgs,
  result: Schema.NullOr(NativeAgentSessionSchema),
  critical: [],
});

/** The whole projection (the pre-progressive read). */
export const getNativeAgentProjectionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_native_agent_projection",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    ...sessionKey,
    messageLimit: optionalUnknown,
    refreshUsage: optionalUnknown,
  }),
  result: NullableProjectionSchema,
  critical: [],
});

/** Whether the tab's refused prompt goes out again after a sign-in. */
export const getNativeAgentSignInResendCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_native_agent_sign_in_resend",
  since: 1,
  access: "workspace",
  read: true,
  // Without a native agent service the handler answers `{ pending: false }`
  // before reading any argument, so none is required here.
  args: Schema.Struct({
    environmentId: optionalUnknown,
    agent: optionalUnknown,
    logicalSessionKey: optionalUnknown,
  }),
  result: Schema.Struct({ pending: Schema.Boolean }),
  critical: [],
});

/**
 * The sync protocols this backend speaks (a capability command). Every
 * version it lists is part of `native-sessions` version 1; the command stays
 * for pre-contract clients until the register row retires.
 */
export const getNativeAgentSyncCapabilitiesCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_native_agent_sync_capabilities",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: SyncCapabilitiesSchema,
  critical: [],
});

/** The view-protocol keys the progressive reads check themselves. */
const progressive = {
  viewVersion: optionalUnknown,
  knownToken: optionalUnknown,
  forceSnapshot: optionalUnknown,
};

/** The progressive transcript view. Pre-encoded rows: the gateway splices them. */
export const getNativeAgentTranscriptUpdateCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_native_agent_transcript_update",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    ...sessionKey,
    ...progressive,
    liveWindow: optionalUnknown,
    patchVersion: optionalUnknown,
  }),
  result: ViewUpdateSchema,
  critical: [],
  encoded: true,
});

/** The progressive session-state view. */
export const getNativeAgentSessionStateUpdateCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_native_agent_session_state_update",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ ...sessionKey, ...progressive }),
  result: ViewUpdateSchema,
  critical: [],
});

/** Transcript and state in one read. Pre-encoded rows: the gateway splices them. */
export const getNativeAgentLiveUpdateCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_native_agent_live_update",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    ...sessionKey,
    viewVersion: optionalUnknown,
    liveWindow: optionalUnknown,
    transcriptToken: optionalUnknown,
    stateToken: optionalUnknown,
    patchVersion: optionalUnknown,
  }),
  result: LiveUpdateSchema,
  critical: [],
  encoded: true,
});

/** The progressive discovery view (models, commands, MCP servers, runtime). */
export const getNativeAgentDiscoveryUpdateCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_native_agent_discovery_update",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ ...sessionKey, ...progressive, sections: optionalUnknown }),
  result: ViewUpdateSchema,
  critical: [],
});

/** The sync-v1 projection read. Pre-encoded rows: the gateway splices them. */
export const getNativeAgentProjectionUpdateCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_native_agent_projection_update",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    ...sessionKey,
    syncVersion: optionalUnknown,
    liveWindow: optionalUnknown,
    knownToken: optionalUnknown,
    forceSnapshot: optionalUnknown,
  }),
  result: ProjectionUpdateSchema,
  critical: [],
  encoded: true,
});

/** One page of older transcript rows. Pre-encoded rows: the gateway splices them. */
export const getNativeAgentMessagePageCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_native_agent_message_page",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    ...sessionKey,
    syncVersion: optionalUnknown,
    before: optionalUnknown,
    limit: optionalUnknown,
    targetBytes: optionalUnknown,
  }),
  result: MessagePageSchema,
  critical: [],
  encoded: true,
});

/** A transcript row's heavy tool fields. */
export const getNativeAgentToolDetailsCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_native_agent_tool_details",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ ...sessionKey, detailRef: Schema.String }),
  result: ToolDetailsSchema,
  critical: [],
});

/** Re-reads the provider's model list. */
export const refreshNativeAgentModelsCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "refresh_native_agent_models",
  since: 1,
  access: "workspace",
  read: false,
  args: sessionKeyArgs,
  result: NullableProjectionSchema,
  critical: [],
});

/** Re-reads the provider's slash commands. */
export const refreshNativeAgentCommandsCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "refresh_native_agent_commands",
  since: 1,
  access: "workspace",
  read: false,
  args: sessionKeyArgs,
  result: CommandRefreshResultSchema,
  critical: [],
});

/** Runs `/goal` now, outside the prompt queue. */
export const nativeAgentGoalCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "native_agent_goal_command",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...sessionKey, text: optionalUnknown, model: optionalUnknown }),
  result: GoalCommandResultSchema,
  critical: [],
});

/** The session's goal and its recent history. */
export const getNativeAgentGoalCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_native_agent_goal",
  since: 1,
  access: "workspace",
  read: true,
  args: sessionKeyArgs,
  result: GoalDetailSchema,
  critical: [],
});

/** Stops the running turn. */
export const stopNativeAgentSessionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "stop_native_agent_session",
  since: 1,
  access: "workspace",
  read: false,
  args: sessionKeyArgs,
  result: NullableProjectionSchema,
  critical: [],
});

/** Stops one background task of the session. */
export const stopNativeAgentBackgroundTaskCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "stop_native_agent_background_task",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...sessionKey, taskId: Schema.String }),
  result: NullableProjectionSchema,
  critical: [],
});

/** Dismisses the provider's suggested next prompt. */
export const dismissNativeAgentSuggestedPromptCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "dismiss_native_agent_suggested_prompt",
  since: 1,
  access: "workspace",
  read: false,
  args: sessionKeyArgs,
  result: NullableProjectionSchema,
  critical: [],
});

/** Conversations the tab can resume. */
export const listNativeAgentResumableSessionsCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "list_native_agent_resumable_sessions",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ ...sessionKey, includeArchived: optionalUnknown }),
  result: Schema.Array(ResumeEntrySchema),
  critical: [],
});

/** Takes a conversation out of the resume list, or puts it back. */
export const setNativeAgentResumableSessionArchivedCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "set_native_agent_resumable_session_archived",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ...sessionKey,
    resumableSessionId: optionalUnknown,
    archived: optionalUnknown,
  }),
  result: Schema.Struct({ archived: Schema.Boolean }),
  critical: [],
});

/** Resumes a listed conversation in the tab. */
export const resumeNativeAgentSessionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "resume_native_agent_session",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ...sessionKey,
    providerSessionId: Schema.String,
    controls: optionalUnknown,
  }),
  result: NullableProjectionSchema,
  critical: [],
});

/** Forks the conversation, at a message or at its end. */
export const forkNativeAgentSessionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "fork_native_agent_session",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...sessionKey, messageId: optionalString }),
  result: ForkOutcomeSchema,
  // messageId: ignored, the fork would copy the whole conversation instead.
  critical: ["messageId"],
});

/** Changes the composer's controls (model, reasoning, mode...). */
export const updateNativeAgentControlsCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "update_native_agent_controls",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...sessionKey, update: optionalUnknown }),
  result: NullableProjectionSchema,
  critical: [],
});

/** Steers a queued prompt into the running turn. */
export const steerNativeAgentQueuedPromptCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "steer_native_agent_queued_prompt",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...sessionKey, messageId: Schema.String }),
  result: Schema.NullOr(SessionActionOutcomeSchema),
  critical: [],
});

/** One session action (compact, share, rewind, switch branch...). */
export const performNativeAgentSessionActionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "perform_native_agent_session_action",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...sessionKey, action: optionalUnknown }),
  result: SessionActionOutcomeSchema,
  critical: [],
});

/** Reconnects, enables, disables or signs in to one MCP server of the session. */
export const performNativeAgentMcpActionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "perform_native_agent_mcp_action",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...sessionKey, serverId: Schema.String, action: Schema.String }),
  result: Schema.Struct({ url: optionalString }),
  critical: [],
});

/** The provider's account, read now. */
export const getNativeAgentAuthStatusCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_native_agent_auth_status",
  since: 1,
  access: "workspace",
  read: true,
  args: sessionKeyArgs,
  result: Schema.NullOr(AuthStatusSchema),
  critical: [],
});

/** Starts an in-tab sign-in. */
export const beginNativeAgentSignInCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "begin_native_agent_sign_in",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...sessionKey, deviceCode: optionalUnknown }),
  result: Schema.Struct({ url: optionalString, code: optionalString }),
  critical: [],
});

/** Abandons an in-tab sign-in. */
export const cancelNativeAgentSignInCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "cancel_native_agent_sign_in",
  since: 1,
  access: "workspace",
  read: false,
  args: sessionKeyArgs,
  result: Schema.Struct({ cancelled: Schema.Boolean }),
  critical: [],
});

/** Signs the provider out. */
export const signOutNativeAgentCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "sign_out_native_agent",
  since: 1,
  access: "workspace",
  read: false,
  args: sessionKeyArgs,
  result: Schema.Struct({ ok: Schema.Literal(true) }),
  critical: [],
});

/** Answers an interaction (permission, question, plan approval...). */
export const resolveNativeAgentInteractionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "resolve_native_agent_interaction",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...sessionKey, interactionId: Schema.String, resolution: optionalUnknown }),
  result: InteractionApplyOutcomeSchema,
  critical: [],
});

/** Pauses or resumes an interaction's countdown. */
export const holdNativeAgentInteractionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "hold_native_agent_interaction",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ...sessionKey, interactionId: Schema.String, held: Schema.Boolean }),
  result: InteractionApplyOutcomeSchema,
  critical: [],
});

/**
 * The interaction monitor's observations. Diagnostics for the machine's
 * operator; no client of a workspace calls it, so it is `admin`.
 */
export const getAgentInteractionObservationsCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "get_agent_interaction_observations",
  since: 1,
  access: "admin",
  read: true,
  args: Schema.Struct({}),
  result: Schema.Array(InteractionObservationSchema),
  critical: [],
});

/** Reconciles every session's interactions, then answers the observations. */
export const reconcileAgentInteractionsCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "reconcile_agent_interactions",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({}),
  result: Schema.Array(InteractionObservationSchema),
  critical: [],
});

/** Turns the interaction monitor's adoption of sessions on or off, machine-wide. */
export const setAgentInteractionMonitorAdoptionCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "set_agent_interaction_monitor_adoption",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({ enabled: Schema.Boolean }),
  result: Schema.Struct({ enabled: Schema.Boolean }),
  critical: [],
});

/** Stops a session's running suborks: one call's, or all of them. */
export const stopNativeAgentSuborksCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "stop_native_agent_suborks",
  since: 1,
  access: "workspace",
  read: false,
  // `agent` is checked against the platforms with the handler's own message.
  args: Schema.Struct({
    environmentId: Schema.String,
    agent: optionalUnknown,
    logicalSessionKey: Schema.String,
    batchId: optionalString,
  }),
  result: Schema.Null,
  // batchId: ignoring it would stop every call of the session, not the one named.
  critical: ["batchId"],
});

/** One subork's stored transcript. Never touches the provider. */
export const nativeAgentSuborkTranscriptCommand = defineCommand({
  domain: nativeSessionsDomain,
  name: "native_agent_subork_transcript",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Schema.String,
    batchId: Schema.String,
    suborkId: Schema.String,
    fromIndex: optionalUnknown,
  }),
  result: SuborkTranscriptSchema,
  critical: [],
});

export const NATIVE_AGENT_COMMANDS = [
  ensureNativeAgentSessionCommand,
  adoptNativeAgentSessionCommand,
  dispatchNativeAgentPromptCommand,
  dispatchNativeAgentIntentCommand,
  retryNativeAgentDispatchCommand,
  discardNativeAgentDispatchCommand,
  getNativeAgentSessionCommand,
  getNativeAgentProjectionCommand,
  getNativeAgentSignInResendCommand,
  getNativeAgentSyncCapabilitiesCommand,
  getNativeAgentTranscriptUpdateCommand,
  getNativeAgentSessionStateUpdateCommand,
  getNativeAgentLiveUpdateCommand,
  getNativeAgentDiscoveryUpdateCommand,
  getNativeAgentProjectionUpdateCommand,
  getNativeAgentMessagePageCommand,
  getNativeAgentToolDetailsCommand,
  refreshNativeAgentModelsCommand,
  refreshNativeAgentCommandsCommand,
  nativeAgentGoalCommand,
  getNativeAgentGoalCommand,
  stopNativeAgentSessionCommand,
  stopNativeAgentBackgroundTaskCommand,
  dismissNativeAgentSuggestedPromptCommand,
  listNativeAgentResumableSessionsCommand,
  setNativeAgentResumableSessionArchivedCommand,
  resumeNativeAgentSessionCommand,
  forkNativeAgentSessionCommand,
  updateNativeAgentControlsCommand,
  steerNativeAgentQueuedPromptCommand,
  performNativeAgentSessionActionCommand,
  performNativeAgentMcpActionCommand,
  getNativeAgentAuthStatusCommand,
  beginNativeAgentSignInCommand,
  cancelNativeAgentSignInCommand,
  signOutNativeAgentCommand,
  resolveNativeAgentInteractionCommand,
  holdNativeAgentInteractionCommand,
  getAgentInteractionObservationsCommand,
  reconcileAgentInteractionsCommand,
  setAgentInteractionMonitorAdoptionCommand,
  stopNativeAgentSuborksCommand,
  nativeAgentSuborkTranscriptCommand,
] as const;
