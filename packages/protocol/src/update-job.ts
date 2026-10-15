/**
 * The update job state machine. Pure: `transitionUpdateJob` returns the next
 * job or throws, and every caller (the backend service, its tests, the
 * renderer's progress view) agrees on which edges exist.
 *
 *   approved → fetching-dependencies → downloading → ready → installing
 *            → restarting → verifying → succeeded
 *
 * Before `installing` nothing on the machine has changed, so any failure is
 * `failed` and the job can be `cancelled`. From `installing` on, a failure
 * must go through rollback: `rolled-back`, or `failed` only with
 * `rollbackFailed` (the one state that needs a human).
 */
import type { UpdateJob, UpdateJobError, UpdateJobPhase, UpdateJobStep } from "./updates.js";

export type UpdateJobEvent =
  | { type: "fetch-dependencies" }
  | { type: "download" }
  | { type: "ready" }
  | { type: "install" }
  | { type: "restarting" }
  | { type: "verify" }
  | { type: "succeed" }
  | { type: "progress"; step: UpdateJobStep; percent: number | null; message: string | null }
  | { type: "fail"; error: UpdateJobError; rollbackFailed?: boolean }
  | { type: "roll-back"; error: UpdateJobError }
  | { type: "cancel" };

export class InvalidUpdateTransition extends Error {
  constructor(phase: UpdateJobPhase, event: UpdateJobEvent["type"]) {
    super(`An update job in ${phase} cannot ${event}`);
    this.name = "InvalidUpdateTransition";
  }
}

const PRE_INSTALL: ReadonlySet<UpdateJobPhase> = new Set([
  "approved",
  "fetching-dependencies",
  "downloading",
  "ready",
]);
const INSTALL_ONWARDS: ReadonlySet<UpdateJobPhase> = new Set([
  "installing",
  "restarting",
  "verifying",
]);

/** The only forward edges; failures, rollback and cancel are checked separately. */
const FORWARD: Partial<Record<UpdateJobEvent["type"], [UpdateJobPhase[], UpdateJobPhase]>> = {
  "fetch-dependencies": [["approved"], "fetching-dependencies"],
  download: [["fetching-dependencies"], "downloading"],
  ready: [["downloading"], "ready"],
  install: [["ready"], "installing"],
  restarting: [["installing"], "restarting"],
  verify: [["restarting"], "verifying"],
  succeed: [["verifying"], "succeeded"],
};

/** The edges, for tests and documentation. */
export function allowedUpdateTransitions(phase: UpdateJobPhase): UpdateJobPhase[] {
  const next = Object.values(FORWARD)
    .filter(([from]) => from.includes(phase))
    .map(([, to]) => to);
  if (PRE_INSTALL.has(phase)) next.push("failed", "cancelled");
  if (INSTALL_ONWARDS.has(phase)) next.push("rolled-back", "failed");
  return next;
}

export function transitionUpdateJob(job: UpdateJob, event: UpdateJobEvent, at: string): UpdateJob {
  const phase = job.phase;
  const forward = FORWARD[event.type];
  if (forward) {
    if (!forward[0].includes(phase)) throw new InvalidUpdateTransition(phase, event.type);
    return { ...job, phase: forward[1], updatedAt: at, progress: null };
  }
  switch (event.type) {
    case "progress":
      if (!PRE_INSTALL.has(phase) && !INSTALL_ONWARDS.has(phase)) {
        throw new InvalidUpdateTransition(phase, event.type);
      }
      return {
        ...job,
        updatedAt: at,
        progress: {
          step: event.step,
          percent:
            event.percent === null ? null : Math.max(0, Math.min(100, Math.round(event.percent))),
          message: event.message,
        },
      };
    case "fail":
      if (PRE_INSTALL.has(phase)) {
        return { ...job, phase: "failed", updatedAt: at, progress: null, error: event.error };
      }
      // Past this point a failure that did not restore the old version is
      // the only `failed`; anything else must report its rollback.
      if (INSTALL_ONWARDS.has(phase) && event.rollbackFailed) {
        return {
          ...job,
          phase: "failed",
          updatedAt: at,
          progress: null,
          error: event.error,
          rollbackFailed: true,
        };
      }
      throw new InvalidUpdateTransition(phase, event.type);
    case "roll-back":
      if (!INSTALL_ONWARDS.has(phase)) throw new InvalidUpdateTransition(phase, event.type);
      return { ...job, phase: "rolled-back", updatedAt: at, progress: null, error: event.error };
    case "cancel":
      if (!PRE_INSTALL.has(phase)) throw new InvalidUpdateTransition(phase, event.type);
      return { ...job, phase: "cancelled", updatedAt: at, progress: null };
    default:
      throw new InvalidUpdateTransition(phase, event.type);
  }
}

/**
 * Walks a job forward to `phase` through the edges in between, for a host
 * outcome that arrives after a restart skipped the intermediate reports (an
 * install-on-quit lands straight from `ready`).
 */
export function advanceUpdateJobTo(
  job: UpdateJob,
  phase: "installing" | "restarting" | "verifying",
  at: string,
): UpdateJob {
  const order: Array<[UpdateJobPhase, UpdateJobEvent]> = [
    ["ready", { type: "install" }],
    ["installing", { type: "restarting" }],
    ["restarting", { type: "verify" }],
  ];
  let current = job;
  for (const [from, event] of order) {
    if (current.phase === phase) break;
    if (current.phase === from) current = transitionUpdateJob(current, event, at);
  }
  if (current.phase !== phase) throw new InvalidUpdateTransition(job.phase, "verify");
  return current;
}
