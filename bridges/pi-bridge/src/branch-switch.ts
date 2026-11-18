/**
 * A branch switch that can keep a summary of the branch it leaves.
 *
 * Pi's `navigateTree` can ask the session's model to summarize the entries
 * being left and record the answer as a `branch_summary` entry at the new
 * position, so the conversation carries on knowing what the other branch
 * did. That is a model call the user pays for, so it runs only when the
 * request opts in (`{ "summarize": true }`); an ordinary switch passes
 * `summarize: false` and Pi never calls a model.
 *
 * Pi appends the summary entry to the session file synchronously, as its new
 * leaf, so it survives a reload and a bridge restart like any other entry, and
 * `hydrateHistory` renders it as a "Branch summary" row.
 *
 * A summary can take as long as a turn, so while one runs the session reports
 * itself running (a Stop control, and no pipeline advancing past it) and the
 * ordinary cancel routes stop it through Pi's `abortBranchSummary`. Every way a
 * switch can end without moving the conversation (a cancel, the bridge's own
 * time bound, an extension refusing, a failed summary) is answered as that, in
 * words the user can act on; none reads as a success or an opaque failure.
 */
import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isObject, type SessionState } from "./state.js";

/**
 * How long the bridge lets Pi summarize before it stops the switch.
 *
 * Shorter than the backend's own wait for the route (five minutes), so the
 * bridge always answers first with what actually happened: at the backend's
 * deadline the user would be told the bridge was unavailable while the
 * summary went on and the switch landed anyway.
 */
export const BRANCH_SUMMARY_TIMEOUT_MS = 4 * 60_000;

let branchSummaryTimeoutMs = BRANCH_SUMMARY_TIMEOUT_MS;

export function setBranchSummaryTimeoutForTests(timeoutMs?: number): void {
  branchSummaryTimeoutMs = timeoutMs ?? BRANCH_SUMMARY_TIMEOUT_MS;
}

/** A summarized switch in flight. Runtime-only: a restarted process has none. */
export interface BranchSummaryRun {
  cancelRequested: boolean;
  timedOut: boolean;
  /** Pi's abort, once Pi has been asked to navigate. */
  abort?: () => void;
  /** Settles when the switch is done; `true` when it was stopped. */
  settled: Promise<boolean>;
  settle: (stopped: boolean) => void;
}

export type BranchSwitchCancelReason = "cancelled" | "timeout" | "extension";

const CANCELLED_MESSAGES: Record<BranchSwitchCancelReason, string> = {
  cancelled:
    "The branch switch was stopped before Pi finished the summary; the conversation stayed on its branch.",
  timeout:
    "Pi took too long to summarize the branch, so the switch was stopped; the conversation stayed on its branch.",
  extension: "A Pi extension cancelled the branch switch; the conversation stayed on its branch.",
};

/**
 * A switch that did not move the conversation. Answered 409 with
 * `cancelled: true`: definite, and retryable.
 */
export class BranchSwitchCancelledError extends Error {
  override readonly name = "BranchSwitchCancelledError";
  readonly status = 409;

  constructor(readonly reason: BranchSwitchCancelReason) {
    super(CANCELLED_MESSAGES[reason]);
  }

  body(): Record<string, unknown> {
    return { error: this.message, cancelled: true, reason: this.reason };
  }
}

/**
 * A summarized switch refused or failed before the conversation moved.
 * Answered 422; switching without a summary still works.
 */
export class BranchSummaryError extends Error {
  override readonly name = "BranchSummaryError";
  readonly status = 422;

  body(): Record<string, unknown> {
    return { error: this.message, kind: "branch-summary-failed" };
  }
}

/** The optional body of `POST /session/:id/branches/:entryId`. */
export function parseBranchSwitchBody(
  value: unknown,
): { ok: true; summarize: boolean } | { ok: false; error: string } {
  // Older backends send no body: an ordinary switch.
  if (value === undefined || value === null) return { ok: true, summarize: false };
  if (!isObject(value)) return { ok: false, error: "Request body must be a JSON object" };
  const summarize = value.summarize;
  if (summarize !== undefined && typeof summarize !== "boolean") {
    return { ok: false, error: "summarize must be a boolean" };
  }
  return { ok: true, summarize: summarize === true };
}

/**
 * Start a summarized switch: recorded synchronously, before the route's first
 * await, so a cancel arriving during a cold attach is not lost.
 */
export function beginBranchSummary(state: SessionState): BranchSummaryRun {
  let settle: (stopped: boolean) => void = () => undefined;
  const settled = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const run: BranchSummaryRun = { cancelRequested: false, timedOut: false, settled, settle };
  state.branchSummary = run;
  state.revision += 1;
  return run;
}

export function endBranchSummary(
  state: SessionState,
  run: BranchSummaryRun,
  stopped: boolean,
): void {
  if (state.branchSummary === run) state.branchSummary = undefined;
  run.abort = undefined;
  run.settle(stopped);
  state.revision += 1;
}

/**
 * Stop the summarized switch in flight, if there is one. Returns its
 * settlement (`true` when the switch was stopped), or `undefined`.
 */
export function requestBranchSummaryCancellation(
  state: SessionState,
): Promise<boolean> | undefined {
  const run = state.branchSummary;
  if (!run) return undefined;
  run.cancelRequested = true;
  run.abort?.();
  return run.settled;
}

/**
 * A summary needs a reply to follow. Pi places it at the switch's new leaf,
 * which for a prompt is the prompt's parent: the selected prompt would then
 * be left off the branch the switch was asked to keep.
 */
export function assertSummaryCanFollow(entry: SessionEntry | undefined): void {
  const endsOnPrompt =
    entry?.type === "custom_message" ||
    (entry?.type === "message" && entry.message.role === "user");
  if (endsOnPrompt) {
    throw new BranchSummaryError(
      "This branch ends on a prompt with no reply, so a summary cannot follow it. Switch without a summary.",
    );
  }
}

/**
 * Ask Pi to move to `target`, summarizing the branch being left when `run` is
 * given. Resolves with Pi's summary entry id, if Pi wrote one; throws when the
 * conversation did not move.
 */
export async function navigateBranch(
  session: AgentSession,
  target: string,
  run: BranchSummaryRun | undefined,
): Promise<{ summaryEntryId?: string }> {
  if (!run) {
    const result = await session.navigateTree(target, { summarize: false });
    if (result.cancelled) throw new BranchSwitchCancelledError("extension");
    return {};
  }
  // A cancel recorded while the route was still attaching: Pi was never asked.
  if (run.cancelRequested) throw new BranchSwitchCancelledError("cancelled");
  const leafBefore = session.sessionManager.getLeafId();
  // Pi creates the summary's abort controller synchronously inside
  // `navigateTree`, before its first await, so the abort is live from here.
  run.abort = () => session.abortBranchSummary();
  const timer = setTimeout(() => {
    run.timedOut = true;
    session.abortBranchSummary();
  }, branchSummaryTimeoutMs);
  (timer as { unref?: () => void }).unref?.();
  let result: Awaited<ReturnType<AgentSession["navigateTree"]>>;
  try {
    result = await session.navigateTree(target, { summarize: true });
  } catch (error) {
    // Pi throws a failed summary ("No model available for summarization", a
    // provider error) before it moves the leaf. Say so only when that holds.
    if (session.sessionManager.getLeafId() !== leafBefore) throw error;
    const detail = error instanceof Error ? error.message.trim().slice(0, 300) : "";
    throw new BranchSummaryError(
      `Pi could not summarize the branch being left, so the conversation stayed on its branch${
        detail ? `: ${detail}` : "."
      }`,
    );
  } finally {
    clearTimeout(timer);
    run.abort = undefined;
  }
  if (result.cancelled) {
    throw new BranchSwitchCancelledError(
      !result.aborted
        ? "extension"
        : run.timedOut && !run.cancelRequested
          ? "timeout"
          : "cancelled",
    );
  }
  return result.summaryEntry ? { summaryEntryId: result.summaryEntry.id } : {};
}
