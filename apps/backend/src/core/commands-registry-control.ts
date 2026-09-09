import { createHash } from "node:crypto";
import { normalizeAgentPlatforms } from "@orkestrator/protocol/agent-platforms";
import { resolveAgentPlatformSettings } from "@orkestrator/protocol/agent-settings";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { BUILD_PIPELINE_AGENTS, isAgentPlatform } from "./commands-dependencies.js";
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
  if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
  const environmentId = asNonBlankString(args.environmentId, "environmentId");
  const requestId = asNonBlankString(args.requestId, "requestId");
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
  const rollBackCompletionAction = async (): Promise<void> => {
    if (!armedAt) return;
    try {
      await context.storage.disarmPrRecheckAfterAgentCompletion(environmentId, armedAt);
    } catch (error) {
      console.warn(
        `[native-agent-job] Failed to roll back PR refresh for ${environmentId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  };

  if (completionAction === "refresh-pr-after-agent-completion") {
    const armed = await context.storage.armPrRecheckAfterAgentCompletion(environmentId);
    armedAt = armed.armedAt;
  }

  try {
    const jobId = jobIdFor(environmentId, requestId);
    const tabId = `agent-job-${jobId}`;
    const logicalSessionKey = `env-${environmentId}:${tabId}`;
    await context.storage.ensureNativeAgentJobTab({
      environmentId,
      tabId,
      agent,
      title,
      activate: args.activateTab === true,
    });
    const session = await context.nativeAgents.ensureSession({
      environmentId,
      agent,
      logicalSessionKey,
      origin: "interactive-native",
      title,
      model,
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
    const outcome = await context.nativeAgents.dispatchIntent({
      environmentId,
      agent,
      logicalSessionKey,
      origin: "interactive-native",
      title,
      model,
      reasoningEffort,
      ...(typeof fastMode === "boolean" ? { fastMode } : {}),
      prompt,
      requestId,
      mode: conversationMode,
      ...(initialPromptPresentation ? { initialPromptPresentation } : {}),
    });
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
      ...(completionAction
        ? {
            completionActionArmed: armedAt !== null,
            ...(!armedAt
              ? {
                  warning:
                    "Conflict resolution started, but automatic PR refresh was not scheduled.",
                }
              : {}),
          }
        : {}),
    };
  } catch (error) {
    await rollBackCompletionAction();
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
