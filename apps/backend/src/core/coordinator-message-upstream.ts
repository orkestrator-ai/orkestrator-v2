/**
 * The backend half of "fast-forward the checkout before a message to the main
 * coordinator" (`check_coordinator_upstream_merge`, asked by the panel before
 * each send).
 *
 * The fetch is bounded. When it is slow or fails, the checkout is still
 * fast-forwarded to the upstream commit it already has
 * (`fastForwardToFetchedUpstream`), under the same rules, so a slow remote
 * costs only the commits it has not delivered yet. The late fetch only
 * refreshes the status: nothing merges after the answer has gone. A fetch that
 * answers in time is decided by the protocol rule
 * (`@orkestrator/protocol/coordinator-upstream-merge`) and the panel syncs.
 *
 * Every check logs `checkout.message-check` (content-free: outcome, fetch
 * result, duration), as mail does with `checkout.mail-follow`.
 */
import {
  decideUpstreamMergeOffer,
  type CoordinatorUpstreamMergeCheck,
} from "@orkestrator/protocol/coordinator-upstream-merge";
import type { ProjectGitStatus } from "@orkestrator/protocol/coordinator";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { ProjectGitService } from "./project-git-service.js";

const log = createLogger("coordinator");

/**
 * How long the check waits for the fetch. Below the panel's own five-second
 * bound, so a fast-forward to the fetched upstream still answers in time.
 */
export const COORDINATOR_MESSAGE_FETCH_TIMEOUT_MS = 3_000;

export type CoordinatorMessageGit = Pick<
  ProjectGitService,
  "isCheckoutBusy" | "fetch" | "fastForwardToFetchedUpstream"
>;

/** Whether a fetch result reflects the remote, rather than a failed or stale read. */
export function fetchedFromRemote(status: ProjectGitStatus | null): status is ProjectGitStatus {
  return Boolean(
    status && status.remoteState !== "stale" && status.lastError?.operation !== "fetch",
  );
}

export async function checkUpstreamBeforeMessage(
  git: CoordinatorMessageGit,
  projectId: string,
  options: { timeoutMs?: number; now?: () => number } = {},
): Promise<CoordinatorUpstreamMergeCheck> {
  const now = options.now ?? Date.now;
  const started = now();
  let fetch: "skipped" | "fetched" | "failed" | "timed-out" = "skipped";
  const answer = (check: CoordinatorUpstreamMergeCheck) => {
    log.info("checkout.message-check", {
      projectId,
      outcome: check.offer ? "offer" : check.reason,
      fetch,
      durationMs: now() - started,
    });
    return check;
  };
  // The backend refuses to change the checkout under a running turn, so there
  // is nothing to offer; and no fetch is started for it either.
  if (await git.isCheckoutBusy(projectId)) {
    return answer({ offer: false, reason: "turn-running", status: null });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = git.fetch(projectId).catch(() => null);
  const fetched = await Promise.race([
    pending,
    new Promise<"timed-out">((resolve) => {
      timer = setTimeout(
        () => resolve("timed-out"),
        options.timeoutMs ?? COORDINATOR_MESSAGE_FETCH_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  if (fetched !== "timed-out" && fetchedFromRemote(fetched)) {
    fetch = "fetched";
    return answer(decideUpstreamMergeOffer(fetched));
  }
  fetch = fetched === "timed-out" ? "timed-out" : "failed";
  try {
    const local = await git.fastForwardToFetchedUpstream(projectId);
    if (local.outcome === "busy") {
      return answer({ offer: false, reason: "turn-running", status: null });
    }
    if (local.outcome === "fast-forwarded") {
      return answer({ offer: false, reason: "fast-forwarded", status: local.status });
    }
    return answer({ offer: false, reason: local.outcome, status: local.status });
  } catch (error) {
    log.warn("checkout.message-check-failed", { projectId, error: formatLogError(error) });
    return answer({
      offer: false,
      reason: "no-status",
      status: fetched === "timed-out" ? null : fetched,
    });
  }
}
