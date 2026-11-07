import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { withAsyncArgumentFailures } from "./commands-registry-async-args.js";
import {
  adoptNativeAgentSessionCommand,
  beginNativeAgentSignInCommand,
  cancelNativeAgentSignInCommand,
  discardNativeAgentDispatchCommand,
  dismissNativeAgentSuggestedPromptCommand,
  dispatchNativeAgentIntentCommand,
  dispatchNativeAgentPromptCommand,
  ensureNativeAgentSessionCommand,
  forkNativeAgentSessionCommand,
  getAgentInteractionObservationsCommand,
  getNativeAgentAuthStatusCommand,
  getNativeAgentDiscoveryUpdateCommand,
  getNativeAgentGoalCommand,
  getNativeAgentLiveUpdateCommand,
  getNativeAgentMessagePageCommand,
  getNativeAgentProjectionCommand,
  getNativeAgentProjectionUpdateCommand,
  getNativeAgentSessionCommand,
  getNativeAgentSessionStateUpdateCommand,
  getNativeAgentSignInResendCommand,
  getNativeAgentSyncCapabilitiesCommand,
  getNativeAgentToolDetailsCommand,
  getNativeAgentTranscriptUpdateCommand,
  holdNativeAgentInteractionCommand,
  listNativeAgentResumableSessionsCommand,
  nativeAgentGoalCommand,
  performNativeAgentMcpActionCommand,
  performNativeAgentSessionActionCommand,
  reconcileAgentInteractionsCommand,
  refreshNativeAgentCommandsCommand,
  refreshNativeAgentModelsCommand,
  resolveNativeAgentInteractionCommand,
  resumeNativeAgentSessionCommand,
  retryNativeAgentDispatchCommand,
  setAgentInteractionMonitorAdoptionCommand,
  setNativeAgentResumableSessionArchivedCommand,
  signOutNativeAgentCommand,
  steerNativeAgentQueuedPromptCommand,
  stopNativeAgentBackgroundTaskCommand,
  stopNativeAgentSessionCommand,
  updateNativeAgentControlsCommand,
} from "@orkestrator/protocol/contract/domains/native-sessions";
import {
  NATIVE_AGENT_DISCOVERY_SECTIONS,
  NATIVE_AGENT_LIVE_UPDATE_VERSION,
} from "@orkestrator/protocol/native-agent";
import { NATIVE_AGENT_OBSERVATION_EVENT_VERSION } from "@orkestrator/protocol/native-agent-observation";
import { NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION } from "@orkestrator/protocol/native-agent-transcript-patch";
import { BUILD_PIPELINE_AGENTS } from "@orkestrator/protocol/build-pipeline";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { resetAgentMailBudget } from "./commands-registry-mail.js";
import { markSpliceableResult } from "./native-agent-projection-encoding.js";
import {
  asString,
  asRecord,
  asOptionalAgentInteractionOrigin,
  asOptionalAgentInteractionPolicy,
  asRequiredBoolean,
  asPositiveInteger,
  asNonBlankString,
  asBoundedNonBlankString,
  MAX_EXECUTION_PROFILE_ID_LENGTH,
  asDispatchNativeAgentPromptInput,
  asNativeAgentControlUpdate,
  asNativeAgentParameterValues,
  asNativeAgentSessionAction,
} from "./commands-helpers.js";

function assertNativeAgentLiveWindow(liveWindow: unknown): void {
  if (
    !liveWindow ||
    typeof liveWindow !== "object" ||
    Array.isArray(liveWindow) ||
    (liveWindow as { messages?: unknown }).messages !== 100 ||
    (liveWindow as { targetBytes?: unknown }).targetBytes !== 512 * 1024
  ) {
    throw new Error("Native agent live window is unsupported");
  }
}

export function registerNativeAgentCommands(
  registerCommand: CommandRegistrar,
  _dependencies: RegistryDependencies,
): void {
  // `async` handlers keep rejecting on bad arguments (`commands-registry-async-args.ts`).
  const register = withAsyncArgumentFailures(registerCommand);
  register(ensureNativeAgentSessionCommand, async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    return context.nativeAgents.ensureSession({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      origin: asOptionalAgentInteractionOrigin(args.origin),
      interactionPolicy: asOptionalAgentInteractionPolicy(args.interactionPolicy),
      title: typeof args.title === "string" ? args.title : undefined,
      model: typeof args.model === "string" ? args.model : undefined,
      ...(args.modelSource === "default" ? { modelSource: "default" as const } : {}),
      reasoningEffort: typeof args.reasoningEffort === "string" ? args.reasoningEffort : undefined,
      phase:
        typeof args.phase === "string"
          ? (args.phase as import("@orkestrator/protocol/build-pipeline").PipelineSessionPhase)
          : undefined,
      // Only an explicit mode overrides the phase-derived default, so a caller
      // that does not care keeps the existing behaviour.
      sessionMode:
        args.sessionMode === "plan" || args.sessionMode === "build" ? args.sessionMode : undefined,
      fastMode: typeof args.fastMode === "boolean" ? args.fastMode : undefined,
      executionProfileId:
        args.executionProfileId === undefined
          ? undefined
          : asBoundedNonBlankString(
              args.executionProfileId,
              "executionProfileId",
              MAX_EXECUTION_PROFILE_ID_LENGTH,
            ),
      parameterValues:
        args.parameterValues === undefined
          ? undefined
          : asNativeAgentParameterValues(args.parameterValues),
    });
  });

  register(adoptNativeAgentSessionCommand, async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    return context.nativeAgents.adoptSession({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      origin: asOptionalAgentInteractionOrigin(args.origin),
      interactionPolicy: asOptionalAgentInteractionPolicy(args.interactionPolicy),
      providerSessionId: asNonBlankString(args.providerSessionId, "providerSessionId"),
      expectedProviderSessionId:
        args.expectedProviderSessionId === undefined
          ? undefined
          : asNonBlankString(args.expectedProviderSessionId, "expectedProviderSessionId"),
      title: typeof args.title === "string" ? args.title : undefined,
      ...(args.controls === undefined
        ? {}
        : { controls: asNativeAgentControlUpdate(args.controls, "controls") }),
      model: typeof args.model === "string" ? args.model : undefined,
      reasoningEffort: typeof args.reasoningEffort === "string" ? args.reasoningEffort : undefined,
      phase:
        typeof args.phase === "string"
          ? (args.phase as import("@orkestrator/protocol/build-pipeline").PipelineSessionPhase)
          : undefined,
      ...(args.sessionMode === "plan" || args.sessionMode === "build"
        ? { sessionMode: args.sessionMode }
        : {}),
      ...(typeof args.fastMode === "boolean" ? { fastMode: args.fastMode } : {}),
      ...(args.executionProfileId === undefined
        ? {}
        : {
            executionProfileId: asBoundedNonBlankString(
              args.executionProfileId,
              "executionProfileId",
              MAX_EXECUTION_PROFILE_ID_LENGTH,
            ),
          }),
    });
  });

  register(dispatchNativeAgentPromptCommand, async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    const input = asDispatchNativeAgentPromptInput(args);
    await resetAgentMailBudget(context, input.environmentId, input.logicalSessionKey);
    return context.nativeAgents.dispatchPrompt(input);
  });

  register(dispatchNativeAgentIntentCommand, async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    const input = asDispatchNativeAgentPromptInput(args);
    await resetAgentMailBudget(context, input.environmentId, input.logicalSessionKey);
    return context.nativeAgents.dispatchIntent(input);
  });

  register(retryNativeAgentDispatchCommand, async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    return context.nativeAgents.retryRecoverableDispatch({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      requestId: asNonBlankString(args.requestId, "requestId"),
    });
  });

  register(discardNativeAgentDispatchCommand, async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    return context.nativeAgents.discardRecoverableDispatch({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      requestId: asNonBlankString(args.requestId, "requestId"),
    });
  });

  register(getNativeAgentSessionCommand, async (args, context) => {
    const environmentId = asNonBlankString(args.environmentId, "environmentId");
    const agent = asString(args.agent, "agent") as import("./models.js").NativeAgentProvider;
    const logicalSessionKey = asNonBlankString(args.logicalSessionKey, "logicalSessionKey");
    if (!BUILD_PIPELINE_AGENTS.includes(agent)) {
      throw new Error("Native agent provider is invalid");
    }
    const session = await context.storage.getNativeAgentSession(
      nativeAgentSessionStorageKey(environmentId, agent, logicalSessionKey),
    );
    if (
      session &&
      (session.environmentId !== environmentId ||
        session.agent !== agent ||
        session.logicalSessionKey !== logicalSessionKey)
    ) {
      throw new Error("Native agent session identity mismatch");
    }
    return session;
  });

  register(getNativeAgentProjectionCommand, async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    return context.nativeAgents.getProjection({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      messageLimit:
        args.messageLimit === undefined
          ? undefined
          : asPositiveInteger(args.messageLimit, "messageLimit"),
      refreshUsage:
        args.refreshUsage === undefined
          ? undefined
          : asRequiredBoolean(args.refreshUsage, "refreshUsage"),
    });
  });

  // Whether this tab's refused prompt goes out again after a sign-in; the
  // renderer's sign-in card says so only when it will.
  register(getNativeAgentSignInResendCommand, async (args, context) => {
    if (!context.nativeAgents) return { pending: false };
    return context.nativeAgents.signInResends.status({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
    });
  });

  register(getNativeAgentSyncCapabilitiesCommand, (_args, context) => ({
    projectionSyncVersions: [1],
    historyPagingVersions: [1],
    progressiveViewVersions: [1],
    // Additive (step 07): activity announcements name their session and carry
    // the observer's stamp; `observation` anchors a client's gap detection.
    observationEventVersions: [NATIVE_AGENT_OBSERVATION_EVENT_VERSION],
    // Part-level message patches inside transcript deltas (efficiency step 14).
    transcriptPatchVersions: [NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION],
    // One request for transcript and state (`get_native_agent_live_update`).
    liveUpdateVersions: [NATIVE_AGENT_LIVE_UPDATE_VERSION],
    ...(context.nativeAgents
      ? { observation: context.nativeAgents.observationStatus().stamp }
      : {}),
  }));

  register(getNativeAgentTranscriptUpdateCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    if (args.viewVersion !== 1) throw new Error("Native agent progressive view is unsupported");
    assertNativeAgentLiveWindow(args.liveWindow);
    return markSpliceableResult(
      await context.nativeAgents.getTranscriptUpdate({
        environmentId: asNonBlankString(args.environmentId, "environmentId"),
        agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
        logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
        viewVersion: 1,
        liveWindow: { messages: 100, targetBytes: 512 * 1024 },
        knownToken:
          args.knownToken === undefined
            ? undefined
            : asBoundedNonBlankString(args.knownToken, "knownToken", 1024),
        forceSnapshot:
          args.forceSnapshot === undefined
            ? undefined
            : asRequiredBoolean(args.forceSnapshot, "forceSnapshot"),
        // Any other value is a client this backend does not know how to answer
        // with patches; it keeps whole-message deltas.
        ...(args.patchVersion === NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION
          ? { patchVersion: NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION }
          : {}),
      }),
    );
  });

  register(getNativeAgentSessionStateUpdateCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    if (args.viewVersion !== 1) throw new Error("Native agent progressive view is unsupported");
    return context.nativeAgents.getSessionStateUpdate({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      viewVersion: 1,
      knownToken:
        args.knownToken === undefined
          ? undefined
          : asBoundedNonBlankString(args.knownToken, "knownToken", 1024),
      forceSnapshot:
        args.forceSnapshot === undefined
          ? undefined
          : asRequiredBoolean(args.forceSnapshot, "forceSnapshot"),
    });
  });

  register(getNativeAgentLiveUpdateCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    if (args.viewVersion !== NATIVE_AGENT_LIVE_UPDATE_VERSION) {
      throw new Error("Native agent live update is unsupported");
    }
    assertNativeAgentLiveWindow(args.liveWindow);
    return markSpliceableResult(
      await context.nativeAgents.getLiveUpdate({
        environmentId: asNonBlankString(args.environmentId, "environmentId"),
        agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
        logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
        viewVersion: NATIVE_AGENT_LIVE_UPDATE_VERSION,
        liveWindow: { messages: 100, targetBytes: 512 * 1024 },
        transcriptToken:
          args.transcriptToken === undefined
            ? undefined
            : asBoundedNonBlankString(args.transcriptToken, "transcriptToken", 1024),
        stateToken:
          args.stateToken === undefined
            ? undefined
            : asBoundedNonBlankString(args.stateToken, "stateToken", 1024),
        // As on the transcript command: any other value keeps whole-message deltas.
        ...(args.patchVersion === NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION
          ? { patchVersion: NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION }
          : {}),
      }),
    );
  });

  register(getNativeAgentDiscoveryUpdateCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    if (args.viewVersion !== 1) throw new Error("Native agent progressive view is unsupported");
    if (
      !Array.isArray(args.sections) ||
      args.sections.length === 0 ||
      args.sections.length > NATIVE_AGENT_DISCOVERY_SECTIONS.length + 1 ||
      args.sections.some(
        (section) =>
          typeof section !== "string" ||
          (section !== "auth" && !NATIVE_AGENT_DISCOVERY_SECTIONS.includes(section as never)),
      )
    ) {
      throw new Error("Native agent discovery sections are invalid");
    }
    return context.nativeAgents.getDiscoveryUpdate({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      viewVersion: 1,
      sections: [
        // Older open renderers still ask for auth. Accept it without restoring
        // account reads to progressive discovery.
        ...new Set(args.sections.filter((section) => section !== "auth")),
      ] as import("@orkestrator/protocol/native-agent").NativeAgentDiscoverySection[],
      knownToken:
        args.knownToken === undefined
          ? undefined
          : asBoundedNonBlankString(args.knownToken, "knownToken", 1024),
      forceSnapshot:
        args.forceSnapshot === undefined
          ? undefined
          : asRequiredBoolean(args.forceSnapshot, "forceSnapshot"),
    });
  });

  register(getNativeAgentProjectionUpdateCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    if (args.syncVersion !== 1) throw new Error("Native agent sync version is unsupported");
    if (
      !args.liveWindow ||
      typeof args.liveWindow !== "object" ||
      Array.isArray(args.liveWindow) ||
      (args.liveWindow as { messages?: unknown }).messages !== 100 ||
      (args.liveWindow as { targetBytes?: unknown }).targetBytes !== 512 * 1024
    ) {
      throw new Error("Native agent live window is unsupported");
    }
    return markSpliceableResult(
      await context.nativeAgents.getProjectionUpdate({
        environmentId: asNonBlankString(args.environmentId, "environmentId"),
        agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
        logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
        syncVersion: 1,
        liveWindow: { messages: 100, targetBytes: 512 * 1024 },
        knownToken:
          args.knownToken === undefined
            ? undefined
            : asBoundedNonBlankString(args.knownToken, "knownToken", 1024),
        forceSnapshot:
          args.forceSnapshot === undefined
            ? undefined
            : asRequiredBoolean(args.forceSnapshot, "forceSnapshot"),
      }),
    );
  });

  register(getNativeAgentMessagePageCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    if (args.syncVersion !== 1) throw new Error("Native agent sync version is unsupported");
    return markSpliceableResult(
      await context.nativeAgents.getMessagePage({
        environmentId: asNonBlankString(args.environmentId, "environmentId"),
        agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
        logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
        syncVersion: 1,
        before: asBoundedNonBlankString(args.before, "before", 1024),
        limit: args.limit === undefined ? undefined : asPositiveInteger(args.limit, "limit"),
        targetBytes:
          args.targetBytes === undefined
            ? undefined
            : asPositiveInteger(args.targetBytes, "targetBytes"),
      }),
    );
  });

  register(getNativeAgentToolDetailsCommand, async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    return context.nativeAgents.getProjectionToolDetails({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      detailRef: asNonBlankString(args.detailRef, "detailRef"),
    });
  });

  register(refreshNativeAgentModelsCommand, async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    return context.nativeAgents.refreshProjectionModels({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
    });
  });

  register(refreshNativeAgentCommandsCommand, async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    return context.nativeAgents.refreshProjectionCommands({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
    });
  });

  register(nativeAgentGoalCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    return context.nativeAgents.runGoalCommand({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      text: typeof args.text === "string" ? args.text : "",
      ...(typeof args.model === "string" && args.model ? { model: args.model } : {}),
    });
  });
  register(getNativeAgentGoalCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    return context.nativeAgents.readGoalDetail({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
    });
  });
  register(stopNativeAgentSessionCommand, async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    return context.nativeAgents.stopProjectionSession({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
    });
  });

  register(stopNativeAgentBackgroundTaskCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    return context.nativeAgents.stopProjectionBackgroundTask({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      taskId: asNonBlankString(args.taskId, "taskId"),
    });
  });

  register(dismissNativeAgentSuggestedPromptCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    return context.nativeAgents.dismissProjectionSuggestedPrompt({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
    });
  });

  register(listNativeAgentResumableSessionsCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    return context.nativeAgents.listProjectionResumableSessions({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      ...(args.includeArchived === true ? { includeArchived: true } : {}),
    });
  });

  register(setNativeAgentResumableSessionArchivedCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    if (typeof args.archived !== "boolean") throw new Error("archived must be a boolean");
    await context.nativeAgents.setProjectionResumableSessionArchived({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      resumableSessionId: asNonBlankString(args.resumableSessionId, "resumableSessionId"),
      archived: args.archived,
    });
    return { archived: args.archived };
  });

  register(resumeNativeAgentSessionCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    return context.nativeAgents.resumeProjectionSession({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      providerSessionId: asNonBlankString(args.providerSessionId, "providerSessionId"),
      controls:
        args.controls === undefined
          ? undefined
          : asNativeAgentControlUpdate(args.controls, "controls"),
    });
  });

  register(forkNativeAgentSessionCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    return context.nativeAgents.forkProjectionSession({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      messageId:
        args.messageId === undefined ? undefined : asNonBlankString(args.messageId, "messageId"),
    });
  });

  register(updateNativeAgentControlsCommand, async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    const update = asNativeAgentControlUpdate(args.update);
    return context.nativeAgents.updateProjectionControls({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      update,
    });
  });

  register(steerNativeAgentQueuedPromptCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    return context.nativeAgents.steerQueuedPrompt({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      messageId: asNonBlankString(args.messageId, "messageId"),
    });
  });

  register(performNativeAgentSessionActionCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    return context.nativeAgents.performProjectionAction({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      action: asNativeAgentSessionAction(args.action),
    });
  });

  register(performNativeAgentMcpActionCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    const action = asNonBlankString(args.action, "action");
    if (!["reconnect", "enable", "disable", "sign-in"].includes(action)) {
      throw new Error("Unsupported MCP server action");
    }
    return context.nativeAgents.performProjectionMcpAction({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      serverId: asNonBlankString(args.serverId, "serverId"),
      action: action as import("@orkestrator/protocol/native-agent").NativeAgentMcpServerAction,
    });
  });

  register(getNativeAgentAuthStatusCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    const agent = asNonBlankString(
      args.agent,
      "agent",
    ) as import("./models.js").NativeAgentProvider;
    if (!BUILD_PIPELINE_AGENTS.includes(agent)) throw new Error("Native agent provider is invalid");
    return context.nativeAgents.readProjectionAuthStatus({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
    });
  });

  register(beginNativeAgentSignInCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    return context.nativeAgents.beginProjectionSignIn({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      ...(args.deviceCode === true ? { deviceCode: true } : {}),
    });
  });

  register(cancelNativeAgentSignInCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    return context.nativeAgents.cancelProjectionSignIn({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
    });
  });

  register(signOutNativeAgentCommand, async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    await context.nativeAgents.signOutProjectionProvider({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
    });
    return { ok: true as const };
  });

  register(resolveNativeAgentInteractionCommand, async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    const resolution = asRecord(args.resolution, "resolution");
    return context.nativeAgents.resolveProjectionInteraction({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      interactionId: asNonBlankString(args.interactionId, "interactionId"),
      resolution:
        resolution as unknown as import("@orkestrator/protocol/agent-interactions").AgentInteractionResolution,
    });
  });

  register(holdNativeAgentInteractionCommand, async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    return context.nativeAgents.holdProjectionInteraction({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      interactionId: asNonBlankString(args.interactionId, "interactionId"),
      held: asRequiredBoolean(args.held, "held"),
    });
  });

  register(getAgentInteractionObservationsCommand, (_args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    return context.nativeAgents.getInteractionObservations();
  });
  register(reconcileAgentInteractionsCommand, async (_args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    await context.nativeAgents.reconcileAgentInteractions();
    return context.nativeAgents.getInteractionObservations();
  });
  register(setAgentInteractionMonitorAdoptionCommand, ({ enabled }, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    const value = asRequiredBoolean(enabled, "enabled");
    context.nativeAgents.setInteractionMonitorAdoptionEnabled(value);
    return { enabled: value };
  });
}
