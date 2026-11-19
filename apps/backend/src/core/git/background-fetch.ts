/**
 * The nonintrusive fetch mode used by background freshness work.
 *
 * Orkestrator fetches on its own schedule to keep diff baselines and remote
 * status current, in checkouts a user or an agent is working in at the same
 * time. A plain `git fetch origin <branch>` has two side effects such a fetch
 * must not have:
 *
 *  - It rewrites `FETCH_HEAD`, which the person in that checkout may be about
 *    to use (`git merge FETCH_HEAD`, `git log ..FETCH_HEAD`). FETCH_HEAD is per
 *    worktree, so a coalesced background fetch would replace it in whichever
 *    worktree happened to run it. `--no-write-fetch-head` (git 2.29+) skips
 *    that write; `project-git-mirror.ts` already relies on the same flag.
 *  - It updates `refs/remotes/origin/<branch>` only opportunistically, when
 *    the remote's configured fetch refspec happens to cover the branch. A
 *    single-branch clone or a narrowed refspec then fetches the objects and
 *    updates nothing the caller reads. An explicit force refspec names the one
 *    remote-tracking ref the caller resolves afterwards.
 *
 * Fetches a user asks for, and any whose consumer reads `FETCH_HEAD`
 * (`agents-md-pr.ts`), keep git's default behaviour and do not use this.
 */

/** Suppresses git's write of fetched refs to the worktree's `FETCH_HEAD`. */
export const NO_WRITE_FETCH_HEAD = "--no-write-fetch-head";

/** A full SHA-1 or SHA-256 object name rather than a branch. */
const FULL_OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * The refspec a background fetch of `ref` uses: a force refspec onto
 * `refs/remotes/origin/<ref>` for a branch, or the object name alone for a
 * full commit SHA (a recorded creation commit), which has no branch to track
 * and only needs its objects present.
 *
 * `ref` must already be a validated ref name or SHA: it is interpolated into
 * the refspec, and neither form can begin with `-`.
 */
export function backgroundFetchRefspec(ref: string): string {
  return FULL_OBJECT_NAME.test(ref) ? ref : `+refs/heads/${ref}:refs/remotes/origin/${ref}`;
}

/**
 * Arguments after `git fetch` that update exactly `refs/remotes/origin/<ref>`
 * (or fetch one commit's objects) and leave `FETCH_HEAD` untouched.
 */
export function backgroundFetchArgs(ref: string): string[] {
  return [NO_WRITE_FETCH_HEAD, "origin", backgroundFetchRefspec(ref)];
}
