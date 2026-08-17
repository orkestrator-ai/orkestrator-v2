import type { ReviewWorktreeSnapshot } from "./build-pipeline-prompts.js";
import { reviewWorktreeProbeReasonCode } from "./review-worktree-fingerprint.js";

/**
 * Observes the worktree a review is about to run in.
 *
 * Every review flow needs the same fact for a different reason — the build
 * pipeline certifies validation against it, a Multi Review tells its reviewers
 * that the uncommitted paths *are* the change — so the observation itself lives
 * here rather than in one owner's supervisor.
 *
 * A reviewer that re-derived this inside its own turn could quietly decide the
 * tree held nothing worth reviewing. Probing from the backend makes the state
 * the workflow's own evidence.
 */
export type ReviewWorktreeProbeInvoker =
  <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface ReviewWorktreeProbeOptions {
  /**
   * Ask for the content fingerprint. Off by default: hashing the whole diff and
   * every untracked file is the expensive part of the probe, and a caller that
   * only compares HEAD and the uncommitted path set must not pay for it.
   */
  fingerprint?: boolean;
}

/**
 * Turns a failed probe into a reason a person can act on without leaking
 * repository text into a prompt.
 *
 * The environment-side script reports a closed vocabulary of codes; anything
 * else is reduced to the error's class name with every non-identifier character
 * stripped, because the message can quote repository paths.
 */
function unknownReason(error: unknown): string {
  const code = error instanceof Error
    ? reviewWorktreeProbeReasonCode(error.message)
    : null;
  if (code) return `probe failed (${code})`;
  const details = (error ?? {}) as { executableMissing?: unknown; timedOut?: unknown };
  // A missing interpreter is the one failure a retry can never clear, so it is
  // worth naming separately from an ordinary command error.
  if (details.executableMissing === true) return "probe failed (interpreter-missing)";
  if (details.timedOut === true) return "probe failed (timeout)";
  const name = error instanceof Error
    ? error.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40)
    : "";
  return name ? `probe failed (${name})` : "probe failed";
}

export async function probeReviewWorktreeOnce(
  invoke: ReviewWorktreeProbeInvoker,
  environmentId: string,
  options: ReviewWorktreeProbeOptions = {},
): Promise<ReviewWorktreeSnapshot> {
  try {
    const result = await invoke<{ head?: unknown; paths?: unknown; fingerprint?: unknown }>(
      "get_environment_uncommitted_paths",
      { environmentId, ...(options.fingerprint ? { fingerprint: true } : {}) },
    );
    const paths = result?.paths;
    const head = result?.head;
    const fingerprint = result?.fingerprint;
    if (
      typeof head !== "string"
      || !/^[0-9a-f]{40,64}$/i.test(head)
      || !Array.isArray(paths)
      || paths.some((entry) => typeof entry !== "string")
      || (fingerprint !== undefined
        && (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/i.test(fingerprint)))
    ) {
      return { status: "unknown", reason: "the worktree probe returned an unusable result" };
    }
    // Silently downgrading to a path-only answer would let a caller that needs
    // content identity believe it had one.
    if (options.fingerprint && fingerprint === undefined) {
      return { status: "unknown", reason: "the worktree probe returned no content fingerprint" };
    }
    return paths.length === 0
      ? { status: "clean", head, ...(fingerprint ? { fingerprint } : {}) }
      : { status: "dirty", paths: paths as string[], head, ...(fingerprint ? { fingerprint } : {}) };
  } catch (error) {
    return { status: "unknown", reason: unknownReason(error) };
  }
}

/**
 * The probe is one command round trip into a container or worktree and can fail
 * transiently, so it is retried a bounded number of times before the caller is
 * told the state is unknown. Retries are immediate: a supervisor tick is not a
 * place to sleep, and the failures this covers — a momentarily busy daemon, a
 * lost exec — do not need a backoff to clear.
 */
export const REVIEW_WORKTREE_PROBE_ATTEMPTS = 3;

/**
 * Failures a retry cannot clear. Re-running a missing interpreter or a worktree
 * that exceeds the probe's byte caps just spends the same time again.
 */
const UNRETRYABLE_REASONS = [
  "interpreter-missing",
  "git-missing",
  "too-large",
];

function retryable(snapshot: ReviewWorktreeSnapshot): boolean {
  if (snapshot.status !== "unknown") return false;
  return !UNRETRYABLE_REASONS.some((reason) => snapshot.reason.includes(reason));
}

export async function probeReviewWorktree(
  invoke: ReviewWorktreeProbeInvoker,
  environmentId: string,
  attempts: number = REVIEW_WORKTREE_PROBE_ATTEMPTS,
  options: ReviewWorktreeProbeOptions = {},
): Promise<ReviewWorktreeSnapshot> {
  let last = await probeReviewWorktreeOnce(invoke, environmentId, options);
  for (let attempt = 1; attempt < attempts && retryable(last); attempt += 1) {
    last = await probeReviewWorktreeOnce(invoke, environmentId, options);
  }
  return last;
}
