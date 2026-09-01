import { createHash } from "node:crypto";
import { normalizeAgentPlatforms } from "@orkestrator/protocol/agent-platforms";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { BUILD_PIPELINE_AGENTS, isAgentPlatform } from "./commands-dependencies.js";
import { asNonBlankString, asOptionalString } from "./commands-helpers.js";

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

  const model = asOptionalString(args.modelId)?.trim();
  const reasoningEffort = asOptionalString(args.reasoningId)?.trim();
  if (reasoningEffort && !model && options.validateModelCatalog) {
    throw new Error("reasoningId requires modelId");
  }
  const fastMode = args.fastMode;
  if (fastMode !== undefined && typeof fastMode !== "boolean") {
    throw new Error("fastMode must be boolean");
  }
  if (model && options.validateModelCatalog) {
    const catalogCommand = dependencies.commands.get("get_native_agent_model_catalog");
    if (!catalogCommand) throw new Error("Agent model catalogue is unavailable");
    const rawCatalog = await catalogCommand({ environmentId }, context);
    const models = Array.isArray(rawCatalog) ? (rawCatalog as AgentModel[]) : [];
    const selected = models.find(
      (candidate) => candidate.platform === agent && candidate.id === model,
    );
    if (!selected) throw new Error(`Model is not available for ${agent}: ${model}`);
    if (
      reasoningEffort &&
      !(selected.reasoning ?? []).some((option) => option.id === reasoningEffort)
    ) {
      throw new Error(`Reasoning option is not available for ${model}: ${reasoningEffort}`);
    }
  }

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
