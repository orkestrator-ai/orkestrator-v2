/**
 * The exact commit a new local environment starts from.
 *
 * The creation dialog refreshes the project's base branch while it is open and
 * resolves it to one commit. That commit is sent with the create request, so
 * the start creates the worktree from it directly instead of fetching from the
 * remote first: the network round trip, and its two-minute deadline, leave the
 * blocking path, and the starting commit is the one the user saw.
 * See docs/architecture/worktree-launch-base.md.
 */

/** `get_project_base_branch_tip`'s answer (backend `ProjectBaseBranchTip`). */
export interface ProjectBaseBranchTip {
  branch: string;
  commit: string | null;
  /** `origin/<branch>` when the remote has it, otherwise the local branch. */
  ref?: string | null;
  /** True only when this read refreshed `ref` from the remote. */
  fetched?: boolean;
  /** ISO time of the last successful refresh; absent when unknown. */
  fetchedAt?: string;
  fetchError?: string;
  unavailableReason?: string;
  /** Older backends cannot opt a tip into the dialog's pinned create. */
  launchEligible?: boolean;
}

/** The shown commit, or a request for first start to finish the same base refresh. */
export type EnvironmentLaunchBase = { branch: string; commit: string } | { pending: true };

/**
 * How current a resolved base is:
 * - `fresh`: refreshed from the remote by this read or a moment before it;
 * - `last-fetched`: the remote could not be refreshed, so this is the commit
 *   the remote-tracking ref held after its last successful fetch;
 * - `local`: a project with no remote, whose own branch is the base.
 */
export type LaunchBaseFreshness = "fresh" | "last-fetched" | "local";

export type LaunchBaseState =
  | { status: "idle" }
  | { status: "resolving" }
  | {
      status: "ready";
      freshness: LaunchBaseFreshness;
      branch: string;
      /** What the commit was read from: `origin/<branch>` or `<branch>`. */
      ref: string;
      commit: string;
      fetchedAt?: string;
      fetchError?: string;
    }
  | { status: "unavailable"; reason: string };

const FULL_COMMIT = /^[0-9a-f]{40}$/i;

/** Classifies a tip; never throws, whatever shape an older backend answers with. */
export function classifyLaunchBaseTip(tip: ProjectBaseBranchTip | null): LaunchBaseState {
  const branch = typeof tip?.branch === "string" ? tip.branch.trim() : "";
  const commit = typeof tip?.commit === "string" ? tip.commit.trim().toLowerCase() : "";
  if (tip?.launchEligible !== true || !branch || !FULL_COMMIT.test(commit)) {
    return {
      status: "unavailable",
      reason:
        tip?.unavailableReason?.trim() ||
        (tip?.fetchError && branch
          ? `origin/${branch} could not be read. The base resolves when the environment starts`
          : "The base branch could not be resolved"),
    };
  }
  const fetchError = tip.fetchError?.trim() || undefined;
  const fetchedAt = tip.fetchedAt?.trim() || undefined;
  const remoteRef = `origin/${branch}`;
  if (tip.ref === remoteRef) {
    const fresh = !fetchError && (tip.fetched === true || fetchedAt !== undefined);
    return {
      status: "ready",
      freshness: fresh ? "fresh" : "last-fetched",
      branch,
      ref: remoteRef,
      commit,
      ...(fetchedAt ? { fetchedAt } : {}),
      ...(fetchError ? { fetchError } : {}),
    };
  }
  if (tip.ref === branch && !fetchError) {
    return { status: "ready", freshness: "local", branch, ref: branch, commit };
  }
  return { status: "unavailable", reason: "The base branch could not be resolved" };
}

/** A definitive unavailable result uses the usual unpinned start. */
export function launchBaseForCreate(state: LaunchBaseState): EnvironmentLaunchBase | undefined {
  if (state.status === "ready") return { branch: state.branch, commit: state.commit };
  if (state.status === "resolving") return { pending: true };
  return undefined;
}
