import {
  isAgentPlatform,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import { resolveAgentPlatformSettings } from "@orkestrator/protocol/agent-settings";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import { PUBLIC_API_LIMITS, type PublicDispatchState } from "@orkestrator/protocol/public-api";
import { encodePublicSessionId } from "@orkestrator/protocol/public-api-resources";
import { validateSelection } from "../control-shared-actions.js";
import type { Environment } from "../models.js";
import { requireEnvironment } from "./actions-discovery.js";
import { isSetupReady } from "./actions-environments.js";
import { PublicActionError } from "./errors.js";
import {
  invalid,
  oneOf,
  onlyKeys,
  optionalBoolean,
  optionalString,
  requiredId,
  sessionTarget,
  textInput,
} from "./input.js";
import { resolveSession, sessionActivity } from "./sessions.js";
import type {
  ExecuteOutcome,
  MutationActionHandler,
  PublicActionContext,
  PublicActionHandler,
} from "./types.js";

/**
 * Starting and continuing native conversations. Both reuse the backend's
 * durable dispatch path (the dispatch journal and its at-most-once rule);
 * the public operation ID is the provider request ID, so the receipt and the
 * journal can never drift apart. A response means *submitted*: completion is
 * a separate, request-specific observation (`run.get` / `run wait`).
 */

export function assertReadyForAgents(environment: Environment): void {
  if (environment.deletionRequestedAt || environment.lifecycleOperation === "deleting") {
    throw new PublicActionError("conflict", "The environment is being deleted");
  }
  if (!isSetupReady(environment)) {
    throw new PublicActionError(
      "not-ready",
      "The environment is not running with setup complete; start it with --wait ready first",
      { details: { status: environment.status, setupPhase: environment.setupPhase ?? null } },
    );
  }
}

export interface AgentSelection {
  agent: AgentPlatform;
  model?: string;
  reasoning?: string;
  fastMode?: boolean;
  mode?: "plan" | "build";
}

export function parseAgentSelection(input: Record<string, unknown>): AgentSelection {
  const agent = input.agent;
  if (!isAgentPlatform(agent))
    throw invalid("agent must be one of: claude, codex, cursor, grok, opencode, pi");
  const model = optionalString(input, "model", 500)?.trim();
  const reasoning = optionalString(input, "reasoning", 100)?.trim();
  if (reasoning && !model) throw invalid("reasoning requires model");
  return {
    agent,
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(input.fastMode !== undefined ? { fastMode: optionalBoolean(input, "fastMode") } : {}),
    ...(input.mode !== undefined ? { mode: oneOf(input, "mode", ["plan", "build"] as const) } : {}),
  };
}

/**
 * Validate an explicit selection against the live catalogue and resolve the
 * inherited defaults now, so the operation records exactly what it launched.
 */
export async function resolveSelection(
  selection: AgentSelection,
  environment: Environment,
  context: PublicActionContext,
): Promise<{ model?: string; reasoningEffort?: string; fastMode?: boolean }> {
  const config = await context.command.storage.loadConfig();
  if (!normalizeAgentPlatforms(config.global.enabledAgentPlatforms).includes(selection.agent)) {
    throw new PublicActionError(
      "capability-unavailable",
      `The ${selection.agent} agent is not enabled`,
    );
  }
  try {
    await validateSelection(context.invoke, {
      projectId: environment.projectId,
      environmentId: environment.id,
      agent: selection.agent,
      ...(selection.model ? { modelId: selection.model } : {}),
      ...(selection.reasoning ? { reasoningId: selection.reasoning } : {}),
      ...(selection.fastMode !== undefined ? { fastMode: selection.fastMode } : {}),
    });
  } catch (error) {
    throw new PublicActionError(
      "unsupported",
      error instanceof Error ? error.message : "Unsupported selection",
    );
  }
  const defaults = resolveAgentPlatformSettings(
    {
      environment: environment.agentSettings,
      repository: config.repositories?.[environment.projectId]?.agentSettings,
      global: config.global.agentSettings,
    },
    selection.agent,
  );
  return {
    ...((selection.model ?? defaults.model) ? { model: selection.model ?? defaults.model } : {}),
    ...(selection.reasoning
      ? { reasoningEffort: selection.reasoning }
      : !selection.model && defaults.reasoningEffort
        ? { reasoningEffort: defaults.reasoningEffort }
        : {}),
    ...((selection.fastMode ?? defaults.fastMode) !== undefined
      ? { fastMode: selection.fastMode ?? defaults.fastMode }
      : {}),
  };
}

export function dispatchOutcome(
  status: string,
  error: string | undefined,
  result: Record<string, unknown>,
): ExecuteOutcome {
  if (status === "accepted") {
    return {
      state: "running",
      stage: "executing",
      result,
      dispatch: { state: "accepted" },
      execution: { state: "pending" },
    };
  }
  if (status === "unknown") {
    const dispatch: PublicDispatchState = {
      state: "unknown",
      recoverable: true,
      ...(error ? { error: error.slice(0, 500) } : {}),
    };
    return {
      state: "unknown",
      stage: "dispatching",
      result,
      dispatch,
      execution: { state: "unknown", reason: "Dispatch was not confirmed" },
      error: {
        code: "dispatch-unknown",
        message:
          "The provider may have received the prompt. Retry with `run retry` (same key) or `run discard`.",
      },
      retryable: true,
    };
  }
  return {
    state: "failed",
    stage: "dispatching",
    result,
    dispatch: { state: "rejected", ...(error ? { error: error.slice(0, 500) } : {}) },
    error: {
      code: "operation-failed",
      message: error?.slice(0, 500) ?? "The provider rejected the prompt",
    },
  };
}

interface StartInput extends AgentSelection {
  environmentId: string;
  prompt: string;
  title?: string;
}

const sessionStart: MutationActionHandler<StartInput> = {
  kind: "mutation",
  action: "session.start",
  parse(input) {
    onlyKeys(input, [
      "environmentId",
      "agent",
      "model",
      "reasoning",
      "fastMode",
      "mode",
      "title",
      "prompt",
    ]);
    const environmentId = requiredId(input, "environmentId");
    const selection = parseAgentSelection(input);
    const prompt = textInput(
      input,
      "prompt",
      PUBLIC_API_LIMITS.promptMaxChars,
      PUBLIC_API_LIMITS.promptMaxBytes,
    );
    const title = optionalString(input, "title", PUBLIC_API_LIMITS.titleMaxChars)?.trim();
    const value: StartInput = { environmentId, prompt, ...selection, ...(title ? { title } : {}) };
    return { value, scope: `environment:${environmentId}`, intent: value };
  },
  async prepare(input, context) {
    const environment = await requireEnvironment(context, input.environmentId);
    assertReadyForAgents(environment);
    const resolved = await resolveSelection(input, environment, context);
    return {
      resolved: {
        agent: input.agent,
        model: resolved.model ?? null,
        reasoningEffort: resolved.reasoningEffort ?? null,
        fastMode: resolved.fastMode ?? null,
        mode: input.mode ?? "build",
      },
      resources: { environmentId: environment.id, projectId: environment.projectId },
      async execute(operation) {
        const requestId = operation.operationId;
        await operation.update({
          stage: "dispatching",
          resources: { dispatchRequestId: requestId },
        });
        // The same durable job path the desktop and Control MCP use: stable
        // tab and session identity from (environment, request ID), and an
        // exactly-once first prompt. The tab is created without focusing it.
        const job = await context.invoke<{ tabId: string; status: string; error?: string }>(
          "launch_native_agent_job",
          {
            environmentId: environment.id,
            requestId,
            agent: input.agent,
            prompt: input.prompt,
            conversationMode: input.mode ?? "build",
            ...(input.title ? { title: input.title } : {}),
            ...(resolved.model ? { modelId: resolved.model } : {}),
            ...(resolved.reasoningEffort ? { reasoningId: resolved.reasoningEffort } : {}),
            ...(resolved.fastMode !== undefined ? { fastMode: resolved.fastMode } : {}),
            activateTab: false,
          },
        );
        const sessionId = encodePublicSessionId(environment.id, job.tabId);
        const outcome = dispatchOutcome(job.status, job.error, {
          sessionId,
          tabId: job.tabId,
          runId: operation.operationId,
        });
        return {
          ...outcome,
          resources: { sessionId, tabId: job.tabId, dispatchRequestId: requestId },
        };
      },
    };
  },
};

interface PromptInput {
  sessionId: string;
  environmentId: string;
  tabId: string;
  prompt: string;
  mode?: "plan" | "build";
}

const sessionPrompt: MutationActionHandler<PromptInput> = {
  kind: "mutation",
  action: "session.prompt",
  parse(input) {
    onlyKeys(input, ["sessionId", "prompt", "mode"]);
    const target = sessionTarget(input);
    const prompt = textInput(
      input,
      "prompt",
      PUBLIC_API_LIMITS.promptMaxChars,
      PUBLIC_API_LIMITS.promptMaxBytes,
    );
    const mode = oneOf(input, "mode", ["plan", "build"] as const);
    const value: PromptInput = { ...target, prompt, ...(mode ? { mode } : {}) };
    return { value, scope: `session:${target.sessionId}`, intent: { prompt, mode: mode ?? null } };
  },
  async prepare(input, context) {
    const session = await resolveSession(context, input);
    assertReadyForAgents(session.environment);
    if (!session.record) {
      throw new PublicActionError("not-ready", "The session has no provider conversation yet");
    }
    if (session.record.pendingDispatch || session.record.pendingSteer) {
      throw new PublicActionError(
        "dispatch-parked",
        "An earlier message is awaiting confirmation; `run retry` or `run discard` it first",
        {
          details: {
            requestId:
              session.record.pendingDispatch?.requestId ??
              session.record.pendingSteer?.requestId ??
              null,
          },
        },
      );
    }
    const activity = sessionActivity(context, {
      environmentId: session.environment.id,
      agent: session.agent,
      logicalSessionKey: session.logicalSessionKey,
    });
    if (activity === "working" || activity === "waiting") {
      // Ordinary follow-ups never queue or steer implicitly.
      throw new PublicActionError(
        "busy",
        activity === "waiting"
          ? "The session is waiting for an answer to a pending interaction"
          : "The session is busy; wait for the turn to end or use `session steer`",
        { details: { activity } },
      );
    }
    // Keep the conversation's own mode unless the caller chose one: several
    // providers persist a prompt's mode on the session.
    let mode = input.mode;
    if (!mode && nativeAgentCapabilities(session.agent).composer.mode) {
      const current =
        session.record.controls?.mode ??
        context.command.nativeAgents?.cachedProjectionSnapshot(
          session.environment.id,
          session.agent,
          session.logicalSessionKey,
        )?.composer?.selectedModeId;
      mode = current === "plan" || current === "build" ? current : "build";
    }
    return {
      resolved: { agent: session.agent, mode: mode ?? null },
      resources: {
        environmentId: session.environment.id,
        projectId: session.environment.projectId,
        sessionId: session.sessionId,
        tabId: session.tab.tabId,
      },
      async execute(operation) {
        const requestId = operation.operationId;
        await operation.update({
          stage: "dispatching",
          resources: { dispatchRequestId: requestId },
        });
        const outcome = await context.invoke<{ outcome: string; error?: string }>(
          "dispatch_native_agent_intent",
          {
            environmentId: session.environment.id,
            agent: session.agent,
            logicalSessionKey: session.logicalSessionKey,
            requestId,
            prompt: input.prompt,
            ...(mode ? { mode } : {}),
          },
        );
        return dispatchOutcome(outcome.outcome, outcome.error, {
          runId: requestId,
          sessionId: session.sessionId,
        });
      },
    };
  },
};

export const SESSION_HANDLERS: PublicActionHandler[] = [sessionStart, sessionPrompt];

export type { StartInput };
