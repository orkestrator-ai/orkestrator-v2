import { createHash } from "node:crypto";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  isAgentInteractionResolution,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import type {
  NativeAgentComposerState,
  NativeAgentSessionProjection,
} from "@orkestrator/protocol/native-agent";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import {
  encodePublicSessionId,
  nativeTabLogicalSessionKey,
  type PublicInteraction,
  type PublicInteractionAnswerInput,
} from "@orkestrator/protocol/public-api-resources";
import { loadOperation } from "./actions-runs.js";
import { assertReadyForAgents } from "./actions-sessions.js";
import { PublicActionError } from "./errors.js";
import {
  invalid,
  oneOf,
  onlyKeys,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requiredString,
  sessionTarget,
  textInput,
} from "./input.js";
import type { PublicOperationRecord } from "./operation-ledger.js";
import { providerCapabilities } from "./providers.js";
import { resolveSession, sessionActivity, type ResolvedSession } from "./sessions.js";
import type {
  MutationActionHandler,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * Controls that act on one live conversation. Every one targets an exact
 * session; stop and steer can additionally be bound to an expected run so a
 * stale script cannot affect a turn it did not start. Nothing here approves
 * an interaction implicitly, and a stop is only reported as successful when
 * the provider confirms the turn ended.
 */

function triple(session: ResolvedSession) {
  return {
    environmentId: session.environment.id,
    agent: session.agent,
    logicalSessionKey: session.logicalSessionKey,
  };
}

function requireProviderSession(session: ResolvedSession): void {
  if (!session.record)
    throw new PublicActionError("not-ready", "The session has no provider conversation yet");
}

/** Check that `expectedOperationId` names this session's active run. */
async function assertExpectedRun(
  context: PublicActionContext,
  session: ResolvedSession,
  expectedOperationId: string | undefined,
): Promise<PublicOperationRecord | null> {
  const latest = session.record?.dispatchedRequestIds?.at(-1) ?? null;
  if (!expectedOperationId) return null;
  const run = await loadOperation(context, expectedOperationId);
  if (run.resources.sessionId !== session.sessionId || !run.resources.dispatchRequestId) {
    throw new PublicActionError("target-mismatch", "That run does not belong to this session");
  }
  if (run.resources.dispatchRequestId !== latest) {
    throw new PublicActionError(
      "target-mismatch",
      "A newer turn has started since that run; refusing to act on it",
      {
        details: { expected: expectedOperationId },
      },
    );
  }
  return run;
}

async function activeRunFor(
  context: PublicActionContext,
  session: ResolvedSession,
): Promise<PublicOperationRecord | null> {
  const latest = session.record?.dispatchedRequestIds?.at(-1);
  if (!latest) return null;
  const active = await context.command.storage.listActivePublicOperations();
  return (
    active.find(
      (record) =>
        record.resources.sessionId === session.sessionId &&
        record.resources.dispatchRequestId === latest,
    ) ?? null
  );
}

interface TargetInput {
  sessionId: string;
  environmentId: string;
  tabId: string;
  expectedOperationId?: string;
}

const sessionStop: MutationActionHandler<TargetInput> = {
  kind: "mutation",
  action: "session.stop",
  parse(input) {
    onlyKeys(input, ["sessionId", "expectedOperationId"]);
    const target = sessionTarget(input);
    const expectedOperationId = optionalString(input, "expectedOperationId", 100);
    return {
      value: { ...target, ...(expectedOperationId ? { expectedOperationId } : {}) },
      scope: `session:${target.sessionId}`,
      intent: { expectedOperationId: expectedOperationId ?? null },
    };
  },
  async prepare(input, context) {
    const session = await resolveSession(context, input);
    requireProviderSession(session);
    const expected = await assertExpectedRun(context, session, input.expectedOperationId);
    const activity = sessionActivity(context, triple(session));
    if (activity === "idle") {
      throw new PublicActionError("session-idle", "No turn is running in this session");
    }
    return {
      resources: {
        environmentId: session.environment.id,
        sessionId: session.sessionId,
        tabId: session.tab.tabId,
      },
      async execute(operation) {
        const run = expected ?? (await activeRunFor(context, session));
        if (run) {
          // The run settles as cancelled (not completed) once its turn ends.
          await context.command.storage.updatePublicOperation(run.operationId, (current) =>
            current.stopRequestedAt
              ? null
              : { ...current, stopRequestedAt: new Date(context.now()).toISOString() },
          );
          await operation.update({
            resources: { dispatchRequestId: run.resources.dispatchRequestId },
          });
        }
        await operation.update({ stage: "stopping" });
        const projection = await context.invoke<NativeAgentSessionProjection | null>(
          "stop_native_agent_session",
          triple(session),
        );
        const phase = projection?.turn.phase;
        const result = {
          sessionId: session.sessionId,
          ...(run ? { runId: run.operationId } : {}),
          turn: phase ?? "unknown",
        };
        if (phase === "idle" || phase === "error") {
          return { state: "succeeded", result: { ...result, acknowledged: true } };
        }
        return {
          state: "unknown",
          result: { ...result, acknowledged: false },
          error: {
            code: "run-unknown",
            message: "The stop was sent but the provider has not confirmed the turn ended",
          },
        };
      },
    };
  },
};

const sessionSteer: MutationActionHandler<TargetInput & { text: string }> = {
  kind: "mutation",
  action: "session.steer",
  parse(input) {
    onlyKeys(input, ["sessionId", "text", "expectedOperationId"]);
    const target = sessionTarget(input);
    const text = textInput(
      input,
      "text",
      PUBLIC_API_LIMITS.steerMaxBytes,
      PUBLIC_API_LIMITS.steerMaxBytes,
    );
    const expectedOperationId = optionalString(input, "expectedOperationId", 100);
    return {
      value: { ...target, text, ...(expectedOperationId ? { expectedOperationId } : {}) },
      scope: `session:${target.sessionId}`,
      intent: { text, expectedOperationId: expectedOperationId ?? null },
    };
  },
  async prepare(input, context) {
    const session = await resolveSession(context, input);
    requireProviderSession(session);
    if (!providerCapabilities(session.agent).steer) {
      // Never downgraded to an ordinary prompt.
      throw new PublicActionError(
        "capability-unavailable",
        `${session.agent} sessions cannot be steered`,
      );
    }
    await assertExpectedRun(context, session, input.expectedOperationId);
    return {
      resources: {
        environmentId: session.environment.id,
        sessionId: session.sessionId,
        tabId: session.tab.tabId,
      },
      async execute(operation) {
        await operation.update({ stage: "steering" });
        const outcome = await context.invoke<{ outcome: string; requestId?: string }>(
          "perform_native_agent_session_action",
          { ...triple(session), action: { kind: "steer", text: input.text } },
        );
        const resources = outcome.requestId ? { dispatchRequestId: outcome.requestId } : {};
        if (outcome.outcome === "applied") {
          return {
            state: "succeeded",
            result: { sessionId: session.sessionId },
            resources,
            dispatch: { state: "accepted" },
          };
        }
        if (outcome.outcome === "idle") {
          return {
            state: "failed",
            resources,
            error: { code: "session-idle", message: "No turn was running to steer" },
          };
        }
        if (outcome.outcome === "mismatch") {
          return {
            state: "failed",
            resources,
            error: {
              code: "target-mismatch",
              message: "The active turn changed before the steer arrived",
            },
          };
        }
        return {
          state: "unknown",
          resources,
          dispatch: { state: "unknown", recoverable: true },
          error: {
            code: "dispatch-unknown",
            message: "The steer may have been delivered; retry or discard it",
          },
          retryable: true,
        };
      },
    };
  },
};

function effectiveControls(composer: NativeAgentComposerState | undefined) {
  return {
    model: composer?.selectedModelId ?? null,
    reasoning: composer?.selectedReasoningId ?? null,
    fastMode: composer?.fastModeEnabled ?? null,
    fastModeAvailable: composer?.fastModeAvailable ?? false,
    mode: composer?.selectedModeId ?? null,
    modes: (composer?.modes ?? []).map((mode) => mode.id),
    models: (composer?.models ?? []).slice(0, 200).map((model) => ({
      id: model.id,
      reasoning: (model.reasoning ?? []).map((option) => option.id),
    })),
  };
}

const sessionConfigGet: ReadActionHandler<TargetInput> = {
  kind: "read",
  action: "session.config.get",
  parse(input) {
    onlyKeys(input, ["sessionId"]);
    return sessionTarget(input);
  },
  async run(input, context) {
    const session = await resolveSession(context, input);
    requireProviderSession(session);
    const update = await context.invoke<{
      status?: string;
      value?: { composer?: NativeAgentComposerState };
    }>("get_native_agent_session_state_update", {
      ...triple(session),
      viewVersion: 1,
      forceSnapshot: true,
    });
    if (update?.status === "missing")
      throw new PublicActionError("not-found", "The session no longer exists");
    if (update?.status !== "snapshot") {
      throw new PublicActionError(
        "connection-failed",
        "The session's controls are unavailable right now",
        { retryable: true },
      );
    }
    return {
      result: {
        sessionId: session.sessionId,
        scope: "live-session",
        ...effectiveControls(update.value?.composer),
      },
    };
  },
};

const sessionConfigSet: MutationActionHandler<TargetInput & { update: Record<string, unknown> }> = {
  kind: "mutation",
  action: "session.config.set",
  parse(input) {
    onlyKeys(input, ["sessionId", "model", "reasoning", "fastMode", "mode"]);
    const target = sessionTarget(input);
    const update: Record<string, unknown> = {};
    const model = optionalString(input, "model", 500);
    const reasoning = optionalString(input, "reasoning", 100);
    const fastMode = optionalBoolean(input, "fastMode");
    const mode = oneOf(input, "mode", ["plan", "build"] as const);
    if (model !== undefined) update.modelId = model;
    if (reasoning !== undefined) update.reasoningId = reasoning;
    if (fastMode !== undefined) update.fastMode = fastMode;
    if (mode !== undefined) update.mode = mode;
    if (Object.keys(update).length === 0) throw invalid("Nothing to change");
    return { value: { ...target, update }, scope: `session:${target.sessionId}`, intent: update };
  },
  async prepare(input, context) {
    const session = await resolveSession(context, input);
    requireProviderSession(session);
    assertReadyForAgents(session.environment);
    const controls = providerCapabilities(session.agent).controls;
    for (const [key, supported] of [
      ["modelId", controls.model],
      ["reasoningId", controls.reasoning],
      ["fastMode", controls.speed],
      ["mode", controls.mode],
    ] as const) {
      if (key in input.update && !supported) {
        throw new PublicActionError(
          "capability-unavailable",
          `${session.agent} sessions do not support changing ${key}`,
        );
      }
    }
    return {
      resources: {
        environmentId: session.environment.id,
        sessionId: session.sessionId,
        tabId: session.tab.tabId,
      },
      async execute() {
        let projection: NativeAgentSessionProjection | null;
        try {
          projection = await context.invoke<NativeAgentSessionProjection | null>(
            "update_native_agent_controls",
            {
              ...triple(session),
              update: input.update,
            },
          );
        } catch (error) {
          return {
            state: "failed",
            error: {
              code: "unsupported",
              message: error instanceof Error ? error.message.slice(0, 500) : "Rejected",
            },
          };
        }
        // Report what the provider actually applied; it may clamp a request.
        return {
          state: "succeeded",
          result: {
            sessionId: session.sessionId,
            scope: "live-session",
            ...effectiveControls(projection?.composer),
          },
        };
      },
    };
  },
};

const sessionHistory: ReadActionHandler<TargetInput> = {
  kind: "read",
  action: "session.history",
  parse(input) {
    onlyKeys(input, ["sessionId"]);
    return sessionTarget(input);
  },
  async run(input, context) {
    const session = await resolveSession(context, input);
    if (!providerCapabilities(session.agent).resume) {
      throw new PublicActionError(
        "capability-unavailable",
        `${session.agent} sessions cannot resume history`,
      );
    }
    const entries = await context.invoke<Array<Record<string, unknown>>>(
      "list_native_agent_resumable_sessions",
      triple(session),
    );
    const items = (Array.isArray(entries) ? entries : [])
      .slice(0, PUBLIC_API_LIMITS.historyMaxEntries)
      .map((entry) => ({
        id: String(entry.sessionId),
        title: typeof entry.title === "string" ? entry.title.slice(0, 200) : null,
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : null,
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
        status: typeof entry.status === "string" ? entry.status : null,
      }));
    return { result: { items, total: items.length } };
  },
};

const sessionResume: MutationActionHandler<TargetInput & { historyId: string }> = {
  kind: "mutation",
  action: "session.resume",
  parse(input) {
    onlyKeys(input, ["sessionId", "historyId"]);
    const target = sessionTarget(input);
    const historyId = requiredString(input, "historyId", 500);
    return {
      value: { ...target, historyId },
      scope: `session:${target.sessionId}`,
      intent: { historyId },
    };
  },
  async prepare(input, context) {
    const session = await resolveSession(context, input);
    assertReadyForAgents(session.environment);
    if (!providerCapabilities(session.agent).resume) {
      throw new PublicActionError(
        "capability-unavailable",
        `${session.agent} sessions cannot resume history`,
      );
    }
    const history = await context.invoke<Array<{ sessionId?: string }>>(
      "list_native_agent_resumable_sessions",
      triple(session),
    );
    if (!Array.isArray(history) || !history.some((entry) => entry.sessionId === input.historyId)) {
      throw new PublicActionError(
        "not-found",
        "That history entry is not resumable from this session",
      );
    }
    return {
      resources: {
        environmentId: session.environment.id,
        sessionId: session.sessionId,
        tabId: session.tab.tabId,
      },
      async execute() {
        // Rebinds this tab; the conversation being left keeps its history.
        await context.invoke("resume_native_agent_session", {
          ...triple(session),
          providerSessionId: input.historyId,
        });
        return {
          state: "succeeded",
          result: { sessionId: session.sessionId, resumed: input.historyId },
        };
      },
    };
  },
};

const sessionFork: MutationActionHandler<TargetInput & { messageId?: string }> = {
  kind: "mutation",
  action: "session.fork",
  parse(input) {
    onlyKeys(input, ["sessionId", "messageId"]);
    const target = sessionTarget(input);
    const messageId = optionalString(input, "messageId", 500);
    return {
      value: { ...target, ...(messageId ? { messageId } : {}) },
      scope: `session:${target.sessionId}`,
      intent: { messageId: messageId ?? null },
    };
  },
  async prepare(input, context) {
    const session = await resolveSession(context, input);
    requireProviderSession(session);
    assertReadyForAgents(session.environment);
    if (!providerCapabilities(session.agent).fork) {
      throw new PublicActionError(
        "capability-unavailable",
        `${session.agent} sessions cannot be forked`,
      );
    }
    return {
      resources: { environmentId: session.environment.id },
      async execute(operation) {
        await operation.update({ stage: "forking" });
        const fork = await context.invoke<{ sessionId: string; title?: string }>(
          "fork_native_agent_session",
          {
            ...triple(session),
            ...(input.messageId ? { messageId: input.messageId } : {}),
          },
        );
        // A fork is a new public session: its own tab adopting the forked
        // provider conversation. The source keeps its history untouched.
        const tabId = `agent-fork-${createHash("sha256").update(operation.operationId).digest("hex").slice(0, 24)}`;
        await operation.update({ stage: "adopting" });
        await context.command.storage.ensureNativeAgentJobTab({
          environmentId: session.environment.id,
          tabId,
          agent: session.agent,
          providerSessionId: fork.sessionId,
          ...(fork.title ? { title: fork.title.slice(0, 200) } : {}),
          activate: false,
        });
        await context.invoke("adopt_native_agent_session", {
          environmentId: session.environment.id,
          agent: session.agent,
          logicalSessionKey: nativeTabLogicalSessionKey(session.environment.id, tabId),
          providerSessionId: fork.sessionId,
          origin: "interactive-native",
        });
        const sessionId = encodePublicSessionId(session.environment.id, tabId);
        return {
          state: "succeeded",
          result: { sessionId, tabId, forkedFrom: session.sessionId },
          resources: { sessionId, tabId },
        };
      },
    };
  },
};

function allowedActions(request: AgentInteractionRequest): PublicInteraction["actions"] {
  const actions: PublicInteraction["actions"] = ["answer"];
  if (request.presentation.approveForSessionLabel) actions.push("approve-for-session");
  if (
    [
      "question",
      "mcp-form",
      "mcp-url",
      "elicitation",
      "terminal-selection",
      "plan-approval",
    ].includes(request.kind)
  ) {
    actions.push("decline");
  }
  if (request.kind !== "question") actions.push("deny");
  actions.push("cancel");
  return actions;
}

function publicInteraction(sessionId: string, request: AgentInteractionRequest): PublicInteraction {
  return {
    id: request.id,
    sessionId,
    kind: request.kind,
    state: request.state,
    revision: request.revision,
    blocking: request.blocking !== false,
    ...(typeof request.expiresAt === "number" ? { expiresAt: request.expiresAt } : {}),
    title: request.presentation.title.slice(0, 500),
    ...(request.presentation.body ? { body: request.presentation.body.slice(0, 4_000) } : {}),
    questions: request.presentation.questions.slice(0, 16).map((question) => ({
      id: question.id,
      prompt: question.prompt.slice(0, 2_000),
      required: question.required,
      multiple: question.multiple,
      secret: question.secret,
      allowFreeText: question.allowFreeText,
      options: question.options.slice(0, 32).map((option) => ({
        id: option.id,
        label: option.label.slice(0, 200),
        ...(option.description ? { description: option.description.slice(0, 500) } : {}),
      })),
    })),
    actions: allowedActions(request),
    createdAt: request.createdAt,
  };
}

async function pendingInteractions(
  context: PublicActionContext,
  session: ResolvedSession,
): Promise<AgentInteractionRequest[]> {
  const native = context.command.nativeAgents;
  if (!native)
    throw new PublicActionError("capability-unavailable", "Native sessions are unavailable");
  const requests = await native.sessionPendingInteractions(triple(session));
  if (requests === null) {
    throw new PublicActionError(
      "connection-failed",
      "Pending interactions cannot be read right now",
      { retryable: true },
    );
  }
  return requests.filter((request) => request.state === "pending" || request.state === "answering");
}

const sessionInteractions: ReadActionHandler<TargetInput> = {
  kind: "read",
  action: "session.interactions",
  parse(input) {
    onlyKeys(input, ["sessionId"]);
    return sessionTarget(input);
  },
  async run(input, context) {
    const session = await resolveSession(context, input);
    const requests = await pendingInteractions(context, session);
    const items = requests
      .slice(0, PUBLIC_API_LIMITS.interactionsMax)
      .map((request) => publicInteraction(session.sessionId, request));
    return { result: { items, total: requests.length } };
  },
};

interface ResolveInput extends TargetInput {
  interactionId: string;
  expectedRevision: number;
  action: AgentInteractionResolution["action"];
  answers?: PublicInteractionAnswerInput[];
  feedback?: string;
}

const interactionResolve: MutationActionHandler<ResolveInput> = {
  kind: "mutation",
  action: "session.interaction.resolve",
  parse(input) {
    onlyKeys(input, [
      "sessionId",
      "interactionId",
      "expectedRevision",
      "action",
      "answers",
      "feedback",
    ]);
    const target = sessionTarget(input);
    const interactionId = requiredString(input, "interactionId", 512);
    const expectedRevision = optionalInteger(input, "expectedRevision", 0, Number.MAX_SAFE_INTEGER);
    if (expectedRevision === undefined) throw invalid("expectedRevision is required");
    const action = oneOf(input, "action", [
      "answer",
      "approve-for-session",
      "decline",
      "deny",
      "cancel",
    ] as const);
    if (!action) throw invalid("action is required");
    let answers: PublicInteractionAnswerInput[] | undefined;
    if (input.answers !== undefined) {
      if (!Array.isArray(input.answers) || input.answers.length > 32)
        throw invalid("answers must be an array");
      answers = input.answers.map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw invalid("answers must contain objects");
        const answer = raw as Record<string, unknown>;
        onlyKeys(answer, ["questionId", "optionIds", "freeText"]);
        const questionId = requiredString(answer, "questionId", 512);
        const optionIds = answer.optionIds;
        if (
          optionIds !== undefined &&
          (!Array.isArray(optionIds) || !optionIds.every((id) => typeof id === "string"))
        ) {
          throw invalid("optionIds must be strings");
        }
        const freeText = answer.freeText;
        if (freeText !== undefined && (typeof freeText !== "string" || freeText.length > 20_000)) {
          throw invalid("freeText must be a string of at most 20000 characters");
        }
        return {
          questionId,
          ...(optionIds ? { optionIds: optionIds as string[] } : {}),
          ...(freeText !== undefined ? { freeText: freeText as string } : {}),
        };
      });
    }
    const feedback = optionalString(input, "feedback", 10_000);
    const value: ResolveInput = {
      ...target,
      interactionId,
      expectedRevision,
      action,
      ...(answers ? { answers } : {}),
      ...(feedback ? { feedback } : {}),
    };
    return {
      value,
      scope: `interaction:${target.sessionId}:${interactionId}`,
      intent: { expectedRevision, action, answers: answers ?? null, feedback: feedback ?? null },
    };
  },
  async prepare(input, context) {
    const session = await resolveSession(context, input);
    const request = (await pendingInteractions(context, session)).find(
      (candidate) => candidate.id === input.interactionId,
    );
    if (!request) {
      throw new PublicActionError(
        "interaction-stale",
        "That interaction is no longer pending (answered, withdrawn or expired)",
      );
    }
    if (request.revision !== input.expectedRevision) {
      throw new PublicActionError(
        "interaction-stale",
        "The interaction changed since it was read; list it again",
        {
          details: { currentRevision: request.revision },
        },
      );
    }
    if (typeof request.expiresAt === "number" && request.expiresAt <= context.now()) {
      throw new PublicActionError("interaction-stale", "The interaction has expired");
    }
    if (!allowedActions(request).includes(input.action)) {
      throw new PublicActionError(
        "unsupported",
        `A ${request.kind} interaction does not accept ${input.action}`,
      );
    }
    const resolution: AgentInteractionResolution = {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      interactionId: request.id,
      sessionId: request.sessionId,
      action: input.action,
      ...(input.action === "answer"
        ? {
            answer: {
              version: AGENT_INTERACTION_CONTRACT_VERSION,
              interactionId: request.id,
              sessionId: request.sessionId,
              answers: input.answers ?? [],
            },
          }
        : {}),
      ...(input.feedback ? { feedback: input.feedback } : {}),
      resolvedAt: Math.max(context.now(), request.createdAt),
    };
    // Malformed answers are refused before anything reaches the provider;
    // they are never coerced into an approval.
    if (!isAgentInteractionResolution(resolution, request)) {
      throw new PublicActionError(
        "invalid-input",
        "The answer does not match the interaction's questions or options",
      );
    }
    return {
      resources: {
        environmentId: session.environment.id,
        sessionId: session.sessionId,
        tabId: session.tab.tabId,
        interactionId: request.id,
      },
      async execute(operation) {
        await operation.update({ stage: "resolving" });
        const outcome = await context.invoke<{ result: string; revision?: number }>(
          "resolve_native_agent_interaction",
          { ...triple(session), interactionId: request.id, resolution },
        );
        if (outcome.result === "applied") {
          return { state: "succeeded", result: { interactionId: request.id, result: "applied" } };
        }
        if (outcome.result === "stale" || outcome.result === "already-resolved") {
          return {
            state: "failed",
            error: {
              code: "interaction-stale",
              message: `The interaction was ${outcome.result === "stale" ? "replaced" : "already resolved"}; nothing was answered`,
            },
          };
        }
        if (outcome.result === "provider-unavailable") {
          return {
            state: "failed",
            error: {
              code: "connection-failed",
              message: "The provider is unavailable; the interaction is still pending",
            },
            retryable: true,
          };
        }
        return {
          state: "failed",
          error: { code: "invalid-input", message: "The provider rejected the answer" },
        };
      },
    };
  },
};

export const SESSION_CONTROL_HANDLERS: PublicActionHandler[] = [
  sessionStop,
  sessionSteer,
  sessionConfigGet,
  sessionConfigSet,
  sessionHistory,
  sessionResume,
  sessionFork,
  sessionInteractions,
  interactionResolve,
];
