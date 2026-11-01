import { createHash } from "node:crypto";
import { normalizeAgentPlatforms, isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { resolveAgentPlatformSettings } from "@orkestrator/protocol/agent-settings";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { BUILD_PIPELINE_AGENTS } from "@orkestrator/protocol/build-pipeline";
import { asNonBlankString, asOptionalString } from "./commands-helpers.js";
import {
  isTrustedUserPromptPresentation,
  parseCoordinatorDelegatedPrompt,
} from "@orkestrator/protocol/review-evidence-frames";
import { coordinatorDelegationPresentationFrom } from "./coordinator-delegation-authority.js";
import {
  createAgentModelCatalogReader,
  resolveFastMode,
} from "./build-pipeline-service-helpers.js";
import { assertValidPromptAttachments } from "./prompt-attachments.js";
import {
  isNativeAgentJobTabReuse,
  resendToOpenJobTab,
  jobPromptFingerprint,
} from "./native-agent-job-tab-reuse.js";

function jobIdFor(environmentId: string, requestId: string): string {
  return createHash("sha256")
    .update(environmentId)
    .update("\0")
    .update(requestId)
    .digest("hex")
    .slice(0, 24);
}

async function launchNativeAgentJob(
  args: Record<string, unknown>,
  context: CommandContext,
  dependencies: RegistryDependencies,
  options: {
    validateModelCatalog: boolean;
    allowCompletionAction: boolean;
  },
): Promise<Record<string, unknown>> {
  if (args.tabReuse && options.allowCompletionAction) {
    const environmentId = asNonBlankString(args.environmentId, "environmentId");
    return context.storage.withNativeAgentJobLaunch(environmentId, () =>
      launchNativeAgentJobInternal(args, context, dependencies, options),
    );
  }
  return launchNativeAgentJobInternal(args, context, dependencies, options);
}

async function launchNativeAgentJobInternal(
  args: Record<string, unknown>,
  context: CommandContext,
  dependencies: RegistryDependencies,
  options: { validateModelCatalog: boolean; allowCompletionAction: boolean },
): Promise<Record<string, unknown>> {
  if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
  const environmentId = asNonBlankString(args.environmentId, "environmentId");
  let requestId = asNonBlankString(args.requestId, "requestId");
  const autoMergePrUrl = options.allowCompletionAction
    ? asOptionalString(args.autoMergePrUrl)
    : undefined;
  const autoMergeEnabledAt = asOptionalString(args.autoMergeEnabledAt);
  if (requestId.length > 256) throw new Error("requestId must be at most 256 characters");
  const prompt = asNonBlankString(args.prompt, "prompt");
  if (prompt.length > 100_000) throw new Error("prompt must be at most 100000 characters");
  const initialPromptPresentation = coordinatorDelegationPresentationFrom(args);
  if (initialPromptPresentation !== undefined) {
    const parsed = parseCoordinatorDelegatedPrompt(prompt);
    if (
      !isTrustedUserPromptPresentation(initialPromptPresentation) ||
      parsed?.frame !== initialPromptPresentation.frame
    ) {
      throw new Error("initialPromptPresentation does not match the prompt");
    }
  }
  const title = asOptionalString(args.title)?.trim();
  if (title && title.length > 200) throw new Error("title must be at most 200 characters");
  const agent = args.agent;
  if (!isAgentPlatform(agent) || !BUILD_PIPELINE_AGENTS.includes(agent)) {
    throw new Error("Agent platform is invalid");
  }
  const conversationMode = args.conversationMode ?? "build";
  if (conversationMode !== "plan" && conversationMode !== "build") {
    throw new Error("conversationMode must be plan or build");
  }
  const completionAction = options.allowCompletionAction ? args.completionAction : undefined;
  if (completionAction !== undefined && completionAction !== "refresh-pr-after-agent-completion") {
    throw new Error("completionAction is invalid");
  }
  // Only explicit literal intent is accepted for a first prompt: a new tab has
  // no catalogue a selection could have been made from.
  if (args.literal !== undefined && args.literal !== true) {
    throw new Error("literal must be true when given");
  }
  const literal = args.literal === true;
  // Marks the tab the way the Review button does, so it offers Address all.
  if (args.reviewTab !== undefined && args.reviewTab !== true) {
    throw new Error("reviewTab must be true when given");
  }
  const reviewTab = args.reviewTab === true;
  const tabReuse = options.allowCompletionAction ? args.tabReuse : undefined;
  if (tabReuse !== undefined && !isNativeAgentJobTabReuse(tabReuse)) {
    throw new Error("tabReuse is invalid");
  }
  // The marker that finds the tab is the completion action; the resend carries
  // the prompt alone, so a launch asking for more than that is refused.
  if (tabReuse && (!completionAction || literal || args.attachments !== undefined)) {
    throw new Error("tabReuse needs a completionAction and a plain prompt");
  }
  // Already staged in the workspace by the caller; validated, never written here.
  const attachments =
    args.attachments === undefined
      ? undefined
      : Array.isArray(args.attachments)
        ? assertValidPromptAttachments(args.attachments)
        : (() => {
            throw new Error("attachments must be an array");
          })();

  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  if (environment.deletionRequestedAt || environment.lifecycleOperation === "deleting") {
    throw new Error("Environment is being deleted");
  }
  if (
    environment.status !== "running" ||
    !(
      environment.setupPhase === "ready" ||
      environment.setupScriptsComplete === true ||
      environment.setupOverride === true
    )
  ) {
    throw new Error("Environment is not running with setup complete");
  }

  const config = await context.storage.loadConfig();
  const enabled = normalizeAgentPlatforms(config.global.enabledAgentPlatforms);
  if (!enabled.includes(agent)) throw new Error(`Agent platform is disabled: ${agent}`);

  const repository = config.repositories?.[environment.projectId];
  const defaults = resolveAgentPlatformSettings(
    {
      environment: environment.agentSettings,
      repository: repository?.agentSettings,
      global: config.global.agentSettings,
    },
    agent,
  );
  const explicitModel = asOptionalString(args.modelId)?.trim();
  const explicitReasoningEffort = asOptionalString(args.reasoningId)?.trim();
  const model = explicitModel || defaults.model;
  let reasoningEffort = explicitReasoningEffort || defaults.reasoningEffort;
  if (explicitReasoningEffort && !explicitModel && options.validateModelCatalog) {
    throw new Error("reasoningId requires modelId");
  }
  const requestedFastMode = args.fastMode ?? defaults.fastMode;
  if (requestedFastMode !== undefined && typeof requestedFastMode !== "boolean") {
    throw new Error("fastMode must be boolean");
  }

  const catalogCommand = dependencies.commands.get("get_native_agent_model_catalog");
  let catalogRead: Promise<AgentModel[]> | undefined;
  const loadCatalog = (): Promise<AgentModel[]> => {
    catalogRead ??= (async () => {
      if (!catalogCommand) throw new Error("Agent model catalogue is unavailable");
      const raw = await catalogCommand({ environmentId }, context);
      return Array.isArray(raw) ? (raw as AgentModel[]) : [];
    })();
    return catalogRead;
  };

  if (explicitModel && options.validateModelCatalog) {
    // A validation read has to fail loudly. An unreadable catalogue is not
    // evidence that the requested model exists.
    const models = await loadCatalog();
    const selected = models.find(
      (candidate) =>
        candidate.platform === agent &&
        (candidate.id === explicitModel || candidate.aliases?.includes(explicitModel) === true),
    );
    if (!selected) throw new Error(`Model is not available for ${agent}: ${explicitModel}`);
    const offersReasoning = (option: string): boolean =>
      (selected.reasoning ?? []).some((candidate) => candidate.id === option);
    if (explicitReasoningEffort && !offersReasoning(explicitReasoningEffort)) {
      throw new Error(
        `Reasoning option is not available for ${explicitModel}: ${explicitReasoningEffort}`,
      );
    }
    // An inherited effort belongs to whichever model its tier was configured
    // for. When the caller pinned a different model that has no such option,
    // drop the inherited value rather than rejecting a launch that never asked
    // for it.
    if (!explicitReasoningEffort && reasoningEffort && !offersReasoning(reasoningEffort)) {
      reasoningEffort = undefined;
    }
  }

  // The catalogue can only ever narrow a Fast choice, so a read that fails or
  // is unavailable leaves the provider as the authority instead of failing the
  // launch. This also keeps the read off the path entirely when no Fast choice
  // is in play.
  const fastMode = await resolveFastMode(
    agent,
    requestedFastMode as boolean | undefined,
    model,
    createAgentModelCatalogReader(loadCatalog),
  );

  let armedAt: string | null = null;
  let previousArmedAt: string | undefined;
  const rollBackCompletionAction = async (): Promise<void> => {
    if (!armedAt) return;
    try {
      await context.storage.disarmPrRecheckAfterAgentCompletion(
        environmentId,
        armedAt,
        previousArmedAt,
      );
    } catch (error) {
      console.warn(
        `[native-agent-job] Failed to roll back PR refresh for ${environmentId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  };

  if (autoMergePrUrl && !context.prAutoMerge?.isActive()) return { status: "skipped" };
  if (completionAction === "refresh-pr-after-agent-completion") {
    const armed = await context.storage.armPrRecheckAfterAgentCompletion(environmentId, {
      onlyIfUnarmed: !!autoMergePrUrl,
      ...(autoMergePrUrl ? { autoMergePrUrl, autoMergeEnabledAt, requestId } : {}),
    });
    armedAt = armed.armedAt;
    previousArmedAt = armed.previousArmedAt;
    if (!armedAt && autoMergePrUrl) return { status: "skipped" };
    if (autoMergePrUrl && armed.environment.autoMergeResolveRequestId)
      requestId = armed.environment.autoMergeResolveRequestId;
  }

  const authorized = async (): Promise<boolean> => {
    if (!autoMergePrUrl) return true;
    const current = await context.storage.getEnvironment(environmentId);
    return (
      context.prAutoMerge?.isActive() === true &&
      current?.autoMerge === true &&
      current.autoMergePrUrl === autoMergePrUrl &&
      current.prUrl === autoMergePrUrl &&
      (autoMergeEnabledAt === undefined || current.autoMergeEnabledAt === autoMergeEnabledAt) &&
      current.prState === "open" &&
      current.hasMergeConflicts === true &&
      current.prRecheckAfterAgentCompletionArmedAt === armedAt &&
      !current.lifecycleOperation &&
      !current.deletionRequestedAt &&
      current.status === "running" &&
      (current.setupPhase === "ready" ||
        current.setupScriptsComplete === true ||
        current.setupOverride === true)
    );
  };
  let dispatchStarted = false;

  const completionActionResult = completionAction
    ? {
        completionActionArmed: armedAt !== null,
        ...(!armedAt
          ? {
              warning: "Conflict resolution started, but automatic PR refresh was not scheduled.",
            }
          : {}),
      }
    : {};

  try {
    if (!(await authorized())) {
      await rollBackCompletionAction();
      return { status: "skipped" };
    }
    const jobId = jobIdFor(environmentId, requestId);
    if (tabReuse && completionAction) {
      const resent = await resendToOpenJobTab(context, {
        environmentId,
        requestId,
        completionAction,
        tabReuse,
        agent,
        enabledAgents: enabled,
        prompt,
        mode: conversationMode,
        selection: {
          ...(explicitModel ? { model: explicitModel } : {}),
          ...(explicitReasoningEffort ? { reasoningEffort: explicitReasoningEffort } : {}),
          ...(typeof args.fastMode === "boolean" && typeof fastMode === "boolean"
            ? { fastMode }
            : {}),
        },
      });
      if (resent) return { jobId, environmentId, ...resent, ...completionActionResult };
    }
    const tabId = `agent-job-${jobId}`;
    const logicalSessionKey = `env-${environmentId}:${tabId}`;
    await context.storage.ensureNativeAgentJobTab({
      environmentId,
      tabId,
      agent,
      title,
      activate: args.activateTab === true,
      ...(reviewTab ? { isReviewTab: true } : {}),
      ...(completionAction ? { completionAction } : {}),
    });
    const session = await context.nativeAgents.ensureSession({
      environmentId,
      agent,
      logicalSessionKey,
      origin: "interactive-native",
      title,
      model,
      modelSource: explicitModel ? "explicit" : "default",
      reasoningEffort,
      sessionMode: conversationMode,
      ...(initialPromptPresentation ? { initialPromptPresentation } : {}),
      ...(typeof fastMode === "boolean" ? { fastMode } : {}),
    });
    await context.storage.ensureNativeAgentJobTab({
      environmentId,
      tabId,
      agent,
      providerSessionId: session.providerSessionId,
      title,
    });
    const jobQueueKey = `${agent}\0${logicalSessionKey}`;
    if (tabReuse) {
      await context.storage.reserveNativeAgentJobRequest(jobQueueKey, environmentId, {
        requestId,
        fingerprint: jobPromptFingerprint(
          prompt,
          conversationMode,
          tabReuse === "same-agent"
            ? {
                ...(explicitModel ? { model: explicitModel } : {}),
                ...(explicitReasoningEffort ? { reasoningEffort: explicitReasoningEffort } : {}),
                ...(typeof args.fastMode === "boolean" && typeof fastMode === "boolean"
                  ? { fastMode }
                  : {}),
              }
            : {},
        ),
        status: "unknown",
      });
    }
    if (!(await authorized())) {
      await rollBackCompletionAction();
      return { status: "skipped" };
    }
    dispatchStarted = true;
    const outcome = await context.nativeAgents.dispatchIntent({
      environmentId,
      agent,
      logicalSessionKey,
      origin: "interactive-native",
      title,
      model,
      modelSource: explicitModel ? "explicit" : "default",
      reasoningEffort,
      ...(typeof fastMode === "boolean" ? { fastMode } : {}),
      prompt,
      requestId,
      mode: conversationMode,
      ...(literal ? { command: { kind: "literal" as const } } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(initialPromptPresentation ? { initialPromptPresentation } : {}),
    });
    if (tabReuse)
      await context.storage.settleNativeAgentJobRequest(jobQueueKey, requestId, outcome.outcome);
    if (outcome.outcome === "rejected") await rollBackCompletionAction();
    return {
      jobId,
      environmentId,
      tabId,
      agent,
      logicalSessionKey,
      status:
        outcome.outcome === "accepted"
          ? "accepted"
          : outcome.outcome === "unknown"
            ? "unknown"
            : "rejected",
      ...(outcome.outcome === "rejected" ? { error: outcome.error } : {}),
      ...(outcome.outcome === "unknown" && outcome.error ? { error: outcome.error } : {}),
      ...completionActionResult,
    };
  } catch (error) {
    // A thrown dispatch can have reached the provider. Retain ownership; never duplicate it.
    if (!dispatchStarted) await rollBackCompletionAction();
    throw error;
  }
}

export function registerControlCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  register("get_control_mcp_settings", (_args, context) => {
    if (!context.controlMcp) throw new Error("Orkestrator control MCP is unavailable");
    return context.controlMcp.getSettings();
  });

  register("rotate_control_mcp_token", async (_args, context) => {
    if (!context.controlMcp) throw new Error("Orkestrator control MCP is unavailable");
    return context.controlMcp.rotateToken();
  });

  // Named operator credentials (Settings → MCP). Tokens are returned to the
  // renderer so Copy setup works, exactly as the single token always was.
  register("create_control_mcp_credential", async (args, context) => {
    if (!context.controlMcp) throw new Error("Orkestrator control MCP is unavailable");
    return context.controlMcp.createCredential({
      label: args.label,
      profile: args.profile,
      ...(args.capabilities !== undefined ? { capabilities: args.capabilities } : {}),
      ...(args.deniedActions !== undefined ? { deniedActions: args.deniedActions } : {}),
    });
  });

  register("rotate_control_mcp_credential", async (args, context) => {
    if (!context.controlMcp) throw new Error("Orkestrator control MCP is unavailable");
    if (typeof args.credentialId !== "string") throw new Error("credentialId is required");
    return context.controlMcp.rotateCredential(args.credentialId);
  });

  register("revoke_control_mcp_credential", async (args, context) => {
    if (!context.controlMcp) throw new Error("Orkestrator control MCP is unavailable");
    if (typeof args.credentialId !== "string") throw new Error("credentialId is required");
    return context.controlMcp.revokeCredential(args.credentialId);
  });

  register("launch_control_job", (args, context) =>
    launchNativeAgentJob(args, context, dependencies, {
      validateModelCatalog: true,
      allowCompletionAction: false,
    }),
  );

  // Renderer actions use the same durable job machinery as Control MCP jobs.
  // The backend creates the pane tab, attaches the provider session and sends
  // the prompt before returning; mounting the tab is only a projection step.
  register("launch_native_agent_job", (args, context) =>
    launchNativeAgentJob(args, context, dependencies, {
      // UI launchers already choose from the authoritative model catalogue.
      // Settings may hold a provider's resolved model id rather than its picker
      // alias, so validating against the picker key here would reject a valid
      // configured default.
      validateModelCatalog: false,
      allowCompletionAction: true,
    }),
  );
}
