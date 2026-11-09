/**
 * The branch an environment owns.
 *
 * Every environment branch carries a compact prefix of its environment's id
 * (`<slug>-<namespace>[-r<revision>][-<collision suffix>]`), minted before the
 * branch is allocated. That namespace is the one durable proof that a branch
 * was created for an environment rather than adopted from the repository.
 *
 * Branch cleanup (deleting a merged branch on GitHub, deleting the local branch
 * when an environment is removed) may only ever touch a branch that proof
 * covers. A base branch such as `main` or `dev`, a branch the user checked out
 * by hand, or another environment's branch never matches, so no cleanup path
 * can delete it however the environment, its pull request or a merge request
 * names it.
 *
 * Browser-safe: the pull request view uses the same rule to decide whether to
 * offer branch deletion at all.
 */

const ENVIRONMENT_BRANCH_NAMESPACE_LENGTH = 12;

/**
 * `<slug>-<namespace>[-r<revision>][-<collision suffix>]` for an environment
 * whose id is a UUID, so the namespace is 12 hex characters. Up to two numeric
 * suffixes cover branch allocation running at allocation and again when the
 * worktree is created.
 */
const ENVIRONMENT_BRANCH_PATTERN =
  /^[a-z0-9_][a-z0-9_-]*-([0-9a-f]{12})(?:-r[1-9][0-9]{0,5})?(?:-[1-9][0-9]{0,5}){0,2}$/;

/** The compact environment-id prefix embedded in every environment branch name. */
export function environmentBranchNamespace(environmentId: string): string {
  return environmentId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, ENVIRONMENT_BRANCH_NAMESPACE_LENGTH);
}

/** The namespace of a branch named by the environment scheme, or null. */
export function parseEnvironmentBranchNamespace(branch: string): string | null {
  return ENVIRONMENT_BRANCH_PATTERN.exec(branch)?.[1] ?? null;
}

/**
 * True only when `branch` is named by the environment scheme with exactly
 * `namespace`. A namespace that is not 12 hex characters (an environment id
 * that is not a UUID) owns nothing.
 */
export function isBranchInEnvironmentNamespace(
  namespace: string,
  branch: string | null | undefined,
): boolean {
  if (!branch || !/^[0-9a-f]{12}$/.test(namespace)) return false;
  return parseEnvironmentBranchNamespace(branch) === namespace;
}

/** True only for the branch Orkestrator created for environment `environmentId`. */
export function isEnvironmentOwnedBranch(
  environmentId: string,
  branch: string | null | undefined,
): boolean {
  return isBranchInEnvironmentNamespace(environmentBranchNamespace(environmentId), branch);
}

/**
 * True for a branch Orkestrator created for some environment, when the caller
 * has no environment to compare against (the pull request view merges a PR
 * that may belong to an environment on another machine).
 */
export function isEnvironmentBranchName(branch: string | null | undefined): boolean {
  return !!branch && parseEnvironmentBranchNamespace(branch) !== null;
}
