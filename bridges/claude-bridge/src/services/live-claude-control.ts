// Bridge-wide reads from a Claude CLI that is already running.
//
// The model catalogue, the account and the plan-usage windows are not
// session state, and without a running CLI each read spawns one through
// `controlOnlyQuery` for a single answer. The bridge serves one environment
// and keeps its sessions' CLIs warm between turns, so one is often running
// already: its initialize answer holds the models and the account, and its
// control channel answers `/usage`.
//
// A prompt written into a CLI that survived its earlier turn (a rejoin) also
// re-reads that CLI's initialize inventory: the requests it still waits on.

import { boundedWait } from "@orkestrator/protocol/node/bounded-wait";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { ClaudeQueryControl } from "../types/index.js";
import { debugLog } from "./logger.js";
import { sessions } from "./session-manager-core.js";
import type { ClaudeRuntime } from "./session-manager-runtime.js";

const log = createLogger("bridge.claude");

/** How long one live CLI may take to answer before the read moves on. */
export const LIVE_CLAUDE_READ_TIMEOUT_MS = 5_000;

/**
 * Whether a CLI launched with these settings sources reads the settings a
 * probe reads. A probe passes none, so it loads user, project and local
 * settings, and each of these sources can narrow the model list
 * (`availableModels`). A coordinator turn launches with none at all.
 */
function readsProbeSettings(settingSources: string | undefined): boolean {
  if (settingSources === undefined) return false;
  try {
    const sources = JSON.parse(settingSources) as unknown;
    return (
      Array.isArray(sources) &&
      ["user", "project", "local"].every((source) => sources.includes(source))
    );
  } catch {
    return false;
  }
}

/**
 * Controls of the CLIs running on this bridge that can answer for it, the
 * most recently active first.
 *
 * Only open runtimes: a draining one is exiting, and every control request
 * races that exit. None of these reads is a frame, so none of them extends a
 * runtime's idle window.
 */
export function liveClaudeControls(): ClaudeQueryControl[] {
  const runtimes = [];
  for (const session of sessions.values()) {
    const runtime = session.claudeRuntime;
    if (runtime?.state !== "open" || runtime.abortController.signal.aborted) continue;
    if (session.queryControlDraining === runtime.control || session.deleting) continue;
    if (!readsProbeSettings(runtime.launch.settingSources)) continue;
    runtimes.push(runtime);
  }
  return runtimes
    .sort((left, right) => right.lastFrameAt - left.lastFrameAt)
    .map((runtime) => runtime.control);
}

/**
 * The first answer a live CLI gives `read`, or undefined when none does and
 * the caller should probe.
 *
 * `read` answers undefined for a control that cannot serve it. A failure or a
 * slow answer moves on to the next CLI: the probe still answers
 * authoritatively, so a live read only ever saves a spawn.
 */
export async function readFromLiveClaude<T>(
  read: (control: ClaudeQueryControl) => Promise<T | undefined> | undefined,
  timeoutMs = LIVE_CLAUDE_READ_TIMEOUT_MS,
): Promise<T | undefined> {
  for (const control of liveClaudeControls()) {
    try {
      const answer = read(control);
      if (answer === undefined) continue;
      // A slow answer moves on; `boundedWait` keeps its late settlement handled.
      const outcome = await boundedWait(answer, timeoutMs);
      if (outcome.settled && outcome.value !== undefined) return outcome.value;
    } catch (error) {
      debugLog("[live-claude-control] A running CLI could not answer:", error);
    }
  }
  return undefined;
}

/** The running CLI's initialize answer, held by the SDK: no request is sent. */
export function liveInitializationResult(
  control: ClaudeQueryControl,
): Promise<Record<string, unknown> | undefined> | undefined {
  if (typeof control.initializationResult !== "function") return undefined;
  return control
    .initializationResult()
    .then((result) =>
      result && typeof result === "object" ? (result as Record<string, unknown>) : undefined,
    );
}

/**
 * How long a rejoin waits for the CLI to answer the re-sent `initialize`
 * before writing its prompt anyway. The join already waits on several control
 * requests to the same process; this one only must not hold it for long.
 */
export const REJOIN_INVENTORY_TIMEOUT_MS = 2_000;

/**
 * What re-reading a live CLI's initialize inventory came to. Only `read` means
 * the CLI answered; every other outcome leaves what it waits on unknown.
 */
export type LiveClaudeInventoryOutcome = "read" | "unsupported" | "timeout" | "failed" | "skipped";

/**
 * Re-send `initialize` to a running CLI, so the SDK redelivers the requests
 * the CLI still waits on.
 *
 * The answer's `pending_permission_requests` and `pending_user_dialog_requests`
 * reach `canUseTool` and `onUserDialog` through the SDK itself, which skips an
 * id it is still answering; `ClaudeControlRequests` refuses an id the bridge
 * already answered. The pinned SDK (0.3.326) drops
 * `pending_elicitation_requests` and hands the caller none of the three lists,
 * so the elicitation inventory stays unknown: nothing is withdrawn or raised
 * for its absence (pinned in `live-claude-control.test.ts` and, on the real
 * CLI, `claude-rejoin-requests.live.test.ts`).
 *
 * Over stdio the re-sent request repeats the launch's hooks (same callback
 * ids), prompts and agents. MCP servers, plugins and managed settings are not
 * in it while they go on the command line (`argv`, `claudeExecutableOptions`);
 * moving any of them to `initialize` delivery would make every rejoin restate
 * the launch's set over the live one. The CLI also settles a hook callback it
 * was still waiting on (a pending PreToolUse is denied with a retry notice).
 */
export async function reinitializeLiveClaude(
  control: ClaudeQueryControl,
  timeoutMs = REJOIN_INVENTORY_TIMEOUT_MS,
): Promise<Exclude<LiveClaudeInventoryOutcome, "skipped">> {
  if (typeof control.reinitialize !== "function") return "unsupported";
  try {
    // A late answer still redelivers; the ledger keeps that to one card.
    const outcome = await boundedWait(control.reinitialize(), timeoutMs);
    return outcome.settled ? "read" : "timeout";
  } catch (error) {
    log.warn("rejoin.inventory-failed", { error: formatLogError(error) });
    return "failed";
  }
}

/**
 * A prompt is being written into `runtime`, a CLI that outlived the turn that
 * started it: recover the permission requests only that CLI still knows of.
 *
 * Only the join path calls this. A tab that remounts reads the cards the
 * bridge already holds (`/interactions`, `/questions`, `/plan-approvals`) and
 * never reaches a CLI, so it is not a rejoin and costs no control request.
 * Never throws and never refuses the join.
 */
export async function recoverClaudeRequestsOnRejoin(
  runtime: ClaudeRuntime,
  timeoutMs = REJOIN_INVENTORY_TIMEOUT_MS,
): Promise<LiveClaudeInventoryOutcome> {
  runtime.rejoins += 1;
  const outcome: LiveClaudeInventoryOutcome =
    runtime.state !== "open" || runtime.abortController.signal.aborted || runtime.requests.ended
      ? "skipped"
      : await reinitializeLiveClaude(runtime.control, timeoutMs);
  log.info("rejoin.inventory-read", {
    outcome,
    generation: runtime.generation,
    rejoins: runtime.rejoins,
    openRequests: runtime.requests.openCount,
  });
  return outcome;
}
