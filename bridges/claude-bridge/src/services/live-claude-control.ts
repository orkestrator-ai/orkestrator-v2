// Bridge-wide reads from a Claude CLI that is already running.
//
// The model catalogue, the account and the plan-usage windows are not
// session state, and without a running CLI each read spawns one through
// `controlOnlyQuery` for a single answer. The bridge serves one environment
// and keeps its sessions' CLIs warm between turns, so one is often running
// already: its initialize answer holds the models and the account, and its
// control channel answers `/usage`.

import type { ClaudeQueryControl } from "../types/index.js";
import { debugLog } from "./logger.js";
import { sessions } from "./session-manager-core.js";

/** How long one live CLI may take to answer before the read moves on. */
export const LIVE_CLAUDE_READ_TIMEOUT_MS = 5_000;

/**
 * Whether a CLI launched with these settings sources reads the settings a
 * probe reads. A probe passes none, so it loads user, project and local
 * settings, and user and project settings can narrow the model list
 * (`availableModels`). A coordinator turn launches with none at all.
 */
function readsProbeSettings(settingSources: string | undefined): boolean {
  if (settingSources === undefined) return false;
  try {
    const sources = JSON.parse(settingSources) as unknown;
    return Array.isArray(sources) && sources.includes("user") && sources.includes("project");
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = read(control);
      if (answer === undefined) continue;
      // The losing side of the race still settles; keep it handled.
      answer.catch(() => undefined);
      const value = await Promise.race([
        answer,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
        }),
      ]);
      if (value !== undefined) return value;
    } catch (error) {
      debugLog("[live-claude-control] A running CLI could not answer:", error);
    } finally {
      clearTimeout(timer);
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
