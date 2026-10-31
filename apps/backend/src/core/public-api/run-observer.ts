import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { coordinatorIdFromRuntimeId } from "@orkestrator/protocol/coordinator";
import type { PublicExecutionState, PublicInteractionRef } from "@orkestrator/protocol/public-api";
import {
  decodePublicSessionId,
  nativeTabLogicalSessionKey,
} from "@orkestrator/protocol/public-api-resources";
import { openCoordinatorConversation } from "../coordinator-runtime.js";
import { nativeAgentSessionStorageKey } from "../native-agent-service-shared.js";
import type { PublicOperationRecord } from "./operation-ledger.js";
import { nativePromptQueueKey } from "./prompt-delivery.js";
import { PROVIDER_COMPLETION } from "./providers.js";
import { registerReconciler } from "./reconciler.js";
import { nativeTabsOfLayout } from "./summaries.js";
import type { OperationPatch, PublicActionContext } from "./types.js";

/**
 * Request-specific execution state of one prompt run.
 *
 * A run is identified by its dispatch request ID. It settles only on evidence
 * about *that* request: the dispatch journal (`pendingDispatch`,
 * `dispatchedRequestIds`), the backend's observation of the session's turn
 * activity, and the per-request turn outcome record. An idle environment,
 * another tab's completion, a dropped client, or the agent's wording are
 * never evidence. When the evidence is missing the run stays `unknown`.
 */

const MAX_INTERACTIONS = 16;

interface RunTarget {
  environmentId: string;
  tabId: string;
  agent: AgentPlatform;
  logicalSessionKey: string;
  requestId: string;
}

async function runTarget(
  record: PublicOperationRecord,
  context: PublicActionContext,
): Promise<RunTarget | null> {
  const requestId = record.resources.dispatchRequestId;
  const decoded = decodePublicSessionId(record.resources.sessionId);
  if (!requestId || !decoded) return null;
  const storage = context.command.storage;
  const coordinator = await openCoordinatorConversation(storage, decoded.environmentId);
  const layout = coordinator ? null : await storage.getPaneLayout(decoded.environmentId);
  const tab = nativeTabsOfLayout(layout).find((candidate) => candidate.tabId === decoded.tabId);
  const agent =
    coordinator?.conversation.agent ??
    tab?.agent ??
    (record.resolved?.agent as AgentPlatform | undefined);
  if (!agent) return null;
  return {
    environmentId: decoded.environmentId,
    tabId: decoded.tabId,
    agent,
    logicalSessionKey: nativeTabLogicalSessionKey(decoded.environmentId, decoded.tabId),
    requestId,
  };
}

/**
 * Observe one run. Concurrent observers of the same operation share one
 * evaluation, so N waiting clients cause at most one provider status read.
 */
export function observeRun(
  record: PublicOperationRecord,
  context: PublicActionContext,
): Promise<OperationPatch | null> {
  return context.command.runtime.publicApi.observeRun(record.operationId, () =>
    evaluateRun(record, context),
  );
}

function sameExecution(a: PublicExecutionState | undefined, b: PublicExecutionState): boolean {
  return (
    JSON.stringify({ ...a, observedAt: undefined }) ===
    JSON.stringify({ ...b, observedAt: undefined })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A run admitted with `enqueue` waits in the session's durable prompt queue
 * under its own operation ID. It settles from the queue and the dispatch
 * journal only: still held → pending; journaled → observed like any other
 * run; parked → unknown (retry or discard); refused at dequeue → failed with
 * the provider's reason; gone without being sent → cancelled (someone
 * removed it). The queue is read before the session because the drainer
 * journals a dispatch on the session before it acknowledges the queue item.
 */
async function evaluateQueuedRun(
  record: PublicOperationRecord,
  context: PublicActionContext,
): Promise<OperationPatch | null> {
  const target = await runTarget(record, context);
  const observedAt = new Date(context.now()).toISOString();
  if (!target) {
    return {
      state: "interrupted",
      stage: "completed",
      execution: { state: "interrupted", evidence: "none", observedAt },
      error: { code: "run-interrupted", message: "The run's session no longer exists" },
    };
  }
  const storage = context.command.storage;
  const id = target.requestId;
  const queue = await storage.getPromptQueue(
    nativePromptQueueKey(target.agent, target.logicalSessionKey),
  );
  const refused = queue?.dispatchError;
  if (refused && (refused.requestId === id || refused.messageId === id)) {
    const message = refused.message.slice(0, 500);
    return {
      state: "failed",
      stage: "completed",
      dispatch: { state: "rejected", origin: "provider", error: message },
      execution: { state: "failed", evidence: "none", error: message, observedAt },
      error: { code: "operation-failed", message },
    };
  }
  const held = [
    ...(queue?.messages ?? []),
    queue?.outstandingClaim?.message,
    queue?.inFlight?.message,
  ].some((message) => isRecord(message) && message.id === id);
  const session = await storage.getNativeAgentSession(
    nativeAgentSessionStorageKey(target.environmentId, target.agent, target.logicalSessionKey),
  );
  if (session?.dispatchedRequestIds?.includes(id)) {
    const accepted = { ...record, dispatch: { state: "accepted" as const }, stage: "executing" };
    const observed = await evaluateRun(accepted, context);
    return { ...observed, dispatch: { state: "accepted" }, stage: observed?.stage ?? "executing" };
  }
  if (
    coordinatorIdFromRuntimeId(target.environmentId) &&
    !(await openCoordinatorConversation(storage, target.environmentId))
  ) {
    // A closed owner can never drain again. Retire its queue, including any
    // held claim, rather than leaving work pending or eligible for retry.
    await storage.deletePromptQueuesByEnvironment(target.environmentId);
    return {
      state: "interrupted",
      stage: "completed",
      dispatch: { state: session?.pendingDispatch?.requestId === id ? "unknown" : "not-sent" },
      execution: {
        state: "interrupted",
        evidence: "none",
        reason: "The Coordinator conversation was closed",
        observedAt,
      },
      error: { code: "run-interrupted", message: "The Coordinator conversation was closed" },
    };
  }
  if (session?.pendingDispatch?.requestId === id) {
    return {
      state: "unknown",
      stage: "dispatching",
      dispatch: { state: "unknown", recoverable: true },
      execution: {
        state: "unknown",
        evidence: "none",
        reason: "Dispatch is not confirmed; retry or discard it",
        observedAt,
      },
    };
  }
  if (held) {
    return record.stage === "queued" ? null : { stage: "queued", dispatch: { state: "pending" } };
  }
  if (record.stage === "queueing" && record.generation === context.generation) {
    // Still being written by the request that admitted it.
    return null;
  }
  if (record.stage === "queueing") {
    return {
      state: "interrupted",
      stage: "completed",
      dispatch: { state: "not-sent" },
      execution: { state: "interrupted", evidence: "none", observedAt },
      error: {
        code: "run-interrupted",
        message: "The backend restarted before the prompt was queued; nothing was sent",
      },
    };
  }
  return {
    state: "cancelled",
    stage: "completed",
    dispatch: { state: "not-sent" },
    execution: {
      state: "cancelled",
      evidence: "none",
      reason: "The queued prompt was removed before it was sent",
      observedAt,
    },
    error: { code: "run-cancelled", message: "The queued prompt was removed before it was sent" },
  };
}

async function evaluateRun(
  record: PublicOperationRecord,
  context: PublicActionContext,
): Promise<OperationPatch | null> {
  if (record.stage === "staging-attachments") {
    if (record.generation === context.generation) return null;
    return {
      state: "interrupted",
      stage: "completed",
      dispatch: { state: "not-sent" },
      execution: {
        state: "interrupted",
        evidence: "none",
        observedAt: new Date(context.now()).toISOString(),
      },
      error: {
        code: "run-interrupted",
        message: "The backend restarted while staging attachments; nothing was sent or queued",
      },
    };
  }
  if (record.dispatch?.state === "pending" || record.stage === "queueing") {
    return evaluateQueuedRun(record, context);
  }
  if (record.dispatch?.state !== "accepted" && record.dispatch?.state !== "unknown") {
    if (record.generation === context.generation) return null;
    const target = await runTarget(record, context);
    if (!target) {
      return {
        state: "interrupted",
        stage: "completed",
        dispatch: { state: "not-sent" },
        error: {
          code: "run-interrupted",
          message: "No session was created before the backend restarted; nothing was sent",
        },
      };
    }
    const session = await context.command.storage.getNativeAgentSession(
      nativeAgentSessionStorageKey(target.environmentId, target.agent, target.logicalSessionKey),
    );
    if (session?.pendingDispatch?.requestId === target.requestId) {
      return {
        state: "unknown",
        dispatch: { state: "unknown", recoverable: true },
        stage: "dispatching",
      };
    }
    if (session?.dispatchedRequestIds?.includes(target.requestId)) {
      const observed = await evaluateRun({ ...record, dispatch: { state: "accepted" } }, context);
      return { ...observed, dispatch: { state: "accepted" } };
    }
    return {
      state: "interrupted",
      stage: "completed",
      dispatch: { state: "not-sent" },
      error: {
        code: "run-interrupted",
        message: "No dispatch was recorded before the backend restarted",
      },
    };
  }
  const target = await runTarget(record, context);
  const observedAt = new Date(context.now()).toISOString();
  const settle = (
    execution: PublicExecutionState,
    patch: OperationPatch = {},
  ): OperationPatch | null => {
    const next = { ...execution, observedAt };
    const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(execution.state);
    if (!terminal && sameExecution(record.execution, next) && !patch.dispatch) return null;
    return {
      execution: next,
      ...patch,
      ...(terminal
        ? {
            state:
              execution.state === "completed"
                ? "succeeded"
                : execution.state === "failed"
                  ? "failed"
                  : execution.state === "cancelled"
                    ? "cancelled"
                    : "interrupted",
            stage: "completed",
            ...(execution.state === "failed"
              ? {
                  error: {
                    code: "run-failed" as const,
                    message: execution.error ?? "The agent turn failed",
                  },
                }
              : execution.state === "cancelled"
                ? {
                    error: {
                      code: "run-cancelled" as const,
                      message: execution.reason ?? "The turn was stopped",
                    },
                  }
                : execution.state === "interrupted"
                  ? {
                      error: {
                        code: "run-interrupted" as const,
                        message: execution.reason ?? "The run was interrupted",
                      },
                    }
                  : {}),
          }
        : {}),
    };
  };
  if (!target) {
    return settle({
      state: "interrupted",
      evidence: "none",
      reason: "The run's session no longer exists",
    });
  }
  const storage = context.command.storage;
  // A Coordinator has no environment row; its conversation is what can go away.
  const coordinator = coordinatorIdFromRuntimeId(target.environmentId) !== null;
  const owner = coordinator
    ? await openCoordinatorConversation(storage, target.environmentId)
    : await storage.getEnvironment(target.environmentId);
  if (!owner) {
    return settle({
      state: "interrupted",
      evidence: "none",
      reason: coordinator
        ? "The Coordinator conversation was closed"
        : "The environment was deleted",
    });
  }
  const session = await storage.getNativeAgentSession(
    nativeAgentSessionStorageKey(target.environmentId, target.agent, target.logicalSessionKey),
  );
  const native = context.command.nativeAgents;
  if (!session || !native) {
    return settle({
      state: "unknown",
      evidence: "none",
      reason: "The session is not available to observe",
    });
  }
  const dispatched = session.dispatchedRequestIds ?? [];
  const position = dispatched.lastIndexOf(target.requestId);
  const parked = session.pendingDispatch?.requestId === target.requestId;

  if (parked) {
    // Possibly delivered, not confirmed. Only retry (same key) or discard move it.
    return settle(
      {
        state: "unknown",
        evidence: "none",
        reason: "Dispatch is not confirmed; retry or discard it",
      },
      { state: "unknown", dispatch: { state: "unknown", recoverable: true } },
    );
  }
  if (position < 0) {
    if (record.dispatch?.state === "unknown") {
      // No longer parked and never journaled as dispatched: the recovery
      // record was discarded. It may still have run; that is not knowable.
      return settle(
        {
          state: "interrupted",
          evidence: "none",
          reason: "The unconfirmed dispatch was discarded; the turn may or may not have run",
        },
        { dispatch: { state: "unknown", recoverable: false } },
      );
    }
    // Accepted but rolled out of the bounded journal: 1,000 later prompts
    // means this turn has certainly ended; only its outcome record can say how.
  }
  const accepted =
    record.dispatch?.state === "unknown" ? { dispatch: { state: "accepted" as const } } : {};
  const rolledOver = position < 0;
  const laterTurn = rolledOver || position < dispatched.length - 1;
  const activity = native.sessionTurnActivitySnapshot(
    target.environmentId,
    target.agent,
    target.logicalSessionKey,
  );

  // Request-scoped durable evidence survives idle observations and later turns.
  if (!record.stopRequestedAt && session.interruptedRequestIds?.includes(target.requestId)) {
    return settle(
      {
        state: "interrupted",
        evidence: "none",
        reason: "The turn was interrupted by a stop; changes made before the stop may remain",
      },
      accepted,
    );
  }

  if (!laterTurn && activity === "waiting") {
    const requests = await native
      .sessionPendingInteractions({
        environmentId: target.environmentId,
        agent: target.agent,
        logicalSessionKey: target.logicalSessionKey,
      })
      .catch(() => null);
    // An answered question (`answering`) no longer needs input; if a fresh
    // read shows nothing pending, the activity snapshot is just behind and the
    // turn is resuming.
    const pending = requests?.filter((request) => request.state === "pending");
    if (pending && pending.length === 0) return settle({ state: "running" }, accepted);
    const interactions: PublicInteractionRef[] = (pending ?? [])
      .slice(0, MAX_INTERACTIONS)
      .map((request) => ({
        id: request.id,
        kind: request.kind,
        revision: request.revision,
        blocking: request.blocking !== false,
        ...(typeof request.expiresAt === "number" ? { expiresAt: request.expiresAt } : {}),
      }));
    return settle({ state: "waiting-for-input", interactions }, accepted);
  }
  // Steering input for the running turn also joins the journal, so a later
  // ID while the session is busy does not prove this turn ended.
  const ended = activity === "idle" || (laterTurn && activity === "unknown") || rolledOver;
  if (!ended) {
    return settle({ state: activity === "working" || laterTurn ? "running" : "pending" }, accepted);
  }

  let outcome = session.turnOutcomes?.find((entry) => entry.requestId === target.requestId) ?? null;
  if (
    !outcome &&
    !laterTurn &&
    !record.stopRequestedAt &&
    native.sessionStoppedMidTurn(target.environmentId, target.agent, target.logicalSessionKey)
  ) {
    // The runtime stopped under the turn and took its bridge with it, so no
    // outcome can be read any more. It did not finish here; whether it would
    // have is unknowable.
    return settle(
      {
        state: "interrupted",
        evidence: "none",
        reason:
          "The environment stopped while the turn was running; changes made before the stop may remain",
      },
      accepted,
    );
  }
  let evidence: PublicExecutionState["evidence"] = outcome ? "turn-outcome-record" : "none";
  if (!outcome && !laterTurn) {
    const read = await native
      .sessionTurnOutcome({
        environmentId: target.environmentId,
        agent: target.agent,
        logicalSessionKey: target.logicalSessionKey,
        requestId: target.requestId,
      })
      .catch(() => ({ outcome: "unknown" as const }));
    if (read.outcome === "pending") return settle({ state: "running" }, accepted);
    if (read.outcome === "completed" || read.outcome === "failed") {
      outcome = {
        requestId: target.requestId,
        outcome: read.outcome,
        ...("error" in read && read.error ? { error: read.error } : {}),
        observedAt,
      };
      evidence = "provider-status";
    }
  }
  if (record.stopRequestedAt && activity === "idle") {
    return settle(
      {
        state: "cancelled",
        evidence: outcome ? evidence : "provider-status",
        reason: "Stopped by request; changes made before the stop may remain",
      },
      accepted,
    );
  }
  if (!outcome) {
    return settle(
      {
        state: "unknown",
        evidence: "none",
        reason: "The turn ended but its outcome was not recorded",
      },
      { state: "unknown", ...accepted },
    );
  }
  if (PROVIDER_COMPLETION[target.agent].support !== "qualified") {
    // The turn ended, but this provider's completion mapping is not
    // qualified: say so instead of claiming success or failure.
    return settle(
      {
        state: "unsupported",
        evidence,
        reason: `${target.agent} completion evidence is not qualified; inspect the transcript`,
      },
      {
        ...accepted,
        state: "unknown",
        error: {
          code: "capability-unavailable",
          message: `Completion of ${target.agent} runs is not qualified`,
        },
      },
    );
  }
  if (record.stopRequestedAt) {
    return settle(
      {
        state: "cancelled",
        evidence,
        reason: "Stopped by request; changes made before the stop may remain",
      },
      accepted,
    );
  }
  if (outcome.outcome === "failed") {
    return settle(
      { state: "failed", evidence, error: outcome.error?.slice(0, 500) ?? "The agent turn failed" },
      accepted,
    );
  }
  return settle({ state: "completed", evidence }, accepted);
}

// `environment.launch` observes runs too, but registers its own reconciler in
// `actions-launch.ts`, which imports this module.
for (const action of [
  "session.start",
  "session.prompt",
  "session.command",
  "pr.create",
  "pr.resolve",
] as const) {
  registerReconciler(action, observeRun);
}
