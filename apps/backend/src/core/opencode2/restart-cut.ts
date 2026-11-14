/**
 * A run that a stop of the OpenCode server cut short (to-do 8045 (retired)).
 *
 * Orkestrator runs plain `opencode serve`. When that server stops mid-run
 * (a backend restart reaps the orphaned server, a crash, a SIGKILL), 2.2.6
 * marks the session suspended (`time_suspended`) but never resumes it: only
 * the background-service variant (`opencode service`) runs
 * `resumeSuspendedSessions` at start. The run is left half-open for good:
 *
 * - `/api/session/active` no longer names the session;
 * - the session's `time.busy` is newer than its `time.idle` (or there is no
 *   `idle` at all), and its `outcome` is still the previous run's;
 * - the history has no `idle` row after the run's input.
 *
 * Pinned against the 2.2.6 binary by `opencode2-restart.live.test.ts`
 * (SIGTERM, as the reaper sends first, and SIGKILL; a held model request and
 * a running tool). The provider reports such a run as
 * `error` with `interruption: "restart"`, which is what Pi's bridge already
 * reports, so the branch runner, the review fan-out and the build pipeline
 * give the turn its one continuation instead of waiting out the stall bound.
 *
 * Only a run that started before this provider existed counts. A provider is
 * built per server generation (`environment-provider.ts`), so a run started
 * on the current server, through this provider, is never judged dead from a
 * read that raced its start or its settlement. Input this provider admitted
 * into the open run (a continuation sent before the new run has marked the
 * session busy) also means the run is not dead.
 */
import type { OpenCode2Message, OpenCode2Session } from "./types.js";

/** The content-free detail of the failure: no prompt or model text. */
export const OPENCODE2_RESTART_CUT_MESSAGE = "The OpenCode server stopped before the turn finished";

/**
 * Whether the session record alone says its newest run started before
 * `providerStartedAt` and never settled. A cheap pre-check; the provider
 * confirms it against a fresh `/api/session/active` read and the history.
 */
export function openCode2SessionRunUnsettledSince(
  session: Pick<OpenCode2Session, "time">,
  providerStartedAt: number,
): boolean {
  const busy = session.time?.busy;
  if (typeof busy !== "number" || busy <= 0) return false;
  const idle = session.time?.idle;
  if (typeof idle === "number" && idle >= busy) return false;
  return busy < providerStartedAt;
}

/**
 * The open run of a history (oldest first): every row after the newest
 * `idle` row, or undefined when the newest row is an `idle` (nothing open).
 */
export function openCode2OpenRun(
  rowsOldestFirst: readonly OpenCode2Message[],
): readonly OpenCode2Message[] | undefined {
  let start = rowsOldestFirst.length;
  while (start > 0 && rowsOldestFirst[start - 1]!.type !== "idle") start--;
  const open = rowsOldestFirst.slice(start);
  return open.length > 0 ? open : undefined;
}

function rowRequestId(row: OpenCode2Message): string | undefined {
  if (row.type !== "user") return undefined;
  const requestId = (row.metadata as { orkestrator?: { requestId?: unknown } } | undefined)
    ?.orkestrator?.requestId;
  return typeof requestId === "string" && requestId ? requestId : undefined;
}

/**
 * The cut run's verdict from its history: undefined when the history shows
 * the run is not dead (it settled, or input admitted at or after
 * `providerStartedAt` is in it), else the request id of the run's newest
 * Orkestrator input, when it has one.
 *
 * Newest, because 2.2.6 writes no `idle` row for a cut run: the continuation
 * the runner sends joins that open run, so when a second restart cuts the
 * continuation too, the open run holds both inputs and the one interrupted is
 * the continuation. A steer that joined a run is newest for the same reason;
 * the turn's outcome is recorded against its latest request.
 */
export function openCode2CutRun(
  rowsOldestFirst: readonly OpenCode2Message[],
  providerStartedAt: number,
): { requestId?: string } | undefined {
  const open = openCode2OpenRun(rowsOldestFirst);
  if (!open) return undefined;
  const users = open.filter((row) => row.type === "user");
  if (users.some((row) => (row.time?.created ?? 0) >= providerStartedAt)) return undefined;
  const requestId = users.map(rowRequestId).findLast((id) => id !== undefined);
  return requestId ? { requestId } : {};
}
