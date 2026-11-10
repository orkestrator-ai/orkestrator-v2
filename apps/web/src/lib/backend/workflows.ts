import { coordinatorApi } from "@/lib/node-scope/domains/coordinator";
import { asWebModel, nativeSessions } from "@/lib/node-scope/domains/native-sessions";
import { terminals } from "@/lib/node-scope/domains/terminals";
import { hydrationRequests } from "@/lib/hydration-request-limiter";
import {
  LIST_ENVIRONMENT_HYDRATION_COMMAND,
  isEnvironmentHydrationBatch,
  type EnvironmentHydrationBatch,
} from "@orkestrator/protocol/environment-hydration";
import { hostTimeZone } from "@orkestrator/protocol/schedule-time";
import { terminalWriteWasDelivered } from "@/lib/backend/shared";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  AgentInteractionApplyOutcome,
  AgentInteractionOrigin,
  AgentInteractionPolicy,
  AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import type {
  PersistedWorkflowRecord,
  PersistedNativeAgentSession,
  PersistedComposeDraft,
  PersistedFileDraft,
  PersistedPromptQueue,
} from "@/types";
import type {
  NativeAgentAuthStatus,
  NativeAgentControlUpdate,
  NativeAgentSessionAction,
  NativeAgentSessionActionOutcome,
  NativeAgentSessionBranchList,
  NativeAgentDispatchOutcome,
  NativeAgentForkOutcome,
  NativeAgentResumeEntry,
  NativeAgentSessionProjection,
  NativeAgentToolDetails,
  NativeAgentMessagePage,
  NativeAgentMcpServerAction,
  NativeAgentLiveWindow,
  NativeAgentProjectionUpdate,
  NativeAgentTranscriptUpdate,
  NativeAgentSessionStateUpdate,
  NativeAgentDiscoveryUpdate,
  NativeAgentLiveUpdate,
  NativeAgentDiscoverySection,
  NativeAgentCommandIntent,
  NativeAgentCommandRefreshOutcome,
  NativeAgentModelSubstitution,
} from "@orkestrator/protocol/native-agent";
import type { NativeAgentGoal, NativeAgentGoalView } from "@orkestrator/protocol/native-agent-goal";
import {
  isNativeAgentMessagePage,
  isNativeAgentProjectionUpdate,
  isNativeAgentTranscriptUpdate,
  isNativeAgentSessionStateUpdate,
  isNativeAgentDiscoveryUpdate,
  isNativeAgentLiveUpdate,
  NATIVE_AGENT_SYNC_MAX_PAGE_BYTES,
  NATIVE_AGENT_SYNC_MAX_SNAPSHOT_BYTES,
} from "@orkestrator/protocol/native-agent";
/** PR detection result containing URL, state, and merge conflict status */

import { parseTerminalSessionCreateResult, type TerminalSessionCreateResult } from "./shared";
import { commandBackendClient, type BackendClient } from "./client";
import { createBuildPipelinesApi } from "./build-pipelines";
import { createMultiReviewsApi } from "./multi-reviews";

/**
 * The platform a native-agent command names.
 *
 * Every command in this module took its own inline copy of the same union,
 * which meant adding a platform was twenty edits that had to agree. It is the
 * full platform list — the backend rejects a platform it cannot serve, and
 * doing that here as well would put the same rule in two places.
 */
type NativeAgentClientPlatform = AgentPlatform;

export interface NativeAgentJobLaunchResult {
  jobId: string;
  environmentId: string;
  tabId: string;
  agent: NativeAgentClientPlatform;
  logicalSessionKey: string;
  status: "accepted" | "unknown" | "rejected";
  error?: string;
  completionActionArmed?: boolean;
  warning?: string;
  /** The prompt went to an open tab of the same job instead of a new one. */
  reused?: boolean;
  /** The reused tab was busy, so the prompt waits for its current work to end. */
  queued?: boolean;
}

/** What an explicit command-list refresh did, with the projection it produced. */
export interface NativeAgentCommandRefreshResult<TMessage = unknown> {
  outcome: NativeAgentCommandRefreshOutcome;
  message?: string;
  projection: NativeAgentSessionProjection<TMessage> | null;
}

/** What `/goal` did. A refusal rejects with a message the user can read. */
export interface NativeAgentGoalCommandResult {
  message: string;
  goal?: NativeAgentGoalView;
}

/** A goal with its check output, which the session snapshot leaves out. */
export interface NativeAgentGoalDetail {
  goal?: NativeAgentGoal;
  history: NativeAgentGoal[];
}

/** One subork's stored transcript. Reading it touches no provider. */
export type NativeAgentSuborkTranscript =
  | {
      status: "found";
      messages: unknown[];
      agent?: string;
      startIndex: number;
      messageCount: number;
      truncated?: true;
    }
  | { status: "missing" | "none" | "unavailable" };

// --- Build pipelines and Multi Review: `build-pipelines.ts`, `multi-reviews.ts` ---

export type { ConditionalBuildPipeline } from "./build-pipelines";

// --- Prompt Queues ---

// --- Unsent drafts ---

// --- Local Server Commands (for local/worktree environments) ---

// --- Local Terminal Commands (for local/worktree environments) ---

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createWorkflowsApi(client: BackendClient) {
  // Build pipelines and Multi Review live in their own files (plan item 7007).
  const buildPipelinesApi = createBuildPipelinesApi(client);
  const multiReviewsApi = createMultiReviewsApi(client);
  const native = () => nativeSessions(client);
  // The `terminals` domain client for local terminals (plan item 7002).
  const terminalsDomain = () => terminals(client);

  /**
   * Launch work whose tab is a projection of a backend-owned native session.
   *
   * The command persists the tab and dispatch intent before it returns, so the
   * job never waits for that tab (or even its environment) to be mounted.
   */
  async function launchNativeAgentJob(input: {
    requestId: string;
    environmentId: string;
    /** The id of the tab this launch creates; a reused tab answers with its own. */
    tabId?: string;
    agent: NativeAgentClientPlatform;
    prompt: string;
    title?: string;
    modelId?: string;
    reasoningId?: string;
    fastMode?: boolean;
    conversationMode?: "plan" | "build";
    completionAction?: "refresh-pr-after-agent-completion";
    /**
     * Send to the most recent open tab of the same job when it can take a prompt,
     * and only otherwise open a new one. `same-agent` restricts that to the chosen
     * agent and applies the chosen model; `any-agent` keeps the tab's own.
     */
    tabReuse?: "any-agent" | "same-agent";
    activateTab?: boolean;
  }): Promise<NativeAgentJobLaunchResult> {
    return coordinatorApi(client).launch_native_agent_job(
      input,
    ) as Promise<NativeAgentJobLaunchResult>;
  }

  async function ensureNativeAgentSession(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    origin?: AgentInteractionOrigin;
    interactionPolicy?: AgentInteractionPolicy;
    title?: string;
    model?: string;
    /** Only inherited defaults may be substituted when their provider is disconnected. */
    modelSource?: "default" | "explicit";
    reasoningEffort?: string;
    phase?: "build" | "review" | "verify" | "fix" | "pr" | "resolve-conflicts";
    /**
     * Overrides the mode the phase would imply, for a session whose phase-derived
     * mode does not match what it must do (a review session that has to commit
     * changes would fail in a phase-derived read-only session).
     */
    sessionMode?: "plan" | "build";
    fastMode?: boolean;
    executionProfileId?: string;
    parameterValues?: Record<string, string | boolean>;
  }): Promise<PersistedNativeAgentSession & { modelSubstitution?: NativeAgentModelSubstitution }> {
    return asWebModel<
      PersistedNativeAgentSession & { modelSubstitution?: NativeAgentModelSubstitution }
    >(native().ensure_native_agent_session(input));
  }

  async function adoptNativeAgentSession(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    origin?: AgentInteractionOrigin;
    interactionPolicy?: AgentInteractionPolicy;
    providerSessionId: string;
    expectedProviderSessionId?: string;
    model?: string;
    reasoningEffort?: string;
    sessionMode?: "plan" | "build";
    fastMode?: boolean;
    executionProfileId?: string;
    controls?: NativeAgentControlUpdate;
  }): Promise<PersistedNativeAgentSession> {
    return asWebModel<PersistedNativeAgentSession>(native().adopt_native_agent_session(input));
  }

  async function getNativeAgentProjection<TMessage = unknown>(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    /** Omit to keep the window this session already has; never to shrink it. */
    messageLimit?: number;
    /** Request the provider's detailed billing/quota snapshot. */
    refreshUsage?: boolean;
  }): Promise<NativeAgentSessionProjection<TMessage> | null> {
    return asWebModel(native().get_native_agent_projection(input));
  }

  async function getNativeAgentSyncCapabilities(): Promise<{
    projectionSyncVersions: number[];
    historyPagingVersions: number[];
    progressiveViewVersions?: number[];
    /** Stamped, session-scoped activity announcements (step 07). */
    observationEventVersions?: number[];
    /** Part-level patches inside transcript deltas (efficiency step 14). */
    transcriptPatchVersions?: number[];
    /** One request for transcript and state (`get_native_agent_live_update`). */
    liveUpdateVersions?: number[];
  }> {
    // Folded into native-sessions version 1: such a node answers without a round trip.
    const response = await native().syncCapabilities();
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("Invalid native agent sync capabilities response");
    }
    const candidate = response as Record<string, unknown>;
    if (
      !Array.isArray(candidate.projectionSyncVersions) ||
      candidate.projectionSyncVersions.length > 16 ||
      !candidate.projectionSyncVersions.every(Number.isSafeInteger) ||
      !Array.isArray(candidate.historyPagingVersions) ||
      candidate.historyPagingVersions.length > 16 ||
      !candidate.historyPagingVersions.every(Number.isSafeInteger) ||
      (candidate.progressiveViewVersions !== undefined &&
        (!Array.isArray(candidate.progressiveViewVersions) ||
          candidate.progressiveViewVersions.length > 16 ||
          !candidate.progressiveViewVersions.every(Number.isSafeInteger))) ||
      (candidate.observationEventVersions !== undefined &&
        (!Array.isArray(candidate.observationEventVersions) ||
          candidate.observationEventVersions.length > 16 ||
          !candidate.observationEventVersions.every(Number.isSafeInteger))) ||
      (candidate.transcriptPatchVersions !== undefined &&
        (!Array.isArray(candidate.transcriptPatchVersions) ||
          candidate.transcriptPatchVersions.length > 16 ||
          !candidate.transcriptPatchVersions.every(Number.isSafeInteger))) ||
      (candidate.liveUpdateVersions !== undefined &&
        (!Array.isArray(candidate.liveUpdateVersions) ||
          candidate.liveUpdateVersions.length > 16 ||
          !candidate.liveUpdateVersions.every(Number.isSafeInteger)))
    ) {
      throw new Error("Invalid native agent sync capabilities response");
    }
    return response as {
      projectionSyncVersions: number[];
      historyPagingVersions: number[];
      progressiveViewVersions?: number[];
      observationEventVersions?: number[];
      transcriptPatchVersions?: number[];
      liveUpdateVersions?: number[];
    };
  }

  async function getNativeAgentTranscriptUpdate<TMessage = unknown>(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    viewVersion: 1;
    liveWindow: NativeAgentLiveWindow;
    knownToken?: string;
    forceSnapshot?: boolean;
    /** Ask for part-level patches; only when the backend advertised them. */
    patchVersion?: 2;
  }): Promise<NativeAgentTranscriptUpdate<TMessage>> {
    const response = await native().get_native_agent_transcript_update(input);
    if (
      new TextEncoder().encode(JSON.stringify(response)).byteLength >
      NATIVE_AGENT_SYNC_MAX_SNAPSHOT_BYTES
    ) {
      throw new Error("Native agent transcript update response exceeded 20 MiB");
    }
    if (!isNativeAgentTranscriptUpdate(response)) {
      throw new Error("Invalid native agent transcript update response");
    }
    return response as NativeAgentTranscriptUpdate<TMessage>;
  }

  async function getNativeAgentSessionStateUpdate(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    viewVersion: 1;
    knownToken?: string;
    forceSnapshot?: boolean;
  }): Promise<NativeAgentSessionStateUpdate> {
    const response = await native().get_native_agent_session_state_update(input);
    if (!isNativeAgentSessionStateUpdate(response)) {
      throw new Error("Invalid native agent session-state update response");
    }
    return response;
  }

  async function getNativeAgentLiveUpdate<TMessage = unknown>(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    viewVersion: 1;
    liveWindow: NativeAgentLiveWindow;
    transcriptToken?: string;
    stateToken?: string;
    /** Ask for part-level patches; only when the backend advertised them. */
    patchVersion?: 2;
  }): Promise<NativeAgentLiveUpdate<TMessage>> {
    const response = await native().get_native_agent_live_update(input);
    if (
      new TextEncoder().encode(JSON.stringify(response)).byteLength >
      NATIVE_AGENT_SYNC_MAX_SNAPSHOT_BYTES
    ) {
      throw new Error("Native agent live update response exceeded 20 MiB");
    }
    if (!isNativeAgentLiveUpdate(response)) {
      throw new Error("Invalid native agent live update response");
    }
    return response as NativeAgentLiveUpdate<TMessage>;
  }

  async function getNativeAgentDiscoveryUpdate(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    viewVersion: 1;
    sections: NativeAgentDiscoverySection[];
    knownToken?: string;
    forceSnapshot?: boolean;
  }): Promise<NativeAgentDiscoveryUpdate> {
    const response = await native().get_native_agent_discovery_update(input);
    if (!isNativeAgentDiscoveryUpdate(response)) {
      throw new Error("Invalid native agent discovery update response");
    }
    return response;
  }

  async function getNativeAgentProjectionUpdate<TMessage = unknown>(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    syncVersion: 1;
    liveWindow: NativeAgentLiveWindow;
    knownToken?: string;
    forceSnapshot?: boolean;
  }): Promise<NativeAgentProjectionUpdate<TMessage>> {
    const response = await native().get_native_agent_projection_update(input);
    if (
      new TextEncoder().encode(JSON.stringify(response)).byteLength >
      NATIVE_AGENT_SYNC_MAX_SNAPSHOT_BYTES
    ) {
      throw new Error("Native agent projection update response exceeded 20 MiB");
    }
    if (!isNativeAgentProjectionUpdate(response)) {
      throw new Error("Invalid native agent projection update response");
    }
    return response as NativeAgentProjectionUpdate<TMessage>;
  }

  async function getNativeAgentMessagePage<TMessage = unknown>(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    syncVersion: 1;
    before: string;
    limit?: number;
    targetBytes?: number;
  }): Promise<NativeAgentMessagePage<TMessage>> {
    const response = await native().get_native_agent_message_page(input);
    if (
      new TextEncoder().encode(JSON.stringify(response)).byteLength >
      NATIVE_AGENT_SYNC_MAX_PAGE_BYTES
    ) {
      throw new Error("Native agent message page response exceeded its limit");
    }
    if (!isNativeAgentMessagePage(response)) {
      throw new Error("Invalid native agent message page response");
    }
    return response as NativeAgentMessagePage<TMessage>;
  }

  async function getNativeAgentToolDetails(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    detailRef: string;
  }): Promise<NativeAgentToolDetails> {
    return asWebModel(native().get_native_agent_tool_details(input));
  }

  async function refreshNativeAgentModels<TMessage = unknown>(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
  }): Promise<NativeAgentSessionProjection<TMessage> | null> {
    return asWebModel(native().refresh_native_agent_models(input));
  }

  async function refreshNativeAgentCommands<TMessage = unknown>(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
  }): Promise<NativeAgentCommandRefreshResult<TMessage>> {
    return asWebModel(native().refresh_native_agent_commands(input));
  }

  async function stopNativeAgentSession<TMessage = unknown>(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
  }): Promise<NativeAgentSessionProjection<TMessage> | null> {
    return asWebModel(native().stop_native_agent_session(input));
  }

  /**
   * Run `/goal` now, whether or not a turn is running. `text` is what follows the
   * command name; it never goes through the prompt queue.
   */
  async function runNativeAgentGoalCommand(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    text: string;
    model?: string;
  }): Promise<NativeAgentGoalCommandResult> {
    return asWebModel(native().native_agent_goal_command(input));
  }

  async function getNativeAgentGoal(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
  }): Promise<NativeAgentGoalDetail> {
    return asWebModel(native().get_native_agent_goal(input));
  }

  /** Stops a session's running suborks: one call's, or every call's when `batchId` is absent. */
  async function stopNativeAgentSuborks(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    batchId?: string;
  }): Promise<void> {
    await native().stop_native_agent_suborks(input);
  }

  async function getNativeAgentSuborkTranscript(input: {
    environmentId: string;
    batchId: string;
    suborkId: string;
    fromIndex?: number;
  }): Promise<NativeAgentSuborkTranscript> {
    return asWebModel(native().native_agent_subork_transcript(input));
  }

  async function stopNativeAgentBackgroundTask<TMessage = unknown>(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    taskId: string;
  }): Promise<NativeAgentSessionProjection<TMessage> | null> {
    return asWebModel(native().stop_native_agent_background_task(input));
  }

  async function dismissNativeAgentSuggestedPrompt<TMessage = unknown>(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
  }): Promise<NativeAgentSessionProjection<TMessage> | null> {
    return asWebModel(native().dismiss_native_agent_suggested_prompt(input));
  }

  async function listNativeAgentResumableSessions(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    /** Also lists conversations taken out of the list, flagged `archived`. */
    includeArchived?: boolean;
  }): Promise<NativeAgentResumeEntry[]> {
    return asWebModel(native().list_native_agent_resumable_sessions(input));
  }

  /** Takes a conversation out of the resume list, or puts it back. Never a delete. */
  async function setNativeAgentResumableSessionArchived(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    resumableSessionId: string;
    archived: boolean;
  }): Promise<{ archived: boolean }> {
    return native().set_native_agent_resumable_session_archived(input);
  }

  async function resumeNativeAgentSession<TMessage = unknown>(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    providerSessionId: string;
    controls?: NativeAgentControlUpdate;
  }): Promise<NativeAgentSessionProjection<TMessage> | null> {
    return asWebModel(native().resume_native_agent_session(input));
  }

  async function forkNativeAgentSession(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    messageId?: string;
  }): Promise<NativeAgentForkOutcome> {
    return asWebModel(native().fork_native_agent_session(input));
  }

  async function updateNativeAgentControls<TMessage = unknown>(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    update: NativeAgentControlUpdate;
  }): Promise<NativeAgentSessionProjection<TMessage> | null> {
    return asWebModel(native().update_native_agent_controls(input));
  }

  async function steerNativeAgentQueuedPrompt(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    messageId: string;
  }): Promise<NativeAgentSessionActionOutcome | null> {
    return asWebModel(native().steer_native_agent_queued_prompt(input));
  }

  async function performNativeAgentSessionAction(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    action: NativeAgentSessionAction;
  }): Promise<NativeAgentSessionActionOutcome> {
    return asWebModel(native().perform_native_agent_session_action(input));
  }

  /**
   * The conversation's branches other than the active one (Pi only), by the
   * entry ids a `switch-branch` action takes. Read when a picker opens.
   */
  async function listNativeAgentBranches(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
  }): Promise<NativeAgentSessionBranchList> {
    return asWebModel(native().list_native_agent_branches(input));
  }

  async function performNativeAgentMcpAction(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    serverId: string;
    action: NativeAgentMcpServerAction;
  }): Promise<{ url?: string }> {
    return native().perform_native_agent_mcp_action(input);
  }

  /**
   * Read the provider's account now. Not part of the projection: an account read
   * can reach the provider's auth service, so ask only when the answer is shown.
   */
  async function getNativeAgentAuthStatus(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
  }): Promise<NativeAgentAuthStatus | null> {
    return asWebModel(native().get_native_agent_auth_status(input));
  }

  async function beginNativeAgentSignIn(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    /** Ask for a device code: the browser cannot reach the agent's loopback. */
    deviceCode?: boolean;
  }): Promise<{ url?: string; code?: string }> {
    return native().begin_native_agent_sign_in(input);
  }

  /** Abandon an in-tab sign-in so the provider stops waiting for it. */
  async function cancelNativeAgentSignIn(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
  }): Promise<{ cancelled: boolean }> {
    return native().cancel_native_agent_sign_in(input);
  }

  async function signOutNativeAgent(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
  }): Promise<void> {
    await native().sign_out_native_agent(input);
  }

  async function resolveNativeAgentInteraction(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    interactionId: string;
    resolution: AgentInteractionResolution;
  }): Promise<AgentInteractionApplyOutcome> {
    return asWebModel(native().resolve_native_agent_interaction(input));
  }

  /** Pause (`held`) or resume an interaction's countdown where the agent enforces it. */
  async function holdNativeAgentInteraction(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    interactionId: string;
    held: boolean;
  }): Promise<AgentInteractionApplyOutcome> {
    return asWebModel(native().hold_native_agent_interaction(input));
  }

  async function dispatchNativeAgentIntent(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    origin?: AgentInteractionOrigin;
    interactionPolicy?: AgentInteractionPolicy;
    title?: string;
    model?: string;
    modelSource?: "default" | "explicit";
    reasoningEffort?: string;
    phase?: "build" | "review" | "verify" | "fix" | "pr" | "resolve-conflicts";
    prompt: string;
    requestId: string;
    images?: Array<{ filename: string; data: string }>;
    attachments?: Array<{
      type: "image" | "file";
      path: string;
      dataUrl?: string;
      filename?: string;
    }>;
    schema?: Record<string, unknown>;
    mode?: "plan" | "build";
    fastMode?: boolean;
    subAgent?: string;
    executionAgent?: string;
    includeLocalSettings?: boolean;
    promptSuggestions?: boolean;
    sessionMode?: "plan" | "build";
    executionProfileId?: string;
    parameterValues?: Record<string, string | boolean>;
    /** Approval mode for a session this dispatch creates. */
    approvalMode?: string;
    /**
     * How to interpret the prompt. Absent is legacy behaviour (typed). For a
     * non-literal intent the backend keeps the prompt bytes, trimming only
     * leading whitespace, so a command's arguments arrive exactly as typed.
     */
    command?: NativeAgentCommandIntent;
    /** Defaults to this device's zone; a coordinator reads its user's zone from it. */
    clientTimeZone?: string;
  }): Promise<NativeAgentDispatchOutcome> {
    return asWebModel<NativeAgentDispatchOutcome>(
      native().dispatch_native_agent_intent({
        ...input,
        clientTimeZone: input.clientTimeZone ?? hostTimeZone(),
      }),
    );
  }

  async function retryNativeAgentDispatch(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    requestId: string;
  }): Promise<NativeAgentDispatchOutcome> {
    return asWebModel<NativeAgentDispatchOutcome>(native().retry_native_agent_dispatch(input));
  }

  async function discardNativeAgentDispatch(input: {
    environmentId: string;
    agent: NativeAgentClientPlatform;
    logicalSessionKey: string;
    requestId: string;
  }): Promise<{ discarded: boolean }> {
    return native().discard_native_agent_dispatch(input);
  }

  async function getPromptQueue<T = unknown>(
    queueKey: string,
  ): Promise<PersistedPromptQueue<T> | null> {
    return asWebModel<PersistedPromptQueue<T> | null>(native().get_prompt_queue({ queueKey }));
  }

  async function listPromptQueues<T = unknown>(
    environmentId: string,
  ): Promise<Array<PersistedPromptQueue<T>>> {
    return hydrationRequests.run(() =>
      asWebModel<Array<PersistedPromptQueue<T>>>(native().list_prompt_queues({ environmentId })),
    );
  }

  /**
   * Prompt queues and Multi Review workflows for up to
   * `MAX_ENVIRONMENT_HYDRATION_IDS` environments in one bounded request. A
   * backend before this command rejects it as unknown; callers fall back to the
   * per-environment reads (`boot-hydration.ts`).
   */
  async function listEnvironmentHydration(
    environmentIds: string[],
  ): Promise<EnvironmentHydrationBatch<PersistedPromptQueue, PersistedWorkflowRecord<unknown>>> {
    const response = await hydrationRequests.run(() =>
      native().list_environment_hydration({ environmentIds }),
    );
    if (!isEnvironmentHydrationBatch(response)) {
      throw new Error(`Invalid ${LIST_ENVIRONMENT_HYDRATION_COMMAND} response`);
    }
    return response as EnvironmentHydrationBatch<
      PersistedPromptQueue,
      PersistedWorkflowRecord<unknown>
    >;
  }

  async function enqueuePromptQueueMessage<T>(
    queueKey: string,
    environmentId: string,
    message: T,
  ): Promise<PersistedPromptQueue<T>> {
    return asWebModel<PersistedPromptQueue<T>>(
      native().enqueue_prompt_queue_message({
        queueKey,
        environmentId,
        message,
      }),
    );
  }

  async function removePromptQueueMessage<T>(
    queueKey: string,
    environmentId: string,
    messageId: string,
  ): Promise<{
    removed: T | null;
    queue: PersistedPromptQueue<T> | null;
  }> {
    return asWebModel(
      native().remove_prompt_queue_message({
        queueKey,
        environmentId,
        messageId,
      }),
    );
  }

  async function movePromptQueueMessage<T>(
    queueKey: string,
    environmentId: string,
    messageId: string,
    direction: "up" | "down",
  ): Promise<PersistedPromptQueue<T> | null> {
    return asWebModel<PersistedPromptQueue<T> | null>(
      native().move_prompt_queue_message({
        queueKey,
        environmentId,
        messageId,
        direction,
      }),
    );
  }

  async function retryPromptQueueDispatch<T = unknown>(
    queueKey: string,
  ): Promise<PersistedPromptQueue<T> | null> {
    return asWebModel<PersistedPromptQueue<T> | null>(
      native().retry_prompt_queue_dispatch({ queueKey }),
    );
  }

  async function getComposeDraft<T = unknown>(
    draftKey: string,
  ): Promise<PersistedComposeDraft<T> | null> {
    return asWebModel<PersistedComposeDraft<T> | null>(native().get_compose_draft({ draftKey }));
  }

  async function saveComposeDraft<T>(
    draftKey: string,
    ownerType: "environment" | "project",
    ownerId: string,
    value: T,
    expectedRevision?: number,
  ): Promise<PersistedComposeDraft<T>> {
    return asWebModel<PersistedComposeDraft<T>>(
      native().save_compose_draft({
        draftKey,
        ownerType,
        ownerId,
        value,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
    );
  }

  async function deleteComposeDraft(draftKey: string, expectedRevision?: number): Promise<void> {
    return native().delete_compose_draft({
      draftKey,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
  }

  async function getFileDraft(draftKey: string): Promise<PersistedFileDraft | null> {
    return asWebModel<PersistedFileDraft | null>(native().get_file_draft({ draftKey }));
  }

  async function saveFileDraft(
    draftKey: string,
    environmentId: string,
    filePath: string,
    content: string,
    originalContent: string,
    expectedRevision?: number,
  ): Promise<PersistedFileDraft> {
    return asWebModel<PersistedFileDraft>(
      native().save_file_draft({
        draftKey,
        environmentId,
        filePath,
        content,
        originalContent,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
    );
  }

  async function deleteFileDraft(draftKey: string, expectedRevision?: number): Promise<void> {
    return native().delete_file_draft({
      draftKey,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
  }

  /** Create a local terminal session for a local environment */
  async function createLocalTerminalSession(
    environmentId: string,
    cols: number,
    rows: number,
    trackEnvironmentActivity = false,
    terminalKey?: string,
  ): Promise<TerminalSessionCreateResult> {
    const result = await terminalsDomain().create_local_terminal_session({
      environmentId,
      cols,
      rows,
      trackEnvironmentActivity,
      terminalKey,
    });
    return parseTerminalSessionCreateResult(result);
  }

  /** Start a local terminal session and begin forwarding output */
  async function startLocalTerminalSession(sessionId: string): Promise<void> {
    await terminalsDomain().start_local_terminal_session({ sessionId });
  }

  /**
   * Write data to a local terminal session. Resolves to whether the backend
   * actually reached a live PTY; see `terminalWriteWasDelivered`.
   */
  async function writeLocalTerminal(sessionId: string, data: string): Promise<boolean> {
    return terminalWriteWasDelivered(
      await terminalsDomain().local_terminal_write({ sessionId, data }),
    );
  }

  /** Resize a local terminal session */
  async function resizeLocalTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
    await terminalsDomain().local_terminal_resize({ sessionId, cols, rows });
  }

  /** Close a local terminal session */
  async function closeLocalTerminalSession(sessionId: string): Promise<void> {
    await terminalsDomain().close_local_terminal_session({ sessionId });
  }

  return {
    ...buildPipelinesApi,
    ...multiReviewsApi,
    launchNativeAgentJob,
    ensureNativeAgentSession,
    adoptNativeAgentSession,
    getNativeAgentProjection,
    getNativeAgentSyncCapabilities,
    getNativeAgentTranscriptUpdate,
    getNativeAgentSessionStateUpdate,
    getNativeAgentLiveUpdate,
    getNativeAgentDiscoveryUpdate,
    getNativeAgentProjectionUpdate,
    getNativeAgentMessagePage,
    getNativeAgentToolDetails,
    refreshNativeAgentModels,
    refreshNativeAgentCommands,
    stopNativeAgentSession,
    runNativeAgentGoalCommand,
    getNativeAgentGoal,
    stopNativeAgentSuborks,
    getNativeAgentSuborkTranscript,
    stopNativeAgentBackgroundTask,
    dismissNativeAgentSuggestedPrompt,
    listNativeAgentResumableSessions,
    setNativeAgentResumableSessionArchived,
    resumeNativeAgentSession,
    forkNativeAgentSession,
    updateNativeAgentControls,
    steerNativeAgentQueuedPrompt,
    performNativeAgentSessionAction,
    listNativeAgentBranches,
    performNativeAgentMcpAction,
    getNativeAgentAuthStatus,
    beginNativeAgentSignIn,
    cancelNativeAgentSignIn,
    signOutNativeAgent,
    resolveNativeAgentInteraction,
    holdNativeAgentInteraction,
    dispatchNativeAgentIntent,
    retryNativeAgentDispatch,
    discardNativeAgentDispatch,
    getPromptQueue,
    listPromptQueues,
    listEnvironmentHydration,
    enqueuePromptQueueMessage,
    removePromptQueueMessage,
    movePromptQueueMessage,
    retryPromptQueueDispatch,
    getComposeDraft,
    saveComposeDraft,
    deleteComposeDraft,
    getFileDraft,
    saveFileDraft,
    deleteFileDraft,
    createLocalTerminalSession,
    startLocalTerminalSession,
    writeLocalTerminal,
    resizeLocalTerminal,
    closeLocalTerminalSession,
  };
}

export type WorkflowsApi = ReturnType<typeof createWorkflowsApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  launchNativeAgentJob,
  ensureNativeAgentSession,
  adoptNativeAgentSession,
  getNativeAgentProjection,
  getNativeAgentSyncCapabilities,
  getNativeAgentTranscriptUpdate,
  getNativeAgentSessionStateUpdate,
  getNativeAgentLiveUpdate,
  getNativeAgentDiscoveryUpdate,
  getNativeAgentProjectionUpdate,
  getNativeAgentMessagePage,
  getNativeAgentToolDetails,
  refreshNativeAgentModels,
  refreshNativeAgentCommands,
  stopNativeAgentSession,
  runNativeAgentGoalCommand,
  getNativeAgentGoal,
  stopNativeAgentSuborks,
  getNativeAgentSuborkTranscript,
  stopNativeAgentBackgroundTask,
  dismissNativeAgentSuggestedPrompt,
  listNativeAgentResumableSessions,
  setNativeAgentResumableSessionArchived,
  resumeNativeAgentSession,
  forkNativeAgentSession,
  updateNativeAgentControls,
  steerNativeAgentQueuedPrompt,
  performNativeAgentSessionAction,
  listNativeAgentBranches,
  performNativeAgentMcpAction,
  getNativeAgentAuthStatus,
  beginNativeAgentSignIn,
  cancelNativeAgentSignIn,
  signOutNativeAgent,
  resolveNativeAgentInteraction,
  holdNativeAgentInteraction,
  dispatchNativeAgentIntent,
  retryNativeAgentDispatch,
  discardNativeAgentDispatch,
  getPromptQueue,
  listPromptQueues,
  listEnvironmentHydration,
  enqueuePromptQueueMessage,
  removePromptQueueMessage,
  movePromptQueueMessage,
  retryPromptQueueDispatch,
  getComposeDraft,
  saveComposeDraft,
  deleteComposeDraft,
  getFileDraft,
  saveFileDraft,
  deleteFileDraft,
  createLocalTerminalSession,
  startLocalTerminalSession,
  writeLocalTerminal,
  resizeLocalTerminal,
  closeLocalTerminalSession,
} = createWorkflowsApi(commandBackendClient);

/** The split files' command-scope bindings, exported here as before (plan item 7007). */
export {
  startBuildPipeline,
  createFeatureBuild,
  pauseBuildPipeline,
  resumeBuildPipeline,
  cancelBuildPipeline,
  sendBuildPipelineMessage,
  steerBuildPipeline,
  steerQueuedBuildPipelineMessage,
  removeQueuedBuildPipelineMessage,
  restartBuildPipelineCurrentStep,
  retryBuildPipelineStage,
  retryBuildPipelineReviewer,
  restartBuildPipelineReviewer,
  stopBuildPipelineReviewer,
  restartBuildPipelineStep,
  previewBuildPipelineCodeRewind,
  rewindBuildPipelineCode,
  skipBuildPipelineStep,
  retryBuildPipelineInteractionFailure,
  retryBuildPipelineCompletionComment,
  importLegacyBuildPipelines,
  getBuildPipeline,
  getBuildPipelineSessionProjection,
  getBuildPipelineConditional,
  getBuildPipelineControl,
  listBuildPipelines,
  listBuildPipelinesConditional,
  deleteBuildPipeline,
  clearTaskBuildStatus,
  setEnvironmentUnread,
  autoPipelineSources,
  draftAutoPipeline,
  cancelAutoPipelineDraft,
  confirmAutoPipeline,
} from "./build-pipelines";
export {
  getReviewValidationOutput,
  stopReviewValidationCommand,
  startMultiReview,
  addressMultiReviewFindings,
  startMultiReviewCustomAddressFindings,
  retryMultiReview,
  recoverMultiReviewAddressFindingsSession,
  cancelMultiReview,
  stopMultiReviewReviewer,
  stopMultiReviewValidation,
  restartMultiReviewReviewer,
  skipMultiReviewStep,
  previewMultiReviewCodeRewind,
  rewindMultiReviewCode,
  restartMultiReviewStep,
  pauseMultiReviewStep,
  resumeMultiReviewStep,
  unstickMultiReviewReviewer,
  getMultiReviewWorkflow,
  getMultiReviewWorkflowConditional,
  listMultiReviewWorkflows,
  getMultiReviewReviewerTranscript,
  getMultiReviewStepTranscript,
  getMultiReviewStepToolDetails,
  getMultiReviewReviewerToolDetails,
  getMultiReviewReviewerHistoryPage,
  deleteMultiReviewWorkflow,
  getMultiReviewReviewerProjection,
} from "./multi-reviews";
