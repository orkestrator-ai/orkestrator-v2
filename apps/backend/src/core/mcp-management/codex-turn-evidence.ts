/**
 * Thread-level evidence that a Codex runtime uses a reloaded configuration.
 *
 * Codex reloads MCP configuration for the environment's whole app-server
 * (`config/mcpServer/reload`), and each thread picks the change up at its next
 * `turn/start` (observed live on 2026-10-18 for add, edit, rename and remove).
 * So a runtime has adopted the change once its session starts a turn after the
 * reload completed. The backend records every dispatch the provider accepts
 * (`dispatchedRequestIds`), so it can tell that without asking the bridge,
 * whose session routes either touch liveness or can cold-start app-server.
 *
 * When the reload (or the answer that nothing was running) completes, the
 * service records each runtime's newest accepted dispatch and any dispatch
 * still open at that moment, which may have reached `turn/start` before the
 * reload landed. A newer accepted dispatch than both proves a turn started
 * after the reload: on the same app-server, which then held the change, or on
 * a later one, which read the saved file when it started. A turn that never
 * comes leaves the runtime `pending-next-turn`, which is the truth.
 *
 * Not distinguished: a change superseded by an outside edit after its reload
 * is held (that app-server keeps it until its next reload), so a later turn
 * still marks the runtime `applied` even if the app-server was replaced in
 * between and loaded the newer file instead.
 */

import type { McpRuntimeApplyEntry } from "@orkestrator/protocol/mcp-management";

import type { ApplySession } from "./apply.js";
import { EVIDENCE_WINDOW_MS } from "./evidence.js";
import type { StoredOperation } from "./operations-store.js";

export const CODEX_TURN_APPLIED_REASON =
  "The thread started a turn after Codex loaded the saved configuration.";

/** What a runtime's session had dispatched when its reload completed. */
export interface CodexTurnBaseline {
  /** Newest dispatch the provider had accepted; `null` when none. */
  lastDispatchId: string | null;
  /** A dispatch still open then; its turn may predate the reload. */
  pendingDispatchId?: string;
}

function sessionKey(environmentId: string, agent: string, logicalSessionKey: string): string {
  return `${environmentId}\u0000${agent}\u0000${logicalSessionKey}`;
}

export function codexTurnBaseline(session: ApplySession | undefined): CodexTurnBaseline {
  return {
    lastDispatchId: session?.lastDispatchId ?? null,
    ...(session?.pendingDispatchId ? { pendingDispatchId: session.pendingDispatchId } : {}),
  };
}

/** Index sessions for {@link codexTurnBaseline} and {@link codexTurnsStarted}. */
export function sessionsByKey(sessions: readonly ApplySession[]): Map<string, ApplySession> {
  return new Map(
    sessions.map((session) => [
      sessionKey(session.environmentId, session.agent, session.logicalSessionKey),
      session,
    ]),
  );
}

export function lookupSession(
  sessions: ReadonlyMap<string, ApplySession>,
  record: { environmentId: string; agent: string; logicalSessionKey?: string },
): ApplySession | undefined {
  if (!record.logicalSessionKey) return undefined;
  return sessions.get(sessionKey(record.environmentId, record.agent, record.logicalSessionKey));
}

/** Runtimes of `stored` still waiting for a turn, inside the evidence window. */
function waitingRecords(stored: StoredOperation, nowMs: number) {
  const queuedAt = Date.parse(stored.recovery.applyQueuedAt ?? "");
  if (!Number.isFinite(queuedAt) || nowMs - queuedAt > EVIDENCE_WINDOW_MS) return [];
  const states = new Map(
    stored.snapshot.apply.runtimes.map((runtime) => [runtime.runtimeId, runtime.state]),
  );
  return (stored.recovery.runtimes ?? []).filter(
    (record) => record.turnBaseline && states.get(record.runtimeId) === "pending-next-turn",
  );
}

export function hasCodexTurnWork(operations: readonly StoredOperation[], nowMs: number): boolean {
  return operations.some((stored) => waitingRecords(stored, nowMs).length > 0);
}

/**
 * Runtime ids, per operation, whose session has started a turn since its
 * baseline. Pure: the caller marks them `applied` and clears the baseline.
 */
export function codexTurnsStarted(
  operations: readonly StoredOperation[],
  sessions: ReadonlyMap<string, ApplySession>,
  nowMs: number,
): Map<StoredOperation, Set<McpRuntimeApplyEntry["runtimeId"]>> {
  const started = new Map<StoredOperation, Set<string>>();
  for (const stored of operations) {
    for (const record of waitingRecords(stored, nowMs)) {
      const latest = lookupSession(sessions, record)?.lastDispatchId;
      const baseline = record.turnBaseline!;
      if (!latest || latest === baseline.lastDispatchId || latest === baseline.pendingDispatchId) {
        continue;
      }
      const ids = started.get(stored) ?? new Set<string>();
      ids.add(record.runtimeId);
      started.set(stored, ids);
    }
  }
  return started;
}
