/**
 * Keeps the project's checkout on its upstream before agent mail wakes the
 * main coordinator.
 *
 * The coordinator reads the project's own checkout. A message the user types
 * already fast-forwards it first (`check_coordinator_upstream_merge`, from the
 * panel), but mail arrives without a client: a worker's report, a side
 * agent's question or a status notice. Without this, the coordinator answers
 * that mail from the code as it was before commits that have since landed on
 * the remote, often the very commits the report is about.
 *
 * So before a mail inject dispatches to the main coordinator, the backend runs
 * the same rule (`@orkestrator/protocol/coordinator-upstream-merge`): a
 * cooldown-bound fetch, then a fast-forward whenever Git can do it cleanly. A
 * checkout with local commits, uncommitted changes or an unfinished operation
 * is left alone, and nothing changes under a running coordinator or
 * project-home turn. Side agents do not merge, as with typed messages.
 *
 * The wait is bounded. A slow or unreachable remote delays the mail by at most
 * `timeoutMs`; past it the mail is delivered without merging, and the late
 * fetch is told not to start a fast-forward. A fast-forward that has begun is
 * never abandoned: the turn's own admission waits for it
 * (`beginTurnAfterMergeSync`), so it cannot run against a half-changed
 * checkout. Every failure is logged and swallowed; mail is never held back by
 * this step.
 */
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { openCoordinatorConversation } from "./coordinator-runtime.js";
import {
  fastForwardProjectCheckout,
  type ProjectCheckoutFollowOutcome,
  type ProjectCheckoutGit,
} from "./project-checkout-merge-follow.js";
import type { StorageService } from "./storage.js";

const log = createLogger("coordinator");

/** How long mail waits for the fetch before it is delivered anyway. */
export const COORDINATOR_MAIL_UPSTREAM_TIMEOUT_MS = 5_000;

export type CoordinatorMailUpstreamOutcome =
  | ProjectCheckoutFollowOutcome
  /** Not a coordinator, a side agent, or a coordinator that is not ready. */
  | "skipped"
  /** The fetch outlasted the bound; the mail went on without merging. */
  | "timed-out";

export interface CoordinatorMailUpstreamDeps {
  storage: Pick<StorageService, "coordinators">;
  git: ProjectCheckoutGit | undefined;
  timeoutMs?: number;
}

/**
 * Fast-forwards the checkout behind `runtimeId` before mail is injected into
 * it, when it is the main coordinator and Git can do so cleanly. Never throws.
 */
export async function fastForwardBeforeCoordinatorMail(
  deps: CoordinatorMailUpstreamDeps,
  runtimeId: string,
): Promise<CoordinatorMailUpstreamOutcome> {
  const git = deps.git;
  if (!git) return "skipped";
  let projectId: string | undefined;
  try {
    const open = await openCoordinatorConversation(deps.storage, runtimeId);
    if (
      !open ||
      open.workspace.lifecycleState !== "ready" ||
      open.conversation.role === "side" ||
      !open.conversation.agent
    ) {
      return "skipped";
    }
    projectId = open.workspace.projectId;
    let waiting = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = fastForwardProjectCheckout(git, projectId, {
      forceFetch: false,
      proceed: () => waiting,
    });
    const outcome = await Promise.race([
      attempt,
      new Promise<"timed-out">((resolve) => {
        timer = setTimeout(
          () => resolve("timed-out"),
          deps.timeoutMs ?? COORDINATOR_MAIL_UPSTREAM_TIMEOUT_MS,
        );
      }),
    ]).finally(() => {
      waiting = false;
      clearTimeout(timer);
    });
    if (outcome === "timed-out") {
      // Keep the late attempt's rejection handled; it only logs.
      void attempt.catch(() => undefined);
    }
    if (outcome === "fast-forwarded" || outcome === "timed-out" || outcome === "failed") {
      log.info("checkout.mail-follow", { projectId, outcome });
    }
    return outcome;
  } catch (error) {
    log.warn("checkout.mail-follow-failed", {
      ...(projectId ? { projectId } : {}),
      error: formatLogError(error),
    });
    return "failed";
  }
}
