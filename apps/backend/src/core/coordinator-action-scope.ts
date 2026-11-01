import { createHash } from "node:crypto";
import type { CoordinatorSurfaceAction } from "@orkestrator/protocol/coordinator-surfaces";
import type { CommandContext } from "./commands-context.js";

export function actionHash(value: unknown): string {
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (!item || typeof item !== "object") return item;
    const fields = item as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(fields)
        .sort()
        .flatMap((key) =>
          fields[key] === undefined ? [] : [[key, canonicalize(fields[key])] as const],
        ),
    );
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export async function requireCoordinatorConversation(
  context: CommandContext,
  projectId: string,
  coordinatorId: string,
  conversationId: string,
): Promise<void> {
  const workspace = await context.storage.coordinators.getCoordinatorWorkspaceById(coordinatorId);
  if (
    !workspace ||
    workspace.projectId !== projectId ||
    workspace.lifecycleState !== "ready" ||
    !workspace.conversations.some((item) => item.id === conversationId && !item.closedAt)
  )
    throw new Error("Coordinator identity is unavailable");
}

export interface CoordinatorCaller {
  projectId: string;
  coordinatorId: string;
  conversationId: string;
}

/** The authenticated scope a coordinator command carries, revalidated against storage. */
export async function coordinatorCaller(
  scope: unknown,
  context: CommandContext,
): Promise<CoordinatorCaller> {
  if (!scope || typeof scope !== "object" || Array.isArray(scope))
    throw new Error("Coordinator scope is required");
  const value = scope as Record<string, unknown>;
  const field = (name: string) => {
    const item = value[name];
    if (typeof item !== "string" || !item.trim()) throw new Error(`Expected ${name}`);
    return item;
  };
  const caller = {
    projectId: field("projectId"),
    coordinatorId: field("coordinatorId"),
    conversationId: field("conversationId"),
  };
  await requireCoordinatorConversation(
    context,
    caller.projectId,
    caller.coordinatorId,
    caller.conversationId,
  );
  return caller;
}

/**
 * Run one coordinator surface action at most once per `requestId`.
 *
 * The receipt is admitted before `run` has any effect. An identical retry of
 * a completed action replays its stored result with `replayed: true`; a
 * reused `requestId` with a different payload is refused. When `run` fails
 * the pending receipt is dropped, so the same request can be retried; every
 * action passed here is itself safe to repeat after a partial run (its tab,
 * job or request identity derives from the `requestId`, or it reattaches to
 * what the earlier attempt left), so a crash between the effect and the
 * receipt's completion is recovered by the retry rather than duplicated.
 */
export async function withCoordinatorReceipt(
  context: CommandContext,
  caller: CoordinatorCaller,
  input: { requestId: string; action: CoordinatorSurfaceAction; payload: unknown },
  run: (previous: { createdAt: string }) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const requestId = input.requestId.trim();
  if (!requestId || requestId.length > 256)
    throw new Error("Expected a requestId of 1-256 characters");
  // Concurrent identical calls in this backend run once and share the answer;
  // the payload check still applies to each through `admit`.
  const key = `${caller.coordinatorId}\0${requestId}`;
  const flights = context.runtime.coordinatorRequests;
  const prior = flights.receiptAttempt(key);
  if (prior) {
    await prior.catch(() => undefined);
    return withCoordinatorReceipt(context, caller, input, run);
  }
  return flights.trackReceiptAttempt(
    key,
    admitAndRun(context, caller, { ...input, requestId }, run),
  );
}

async function admitAndRun(
  context: CommandContext,
  caller: CoordinatorCaller,
  input: { requestId: string; action: CoordinatorSurfaceAction; payload: unknown },
  run: (previous: { createdAt: string }) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const { requestId } = input;
  const { receipt, claimed } = await context.storage.coordinators.admitCoordinatorActionReceipt({
    ...caller,
    requestId,
    action: input.action,
    payloadHash: actionHash({ action: input.action, payload: input.payload }),
  });
  if (!claimed) {
    if (receipt.state === "completed") return { ...receipt.result, replayed: true };
    throw new Error(
      "This request is still running in another backend process; retry the same requestId",
    );
  }
  let result: Record<string, unknown>;
  try {
    result = await run({ createdAt: receipt.createdAt });
  } catch (error) {
    await context.storage.coordinators
      .releaseCoordinatorActionReceipt(caller.coordinatorId, requestId)
      .catch(() => undefined);
    throw error;
  }
  await context.storage.coordinators.completeCoordinatorActionReceipt(
    caller.coordinatorId,
    requestId,
    result,
  );
  return result;
}
