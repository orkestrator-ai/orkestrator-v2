import {
  isPublicActionName,
  isPublicNamespace,
  isPublicRequestId,
  PUBLIC_ACTIONS,
  PUBLIC_API_SCHEMA_VERSION,
  publicErrorEnvelope,
  publicSuccessEnvelope,
  type PublicActionName,
  type PublicActionResponse,
  type PublicReceipt,
} from "@orkestrator/protocol/public-api";
import type { CommandContext } from "../commands-context.js";
import type { CommandRegistrar, RegistryDependencies } from "../commands-registry-types.js";
import { boundedMessage, isPublicActionError, PublicActionError } from "./errors.js";
import {
  intentFingerprint,
  isActiveRecord,
  requestKey,
  toReceipt,
  type PublicOperationRecord,
} from "./operation-ledger.js";
import { ensureReconciler } from "./reconciler.js";
import type {
  ExecuteOutcome,
  MutationActionHandler,
  OperationHandle,
  OperationPatch,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * The single public entrypoint. Every public action arrives as
 * `public_action {schemaVersion, action, actionVersion, input, request?}` and
 * leaves as one `PublicActionResponse` inside the legacy `{result}` gateway
 * wrapper. Domain failures are structured envelopes (HTTP 200); only a
 * malformed wrapper or a backend that is shutting down produces the legacy
 * `{error}` form.
 */

export type PublicHandlerTable = ReadonlyMap<PublicActionName, PublicActionHandler>;

const MAX_INPUT_BYTES = 1024 * 1024;

function backendIdentity(context: PublicActionContext) {
  return { installationId: context.installationId, generation: context.generation };
}

function withBackend(
  response: PublicActionResponse,
  context: PublicActionContext,
): PublicActionResponse {
  return { ...response, backend: backendIdentity(context) };
}

function errorResponse(
  action: string,
  error: unknown,
  receipt?: PublicReceipt,
): PublicActionResponse {
  if (isPublicActionError(error)) {
    return publicErrorEnvelope(
      action,
      {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
        ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
      },
      receipt,
    );
  }
  // Unexpected failures are reported without classifying their prose.
  return publicErrorEnvelope(
    action,
    { code: "internal-error", message: boundedMessage(error) },
    receipt,
  );
}

export function createPublicActionContext(
  command: CommandContext,
  dependencies: RegistryDependencies,
  identity: { installationId: string; generation: string },
): PublicActionContext {
  return {
    command,
    dependencies,
    authority: "operator",
    installationId: identity.installationId,
    generation: identity.generation,
    now: () => Date.now(),
    invoke: async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const handler = dependencies.commands.get(name);
      if (!handler) throw new Error(`Unknown backend command: ${name}`);
      return (await handler(args, command)) as T;
    },
  };
}

export async function dispatchPublicAction(
  table: PublicHandlerTable,
  raw: Record<string, unknown>,
  context: PublicActionContext,
): Promise<PublicActionResponse> {
  const actionName = typeof raw.action === "string" ? raw.action.slice(0, 100) : "unknown";
  if (raw.schemaVersion !== PUBLIC_API_SCHEMA_VERSION) {
    return withBackend(
      errorResponse(
        actionName,
        new PublicActionError(
          "backend-incompatible",
          `This backend speaks public schema ${PUBLIC_API_SCHEMA_VERSION}`,
          { details: { supportedSchemaVersion: PUBLIC_API_SCHEMA_VERSION } },
        ),
      ),
      context,
    );
  }
  if (!isPublicActionName(raw.action) || !table.has(raw.action)) {
    return withBackend(
      errorResponse(
        actionName,
        new PublicActionError("unsupported", "This backend does not offer that public action"),
      ),
      context,
    );
  }
  const action = raw.action;
  const handler = table.get(action)!;
  if (raw.actionVersion !== PUBLIC_ACTIONS[action].version) {
    return withBackend(
      errorResponse(
        action,
        new PublicActionError("backend-incompatible", `${action} version mismatch`, {
          details: { supportedVersion: PUBLIC_ACTIONS[action].version },
        }),
      ),
      context,
    );
  }
  const input = raw.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return withBackend(
      errorResponse(action, new PublicActionError("invalid-input", "input must be an object")),
      context,
    );
  }
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES) {
    return withBackend(
      errorResponse(action, new PublicActionError("input-too-large", "input is too large")),
      context,
    );
  }
  try {
    if (handler.kind === "read") {
      if (raw.request !== undefined) {
        throw new PublicActionError("invalid-input", "Read actions do not take a request key");
      }
      return withBackend(
        await runRead(handler, input as Record<string, unknown>, context),
        context,
      );
    }
    return withBackend(
      await runMutation(handler, input as Record<string, unknown>, raw.request, context),
      context,
    );
  } catch (error) {
    return withBackend(errorResponse(action, error), context);
  }
}

async function runRead(
  handler: ReadActionHandler,
  input: Record<string, unknown>,
  context: PublicActionContext,
): Promise<PublicActionResponse> {
  const parsed = handler.parse(input);
  const { result, receipt } = await handler.run(parsed, context);
  return publicSuccessEnvelope(handler.action, result ?? null, receipt);
}

function parseRequestKey(value: unknown): { requestId: string; namespace?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicActionError("invalid-input", "Mutations require a request key");
  }
  const record = value as Record<string, unknown>;
  if (!isPublicRequestId(record.requestId)) {
    throw new PublicActionError("invalid-input", "request.requestId is invalid");
  }
  if (record.namespace !== undefined && !isPublicNamespace(record.namespace)) {
    throw new PublicActionError("invalid-input", "request.namespace is invalid");
  }
  return {
    requestId: record.requestId,
    ...(typeof record.namespace === "string" ? { namespace: record.namespace } : {}),
  };
}

/** Envelope for an operation the key already admitted. */
function replayResponse(record: PublicOperationRecord): PublicActionResponse {
  const receipt = toReceipt(record, true);
  if (record.state === "failed" || record.state === "partial" || record.state === "cancelled") {
    return publicErrorEnvelope(
      record.action,
      record.error ?? { code: "operation-failed", message: `Operation ${record.state}` },
      receipt,
    );
  }
  if (record.state === "unknown") {
    return publicErrorEnvelope(
      record.action,
      record.error ?? {
        code: record.dispatch?.state === "unknown" ? "dispatch-unknown" : "run-unknown",
        message: "The outcome of this operation is not known",
      },
      receipt,
    );
  }
  if (record.state === "interrupted") {
    return publicErrorEnvelope(
      record.action,
      record.error ?? { code: "run-interrupted", message: "The operation was interrupted" },
      receipt,
    );
  }
  if (record.state !== "succeeded" && record.result === undefined) {
    return publicErrorEnvelope(
      record.action,
      {
        code: "busy",
        message: "The operation is still in progress",
        retryable: true,
      },
      receipt,
    );
  }
  return publicSuccessEnvelope(record.action, record.result ?? {}, receipt);
}

export function operationHandle(
  record: PublicOperationRecord,
  context: PublicActionContext,
): OperationHandle {
  let current = record;
  return {
    operationId: record.operationId,
    current: () => current,
    async update(patch: OperationPatch) {
      const next = await context.command.storage.updatePublicOperation(
        record.operationId,
        (stored) => ({
          ...stored,
          ...patch,
          resources: { ...stored.resources, ...patch.resources },
          generation: context.generation,
          ...(patch.state && !["admitted", "running", "unknown"].includes(patch.state)
            ? { completedAt: patch.completedAt ?? new Date(context.now()).toISOString() }
            : {}),
        }),
      );
      if (next) current = next;
      return current;
    },
  };
}

/** Persist an execute outcome; returns the final record. */
async function applyOutcome(
  handle: OperationHandle,
  outcome: ExecuteOutcome,
): Promise<PublicOperationRecord> {
  if (outcome.state === "succeeded" || outcome.state === "running") {
    return handle.update({
      state: outcome.state,
      stage:
        outcome.stage ?? (outcome.state === "succeeded" ? "completed" : handle.current().stage),
      result: outcome.result,
      ...(outcome.resources ? { resources: outcome.resources } : {}),
      ...(outcome.dispatch ? { dispatch: outcome.dispatch } : {}),
      ...(outcome.execution ? { execution: outcome.execution } : {}),
    });
  }
  return handle.update({
    state: outcome.state,
    ...(outcome.stage ? { stage: outcome.stage } : {}),
    error: outcome.error,
    ...(outcome.result ? { result: outcome.result } : {}),
    ...(outcome.resources ? { resources: outcome.resources } : {}),
    ...(outcome.dispatch ? { dispatch: outcome.dispatch } : {}),
    ...(outcome.execution ? { execution: outcome.execution } : {}),
  });
}

async function runMutation(
  handler: MutationActionHandler,
  input: Record<string, unknown>,
  rawRequest: unknown,
  context: PublicActionContext,
): Promise<PublicActionResponse> {
  const request = parseRequestKey(rawRequest);
  const parsed = handler.parse(input);
  const storage = context.command.storage;
  const key = requestKey(context.authority, handler.action, parsed.scope, request.requestId);
  const fingerprint = intentFingerprint(handler.action, parsed.intent);

  // Fast path: an earlier admission of this key answers without re-validating
  // a target that may since have changed (e.g. a deleted environment).
  const existing = await storage.findPublicOperationByKey(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new PublicActionError(
        "request-conflict",
        "This request ID was already used for a different request",
        { details: { operationId: existing.operationId, namespace: existing.namespace } },
      );
    }
    if (existing.state !== "admitted" || existing.generation === context.generation) {
      return replayResponse(existing);
    }
    // Prepare before changing ownership. A failed prepare leaves the old
    // generation visible to reconciliation and later same-key retries.
    const prepared = await handler.prepare(parsed.value, context);
    const claimed = await storage.claimStalePublicOperation(
      existing.operationId,
      context.generation,
    );
    if (!claimed) {
      const latest = await storage.getPublicOperation(existing.operationId);
      return replayResponse(latest.status === "found" ? latest.record : existing);
    }
    return execute(handler, prepared, claimed, context, false);
  }

  const prepared = await handler.prepare(parsed.value, context);
  const { record, replayed } = await storage.admitPublicOperation({
    authority: context.authority,
    action: handler.action,
    scope: parsed.scope,
    requestId: request.requestId,
    ...(request.namespace ? { namespace: request.namespace } : {}),
    requestKey: key,
    fingerprint,
    ...(prepared.resolved ? { resolved: prepared.resolved } : {}),
    ...(prepared.resources ? { resources: prepared.resources } : {}),
    generation: context.generation,
    now: context.now(),
  });
  if (replayed) return replayResponse(record);
  return execute(handler, prepared, record, context, false);
}

async function execute(
  handler: MutationActionHandler,
  prepared: Awaited<ReturnType<MutationActionHandler["prepare"]>>,
  record: PublicOperationRecord,
  context: PublicActionContext,
  replayed: boolean,
): Promise<PublicActionResponse> {
  const handle = operationHandle(record, context);
  await handle.update({ state: "running", stage: "executing" });
  let final: PublicOperationRecord;
  let warnings: string[] | undefined;
  let retryable: boolean | undefined;
  try {
    const outcome = await prepared.execute(handle);
    if (outcome.state === "succeeded" || outcome.state === "running") warnings = outcome.warnings;
    else retryable = outcome.retryable;
    final = await applyOutcome(handle, outcome);
  } catch (error) {
    const code = isPublicActionError(error) ? error.code : "operation-failed";
    final = await handle.update({
      state: "failed",
      error: { code, message: boundedMessage(error) },
    });
  }
  const receipt = toReceipt(final, replayed);
  if (final.state === "succeeded" || (final.state === "running" && isActiveRecord(final))) {
    return publicSuccessEnvelope(handler.action, final.result ?? {}, receipt, warnings);
  }
  const response = replayResponse(final);
  if (!response.ok && retryable !== undefined) {
    return { ...response, error: { ...response.error, retryable }, receipt };
  }
  return { ...response, receipt };
}

export function registerPublicActionCommand(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
  table: PublicHandlerTable,
): void {
  register("public_action", async (args, command) => {
    const identity = await command.storage.getPreviewBackendIdentity();
    const context = createPublicActionContext(command, dependencies, {
      installationId: identity.instanceId,
      generation: command.storage.getResourceGeneration(),
    });
    // Backend-owned completion and restart recovery of admitted work.
    ensureReconciler(context);
    return dispatchPublicAction(table, args, context);
  });
}
