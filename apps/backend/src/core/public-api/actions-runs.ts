import {
  isPublicActionName,
  isPublicNamespace,
  isPublicRequestId,
  type PublicActionName,
} from "@orkestrator/protocol/public-api";
import { PublicActionError } from "./errors.js";
import { invalid, onlyKeys } from "./input.js";
import { toReceipt, type PublicOperationRecord } from "./operation-ledger.js";
import { decodePublicSessionId } from "@orkestrator/protocol/public-api-resources";
import { reconcileOperation } from "./reconciler.js";
import { resolveSession } from "./sessions.js";
import type {
  MutationActionHandler,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * Receipt reads. A read reconciles an active operation from authoritative
 * state first, so a caller never waits on a stale projection; it never
 * touches provider liveness or returns prompt text.
 */

export async function loadOperation(
  context: PublicActionContext,
  operationId: string,
): Promise<PublicOperationRecord> {
  if (!/^op-[0-9]{13}-[a-f0-9]{8}-[a-f0-9]{18}$/.test(operationId)) {
    throw new PublicActionError("not-found", "Operation ID is not valid");
  }
  const lookup = await context.command.storage.getPublicOperation(operationId);
  if (lookup.status === "expired") {
    throw new PublicActionError(
      "history-expired",
      "This operation's namespace has been retired; its outcome is no longer retained",
      { details: { namespace: lookup.namespace } },
    );
  }
  if (lookup.status === "missing") throw new PublicActionError("not-found", "Operation not found");
  return lookup.record;
}

interface RunGetInput {
  operationId?: string;
  requestId?: string;
  action?: PublicActionName;
  namespace?: string;
}

const runGet: ReadActionHandler<RunGetInput> = {
  kind: "read",
  action: "run.get",
  parse(input) {
    onlyKeys(input, ["operationId", "requestId", "action", "namespace"]);
    if (input.operationId !== undefined) {
      if (typeof input.operationId !== "string") throw invalid("operationId must be a string");
      if (
        input.requestId !== undefined ||
        input.action !== undefined ||
        input.namespace !== undefined
      ) {
        throw invalid("Pass operationId or requestId, not both");
      }
      return { operationId: input.operationId };
    }
    if (!isPublicRequestId(input.requestId)) throw invalid("Pass operationId or a valid requestId");
    if (input.action !== undefined && !isPublicActionName(input.action))
      throw invalid("action is not a public action");
    if (input.namespace !== undefined && !isPublicNamespace(input.namespace))
      throw invalid("namespace is invalid");
    return {
      requestId: input.requestId,
      ...(input.action ? { action: input.action as PublicActionName } : {}),
      ...(input.namespace ? { namespace: input.namespace as string } : {}),
    };
  },
  async run(input, context) {
    let record: PublicOperationRecord;
    if (input.operationId) {
      record = await loadOperation(context, input.operationId);
    } else {
      const found = await context.command.storage.findPublicOperationsByRequest(input.requestId!, {
        ...(input.action ? { action: input.action } : {}),
        ...(input.namespace ? { namespace: input.namespace } : {}),
      });
      if (found.expiredNamespace) {
        throw new PublicActionError(
          "history-expired",
          "That request key's namespace has been retired; its outcome is no longer retained",
          { details: { namespace: found.expiredNamespace } },
        );
      }
      if (found.records.length === 0) {
        // Not evidence that nothing ran: the request may never have reached
        // this backend, or it may belong to another installation.
        throw new PublicActionError("not-found", "No operation with that request key is retained");
      }
      if (found.records.length > 1) {
        throw new PublicActionError(
          "ambiguous-target",
          "That request key was used for several operations; pass --action",
          {
            details: {
              operations: found.records
                .map((entry) => ({ operationId: entry.operationId, action: entry.action }))
                .slice(0, 20),
            },
          },
        );
      }
      record = found.records[0]!;
    }
    const fresh = await reconcileOperation(record, context);
    return { result: null, receipt: toReceipt(fresh, false) };
  },
};

export const RUN_READ_HANDLERS: PublicActionHandler[] = [runGet];

const PROMPT_RUN_ACTIONS: readonly PublicActionName[] = [
  "session.start",
  "session.prompt",
  "environment.launch",
  "session.steer",
];

async function parkedRun(context: PublicActionContext, operationId: string) {
  const record = await loadOperation(context, operationId);
  if (
    !PROMPT_RUN_ACTIONS.includes(record.action) ||
    !record.resources.dispatchRequestId ||
    !record.resources.sessionId
  ) {
    throw new PublicActionError(
      "unsupported",
      "Only prompt and steer runs have a recoverable dispatch",
    );
  }
  const target = decodePublicSessionId(record.resources.sessionId);
  if (!target) throw new PublicActionError("not-found", "The run's session handle is invalid");
  const session = await resolveSession(context, {
    sessionId: record.resources.sessionId,
    ...target,
  });
  const requestId = record.resources.dispatchRequestId;
  const parked =
    session.record?.pendingDispatch?.requestId === requestId ||
    session.record?.pendingSteer?.requestId === requestId;
  if (!parked) {
    throw new PublicActionError("conflict", "That run has no parked dispatch to retry or discard", {
      details: { dispatch: record.dispatch?.state ?? null },
    });
  }
  return { record, session, requestId };
}

const runRetry: MutationActionHandler<{ operationId: string }> = {
  kind: "mutation",
  action: "run.retry",
  parse(input) {
    onlyKeys(input, ["operationId"]);
    const operationId = typeof input.operationId === "string" ? input.operationId : "";
    if (!operationId) throw invalid("operationId is required");
    return { value: { operationId }, scope: `operation:${operationId}`, intent: {} };
  },
  async prepare(input, context) {
    const { record, session, requestId } = await parkedRun(context, input.operationId);
    return {
      resources: {
        sessionId: session.sessionId,
        dispatchRequestId: requestId,
        environmentId: session.environment.id,
      },
      async execute() {
        // Replays the stored prompt/steer verbatim under its original request
        // ID. It never sends new text and never mints a new key.
        const outcome = await context.invoke<{ outcome: string; error?: string }>(
          "retry_native_agent_dispatch",
          {
            environmentId: session.environment.id,
            agent: session.agent,
            logicalSessionKey: session.logicalSessionKey,
            requestId,
          },
        );
        const dispatch =
          outcome.outcome === "accepted"
            ? ({ state: "accepted" } as const)
            : outcome.outcome === "unknown"
              ? ({ state: "unknown", recoverable: true } as const)
              : ({
                  state: "rejected",
                  ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
                } as const);
        await context.command.storage.updatePublicOperation(record.operationId, (current) =>
          ["admitted", "running", "unknown"].includes(current.state)
            ? {
                ...current,
                dispatch,
                state:
                  dispatch.state === "accepted"
                    ? "running"
                    : dispatch.state === "unknown"
                      ? "unknown"
                      : "failed",
                ...(dispatch.state === "rejected"
                  ? {
                      error: {
                        code: "operation-failed" as const,
                        message: dispatch.error ?? "The provider rejected the prompt",
                      },
                    }
                  : dispatch.state === "accepted"
                    ? { error: undefined }
                    : {}),
              }
            : null,
        );
        if (dispatch.state === "accepted")
          return {
            state: "succeeded",
            result: { runId: record.operationId, dispatch: "accepted" },
          };
        if (dispatch.state === "unknown") {
          return {
            state: "unknown",
            result: { runId: record.operationId },
            dispatch,
            error: {
              code: "dispatch-unknown",
              message: "Delivery is still unconfirmed; retry again or discard",
            },
            retryable: true,
          };
        }
        return {
          state: "failed",
          result: { runId: record.operationId },
          error: { code: "operation-failed", message: dispatch.error ?? "Rejected" },
        };
      },
    };
  },
};

const runDiscard: MutationActionHandler<{ operationId: string }> = {
  kind: "mutation",
  action: "run.discard",
  parse(input) {
    onlyKeys(input, ["operationId"]);
    const operationId = typeof input.operationId === "string" ? input.operationId : "";
    if (!operationId) throw invalid("operationId is required");
    return { value: { operationId }, scope: `operation:${operationId}`, intent: {} };
  },
  async prepare(input, context) {
    const { record, session, requestId } = await parkedRun(context, input.operationId);
    return {
      resources: {
        sessionId: session.sessionId,
        dispatchRequestId: requestId,
        environmentId: session.environment.id,
      },
      async execute() {
        const result = await context.invoke<{ discarded: boolean }>(
          "discard_native_agent_dispatch",
          {
            environmentId: session.environment.id,
            agent: session.agent,
            logicalSessionKey: session.logicalSessionKey,
            requestId,
          },
        );
        if (!result.discarded) {
          return {
            state: "failed",
            error: {
              code: "conflict",
              message: "The dispatch settled before it could be discarded",
            },
          };
        }
        // Discarding clears recovery state; it does not undo a turn that may
        // have run. The run's outcome is therefore permanently unknown.
        await context.command.storage.updatePublicOperation(record.operationId, (current) =>
          ["admitted", "running", "unknown"].includes(current.state)
            ? {
                ...current,
                state: "interrupted",
                completedAt: new Date(context.now()).toISOString(),
                dispatch: { state: "unknown", recoverable: false },
                execution: {
                  state: "interrupted",
                  evidence: "none",
                  reason: "Discarded; the turn may or may not have run",
                },
                error: {
                  code: "run-interrupted",
                  message: "The unconfirmed dispatch was discarded; it may or may not have run",
                },
              }
            : null,
        );
        return {
          state: "succeeded",
          result: { runId: record.operationId, discarded: true, undone: false },
        };
      },
    };
  },
};

export const RUN_RECOVERY_HANDLERS: PublicActionHandler[] = [runRetry, runDiscard];
