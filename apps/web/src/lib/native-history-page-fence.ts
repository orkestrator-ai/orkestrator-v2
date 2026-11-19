/**
 * The identity of one "Load earlier messages" request, and the rule for
 * whether its answer may still be merged when it lands.
 *
 * A history page has its own request identity, separate from the live-tail
 * reads. A tail read polls every 500–1500 ms while an agent runs, and a page
 * can take longer than that, so letting either cancel the other meant a slow
 * page never landed (flakes 0483, 1602). Instead the page records what it was
 * fetched against and, on completion, is merged into whatever live tail is
 * current, provided every fact it depends on still holds:
 *
 * - it is still the newest page request (`sequence`);
 * - no mutation has taken over the transcript since (`operationEpoch`);
 * - the live tail still belongs to the same session generation (`session`);
 * - the history it pages has not been rewritten (`historyEpoch`);
 * - the tab still holds the cursor it was fetched behind (`cursor`).
 *
 * An ordinary tail read changes none of these: it keeps the paging state while
 * the history it describes stands, so a page survives any number of them.
 */

/** The live tail's session, as far as a history page depends on it. */
export interface HistoryPageSession {
  platform: string;
  environmentId: string;
  sessionId?: string;
  generation?: string | number;
}

export interface HistoryPageFence {
  sequence: number;
  operationEpoch: number;
  session: HistoryPageSession | null;
  historyEpoch: string | undefined;
  cursor: string | undefined;
}

/** Why a landed page may not be merged; `current` when it may. */
export type HistoryPageFenceVerdict =
  "current" | "superseded" | "mutated" | "session-changed" | "history-rewritten" | "cursor-moved";

/** Reduces a projection to the fields that identify its session generation. */
export function historyPageSession(
  projection: {
    platform: string;
    environmentId: string;
    sessionId?: string;
    generation?: string | number;
  } | null,
): HistoryPageSession | null {
  if (!projection) return null;
  return {
    platform: projection.platform,
    environmentId: projection.environmentId,
    ...(projection.sessionId !== undefined ? { sessionId: projection.sessionId } : {}),
    ...(projection.generation !== undefined ? { generation: projection.generation } : {}),
  };
}

function sameSession(a: HistoryPageSession | null, b: HistoryPageSession | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.platform === b.platform &&
    a.environmentId === b.environmentId &&
    a.sessionId === b.sessionId &&
    a.generation === b.generation
  );
}

/**
 * Compares the fence a page was requested under with the hook's state now.
 * The first failing check is reported, in the order listed in the module
 * comment.
 */
export function checkHistoryPageFence(
  requested: HistoryPageFence,
  now: HistoryPageFence,
): HistoryPageFenceVerdict {
  if (requested.sequence !== now.sequence) return "superseded";
  if (requested.operationEpoch !== now.operationEpoch) return "mutated";
  if (!sameSession(requested.session, now.session)) return "session-changed";
  if (requested.historyEpoch !== now.historyEpoch) return "history-rewritten";
  if (requested.cursor !== now.cursor) return "cursor-moved";
  return "current";
}
