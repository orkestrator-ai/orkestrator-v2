import { createHash } from "node:crypto";
import {
  isAgentPlatform,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import { resolveAgentPlatformSettings } from "@orkestrator/protocol/agent-settings";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import { PUBLIC_API_LIMITS, type PublicDispatchState } from "@orkestrator/protocol/public-api";
import { coordinatorIdFromRuntimeId } from "@orkestrator/protocol/coordinator";
import { encodePublicSessionId } from "@orkestrator/protocol/public-api-resources";
import { validateSelection } from "../control-shared-actions.js";
import type { Environment } from "../models.js";
import { requireEnvironment } from "./actions-discovery.js";
import { isSetupReady } from "./actions-environments.js";
import { PublicActionError } from "./errors.js";
import {
  invalid,
  oneOf,
  onlyActionKeys,
  optionalBoolean,
  optionalString,
  requiredId,
  sessionTarget,
  textInput,
} from "./input.js";
import {
  assertAttachmentSupport,
  assertQueueSupport,
  attachmentIntent,
  enqueuePrompt,
  parseAttachments,
  parseEnqueue,
  parseLiteral,
  stageAttachments,
  type ParsedAttachment,
} from "./prompt-delivery.js";
import {
  isCoordinatorSession,
  resolveSession,
  sessionActivity,
  type ResolvedSession,
} from "./sessions.js";
import type {
  ExecuteOutcome,
  MutationActionHandler,
  PreparedMutation,
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
      coordinatorIdFromRuntimeId(environment.id)
        ? "The Coordinator is paused or its checkout is unavailable; resume it in the app first"
        : "The environment is not running with setup complete; start it with --wait ready first",
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

export interface StartInput extends AgentSelection {
  environmentId: string;
  prompt: string;
  title?: string;
  literal?: true;
  attachments?: ParsedAttachment[];
}

const sessionStart: MutationActionHandler<StartInput> = {
  kind: "mutation",
  action: "session.start",
  parse(input) {
    onlyActionKeys(input, "session.start");
    const environmentId = requiredId(input, "environmentId");
    const selection = parseAgentSelection(input);
    const prompt = textInput(
      input,
      "prompt",
      PUBLIC_API_LIMITS.promptMaxChars,
      PUBLIC_API_LIMITS.promptMaxBytes,
    );
    const title = optionalString(input, "title", PUBLIC_API_LIMITS.titleMaxChars)?.trim();
    const literal = parseLiteral(input);
    const attachments = parseAttachments(input);
    const value: StartInput = {
      environmentId,
      prompt,
      ...selection,
      ...(title ? { title } : {}),
      ...(literal ? { literal } : {}),
      ...(attachments ? { attachments } : {}),
    };
    // Optional fields are absent when unset, so earlier fingerprints still match.
    return {
      value,
      scope: `environment:${environmentId}`,
      intent: { ...value, attachments: attachmentIntent(attachments) },
    };
  },
  async prepare(input, context) {
    return prepareSessionStart(input, context);
  },
};

/**
 * What a new agent tab adds beyond `session.start`: a button action's job
 * completion hook, and a step once the provider accepted the first prompt.
 */
export interface SessionStartExtras {
  completionAction?: "refresh-pr-after-agent-completion";
  afterAccepted?: (environment: Environment) => Promise<void>;
}

/**
 * `session.start`'s admission and execution, shared by the button actions
 * that open an agent tab with a fixed prompt (`pr.create`, `pr.resolve`).
 */
export async function prepareSessionStart(
  input: StartInput,
  context: PublicActionContext,
  extras: SessionStartExtras = {},
  existing?: Environment,
) {
  const environment = existing ?? (await requireEnvironment(context, input.environmentId));
  assertReadyForAgents(environment);
  assertAttachmentSupport(input.agent, input.attachments);
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
      const jobId = createHash("sha256")
        .update(environment.id)
        .update("\0")
        .update(requestId)
        .digest("hex")
        .slice(0, 24);
      const tabId = `agent-job-${jobId}`;
      const sessionId = encodePublicSessionId(environment.id, tabId);
      await operation.update({
        stage: "staging-attachments",
        resources: { dispatchRequestId: requestId, tabId, sessionId },
      });
      const attachments = await stageAttachments(
        context,
        environment,
        operation.operationId,
        input.attachments,
      );
      await operation.update({
        stage: "dispatching",
        resources: { dispatchRequestId: requestId, tabId, sessionId },
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
          // Only a model the caller named is pinned. An inherited default is
          // left for the launch to resolve as one (`modelSource: "default"`),
          // so the runtime can replace a default this login cannot serve (the
          // shipped Codex `gpt-5.4` on a ChatGPT login) instead of every
          // `session start` failing its first turn.
          ...(input.model ? { modelId: input.model } : {}),
          ...(resolved.reasoningEffort ? { reasoningId: resolved.reasoningEffort } : {}),
          ...(resolved.fastMode !== undefined ? { fastMode: resolved.fastMode } : {}),
          ...(input.literal ? { literal: true } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(extras.completionAction ? { completionAction: extras.completionAction } : {}),
          activateTab: false,
        },
      );
      const outcome = dispatchOutcome(job.status, job.error, {
        sessionId,
        tabId: job.tabId,
        runId: operation.operationId,
      });
      if (job.status === "accepted") {
        // Advisory follow-up: the run is already the provider's.
        await extras.afterAccepted?.(environment).catch(() => undefined);
      }
      return {
        ...outcome,
        resources: { sessionId, tabId: job.tabId, dispatchRequestId: requestId },
      };
    },
  } satisfies PreparedMutation;
}

interface PromptInput {
  sessionId: string;
  environmentId: string;
  tabId: string;
  prompt: string;
  mode?: "plan" | "build";
  literal?: true;
  enqueue?: true;
  attachments?: ParsedAttachment[];
}

/**
 * Admission checks shared by every prompt-shaped action on an existing
 * session (`session.prompt`, `session.command`): the session must have a
 * provider conversation and no parked dispatch. A busy session refuses an
 * ordinary prompt; with `enqueue` the prompt waits in the backend's durable
 * queue instead. Nothing ever turns a prompt into a steer.
 */
export function assertSessionAcceptsPrompt(
  context: Pick<PublicActionContext, "command">,
  session: ResolvedSession,
  enqueue: boolean,
): void {
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
  if (enqueue) {
    assertQueueSupport(session.agent);
    return;
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
        : "The session is busy; wait for the turn to end, enqueue the prompt, or use `session steer`",
      { details: { activity } },
    );
  }
}

/** Keep the conversation's own mode unless the caller chose one. */
export function sessionPromptMode(
  context: Pick<PublicActionContext, "command">,
  session: ResolvedSession,
  requested: "plan" | "build" | undefined,
): "plan" | "build" | undefined {
  if (isCoordinatorSession(session)) {
    // The app offers a Coordinator no mode either: its read-only policy is fixed.
    if (requested) throw new PublicActionError("unsupported", "A Coordinator has no mode to set");
    return undefined;
  }
  if (requested || !nativeAgentCapabilities(session.agent).composer.mode) return requested;
  // Several providers persist a prompt's mode on the session.
  const current =
    session.record?.controls?.mode ??
    context.command.nativeAgents?.cachedProjectionSnapshot(
      session.environment.id,
      session.agent,
      session.logicalSessionKey,
    )?.composer?.selectedModeId;
  return current === "plan" || current === "build" ? current : "build";
}

const sessionPrompt: MutationActionHandler<PromptInput> = {
  kind: "mutation",
  action: "session.prompt",
  parse(input) {
    onlyActionKeys(input, "session.prompt");
    const target = sessionTarget(input);
    const prompt = textInput(
      input,
      "prompt",
      PUBLIC_API_LIMITS.promptMaxChars,
      PUBLIC_API_LIMITS.promptMaxBytes,
    );
    const mode = oneOf(input, "mode", ["plan", "build"] as const);
    const literal = parseLiteral(input);
    const enqueue = parseEnqueue(input);
    const attachments = parseAttachments(input);
    const value: PromptInput = {
      ...target,
      prompt,
      ...(mode ? { mode } : {}),
      ...(literal ? { literal } : {}),
      ...(enqueue ? { enqueue } : {}),
      ...(attachments ? { attachments } : {}),
    };
    return {
      value,
      scope: `session:${target.sessionId}`,
      // New fields are absent when unset, so earlier fingerprints still match.
      intent: {
        prompt,
        mode: mode ?? null,
        literal,
        enqueue,
        attachments: attachmentIntent(attachments),
      },
    };
  },
  async prepare(input, context) {
    const session = await resolveSession(context, input);
    assertSessionAcceptsPrompt(context, session, input.enqueue === true);
    assertAttachmentSupport(session.agent, input.attachments, isCoordinatorSession(session));
    const mode = sessionPromptMode(context, session, input.mode);
    const command = input.literal ? ({ kind: "literal" } as const) : undefined;
    return {
      resolved: {
        agent: session.agent,
        mode: mode ?? null,
        ...(input.enqueue ? { delivery: "queue" } : {}),
      },
      resources: {
        environmentId: session.environment.id,
        projectId: session.environment.projectId,
        sessionId: session.sessionId,
        tabId: session.tab.tabId,
      },
      async execute(operation) {
        const requestId = operation.operationId;
        await operation.update({
          stage: "staging-attachments",
          resources: { dispatchRequestId: requestId },
        });
        const attachments = await stageAttachments(
          context,
          session.environment,
          requestId,
          input.attachments,
        );
        const result = { runId: requestId, sessionId: session.sessionId };
        if (input.enqueue) {
          return enqueuePrompt(
            context,
            operation,
            session,
            {
              text: input.prompt,
              ...(mode ? { mode } : {}),
              ...(command ? { command } : {}),
              attachments,
            },
            result,
          );
        }
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
            ...(command ? { command } : {}),
            ...(attachments.length ? { attachments } : {}),
          },
        );
        return dispatchOutcome(outcome.outcome, outcome.error, result);
      },
    };
  },
};

export const SESSION_HANDLERS: PublicActionHandler[] = [sessionStart, sessionPrompt];
