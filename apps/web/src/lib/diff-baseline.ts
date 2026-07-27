import type { RepositoryConfig } from "@/types";

/** Last-resort baseline when a repository has no branch configured at all. */
export const FALLBACK_COMPARISON_REF = "main";

type BaselineRepositoryConfig = Pick<RepositoryConfig, "prBaseBranch" | "defaultBranch">;

/**
 * Resolves the git ref an environment's changes are measured against.
 *
 * Shared by the sidebar diff badge and the Files panel: the two showed different
 * numbers for the same environment when only one of them knew about a setting.
 *
 * The commit recorded at creation wins because it is exact and immutable. The
 * configured PR base branch is next, since that is the branch the work is
 * destined for. `defaultBranch` is the fallback rather than a literal "main":
 * a repository on `master` or `trunk` would otherwise be measured against a ref
 * that does not exist, and because diff stats are fetched on a best-effort path
 * the resulting failure is silent - the counts simply never appear.
 */
export function resolveComparisonRef(
  createdFromCommit: string | undefined | null,
  repositoryConfig: BaselineRepositoryConfig | undefined | null,
): string {
  return createdFromCommit
    || repositoryConfig?.prBaseBranch
    || repositoryConfig?.defaultBranch
    || FALLBACK_COMPARISON_REF;
}
