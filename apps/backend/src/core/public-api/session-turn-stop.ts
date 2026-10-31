import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";
import type { PublicOperationRecord } from "./operation-ledger.js";
import type { ResolvedSession } from "./sessions.js";
import type { PublicActionContext } from "./types.js";

/**
 * Stopping the running turn of one native session, shared by `session.stop`
 * and the coordinator's `stop_worker_turn`, so a turn stopped either way
 * leaves the same evidence: the session's active public run is marked
 * `stopRequestedAt` before the provider is asked to stop, and settles as
 * cancelled (not completed) once its turn ends.
 */

export type SessionStopContext = Pick<PublicActionContext, "command" | "invoke" | "now">;

/** The newest public run this session dispatched that is still active. */
export async function activeRunFor(
  context: Pick<PublicActionContext, "command">,
  session: ResolvedSession,
): Promise<PublicOperationRecord | null> {
  const dispatched = session.record?.dispatchedRequestIds ?? [];
  const active = await context.command.storage.publicOperations.listActivePublicOperations();
  return (
    active
      .filter(
        (record) =>
          (record.action === "session.start" ||
            record.action === "session.prompt" ||
            record.action === "session.command" ||
            record.action === "pr.create" ||
            record.action === "pr.resolve") &&
          record.resources.sessionId === session.sessionId &&
          !!record.resources.dispatchRequestId &&
          dispatched.includes(record.resources.dispatchRequestId),
      )
      .sort(
        (a, b) =>
          dispatched.indexOf(b.resources.dispatchRequestId!) -
          dispatched.indexOf(a.resources.dispatchRequestId!),
      )[0] ?? null
  );
}

export interface SessionTurnStop {
  /** The public run the stop was recorded against, if one was active. */
  run: PublicOperationRecord | null;
  /** The turn phase the provider reported after the stop, or `unknown`. */
  phase: string;
  /** The provider confirmed the turn ended (`idle` or `error`). */
  acknowledged: boolean;
}

/**
 * Mark the active run stop-requested, then ask the provider to stop the turn.
 * The caller has already resolved the session and decided a turn is running.
 */
export async function stopSessionTurn(
  context: SessionStopContext,
  session: ResolvedSession,
  hooks: {
    /** The run to mark; looked up when absent. */
    run?: PublicOperationRecord | null;
    onRun?(run: PublicOperationRecord): Promise<void>;
    beforeStop?(): Promise<void>;
  } = {},
): Promise<SessionTurnStop> {
  const run = hooks.run ?? (await activeRunFor(context, session));
  if (run) {
    // The run settles as cancelled (not completed) once its turn ends.
    await context.command.storage.publicOperations.updatePublicOperation(
      run.operationId,
      (current) =>
        current.stopRequestedAt
          ? null
          : { ...current, stopRequestedAt: new Date(context.now()).toISOString() },
    );
    await hooks.onRun?.(run);
  }
  await hooks.beforeStop?.();
  const projection = await context.invoke<NativeAgentSessionProjection | null>(
    "stop_native_agent_session",
    {
      environmentId: session.environment.id,
      agent: session.agent,
      logicalSessionKey: session.logicalSessionKey,
    },
  );
  const phase = projection?.turn.phase ?? "unknown";
  return { run, phase, acknowledged: phase === "idle" || phase === "error" };
}
