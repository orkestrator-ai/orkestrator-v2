import type { ReviewWorktreeSnapshot } from "./build-pipeline-prompts.js";

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

export async function probeReviewWorktreeOnce(
  invoke: ReviewWorktreeProbeInvoker,
  environmentId: string,
): Promise<ReviewWorktreeSnapshot> {
  try {
    const result = await invoke<{ head?: unknown; paths?: unknown }>(
      "get_environment_uncommitted_paths",
      { environmentId },
    );
    const paths = result?.paths;
    const head = result?.head;
    if (
      typeof head !== "string"
      || !/^[0-9a-f]{40,64}$/i.test(head)
      || !Array.isArray(paths)
      || paths.some((entry) => typeof entry !== "string")
    ) {
      return { status: "unknown", reason: "the worktree probe returned an unusable result" };
    }
    return paths.length === 0
      ? { status: "clean", head }
      : { status: "dirty", paths: paths as string[], head };
  } catch (error) {
    // The message can quote repository paths, so only the error class name is
    // kept, and only after stripping anything that is not a bare identifier.
    const name = error instanceof Error
      ? error.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40)
      : "";
    return { status: "unknown", reason: name ? `probe failed (${name})` : "probe failed" };
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

export async function probeReviewWorktree(
  invoke: ReviewWorktreeProbeInvoker,
  environmentId: string,
  attempts: number = REVIEW_WORKTREE_PROBE_ATTEMPTS,
): Promise<ReviewWorktreeSnapshot> {
  let last = await probeReviewWorktreeOnce(invoke, environmentId);
  for (let attempt = 1; attempt < attempts && last.status === "unknown"; attempt += 1) {
    last = await probeReviewWorktreeOnce(invoke, environmentId);
  }
  return last;
}
