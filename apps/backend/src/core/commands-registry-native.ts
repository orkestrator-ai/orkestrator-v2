import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { BUILD_PIPELINE_AGENTS, nativeAgentSessionStorageKey } from "./commands-dependencies.js";
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
  asNativeAgentSessionAction,
} from "./commands-helpers.js";

export function registerNativeAgentCommands(
  register: CommandRegistrar,
  _dependencies: RegistryDependencies,
): void {
  register("get_cursor_account_usage", async (_args, context) => {
    const [
      { accountUsageForResolvedCredential },
      { cursorSdkStoredApiKey },
      { resolveCursorApiKey },
    ] = await Promise.all([
      import("./cursor-usage.js"),
      import("./cursor-sdk-bridge.js"),
      import("./commands-validation.js"),
    ]);
    const config = await context.storage.loadConfig();
    return accountUsageForResolvedCredential({
      configuredApiKey: resolveCursorApiKey(config.global).apiKey,
      storedApiKey: () => cursorSdkStoredApiKey(context),
    });
  });

  register("ensure_native_agent_session", async (args, context) => {
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
    });
  });

  register("adopt_native_agent_session", async (args, context) => {
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

  register("dispatch_native_agent_prompt", async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    return context.nativeAgents.dispatchPrompt(asDispatchNativeAgentPromptInput(args));
  });

  register("dispatch_native_agent_intent", async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    return context.nativeAgents.dispatchIntent(asDispatchNativeAgentPromptInput(args));
  });

  register("retry_native_agent_dispatch", async (args, context) => {
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

  register("discard_native_agent_dispatch", async (args, context) => {
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

  register("get_native_agent_session", async (args, context) => {
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

  register("get_native_agent_projection", async (args, context) => {
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
    });
  });

  register("get_native_agent_tool_details", async (args, context) => {
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

  register("refresh_native_agent_models", async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    return context.nativeAgents.refreshProjectionModels({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
    });
  });

  register("stop_native_agent_session", async (args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    return context.nativeAgents.stopProjectionSession({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
    });
  });

  register("stop_native_agent_background_task", async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    return context.nativeAgents.stopProjectionBackgroundTask({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      taskId: asNonBlankString(args.taskId, "taskId"),
    });
  });

  register("dismiss_native_agent_suggested_prompt", async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    return context.nativeAgents.dismissProjectionSuggestedPrompt({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
    });
  });

  register("list_native_agent_resumable_sessions", async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    return context.nativeAgents.listProjectionResumableSessions({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
    });
  });

  register("resume_native_agent_session", async (args, context) => {
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

  register("fork_native_agent_session", async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    return context.nativeAgents.forkProjectionSession({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      messageId:
        args.messageId === undefined ? undefined : asNonBlankString(args.messageId, "messageId"),
    });
  });

  register("update_native_agent_controls", async (args, context) => {
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

  register("perform_native_agent_session_action", async (args, context) => {
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    return context.nativeAgents.performProjectionAction({
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      agent: asString(args.agent, "agent") as import("./models.js").NativeAgentProvider,
      logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
      action: asNativeAgentSessionAction(args.action),
    });
  });

  register("resolve_native_agent_interaction", async (args, context) => {
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

  register("get_agent_interaction_observations", (_args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    return context.nativeAgents.getInteractionObservations();
  });
  register("reconcile_agent_interactions", async (_args, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    await context.nativeAgents.reconcileAgentInteractions();
    return context.nativeAgents.getInteractionObservations();
  });
  register("set_agent_interaction_monitor_adoption", ({ enabled }, context) => {
    if (!context.nativeAgents) {
      throw new Error("Native agent service is unavailable");
    }
    const value = asRequiredBoolean(enabled, "enabled");
    context.nativeAgents.setInteractionMonitorAdoptionEnabled(value);
    return { enabled: value };
  });
}
