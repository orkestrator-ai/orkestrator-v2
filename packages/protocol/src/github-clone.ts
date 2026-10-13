/**
 * Contract for browsing the signed-in GitHub CLI account's organizations and
 * repositories when adding a project by cloning from GitHub.
 */

/** Upper bound on repositories listed for one account. */
export const GITHUB_CLONE_REPOSITORY_LIMIT = 1000;

export interface GitHubCloneAccount {
  login: string;
  /** The signed-in user's own account, or an organization they belong to. */
  kind: "user" | "organization";
}

export interface GitHubCloneRepository {
  name: string;
  /** `owner/name`. */
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  /** ISO timestamp of the most recent push or metadata change. */
  updatedAt: string | null;
  /** Remote URL in the protocol the GitHub CLI is configured to use. */
  cloneUrl: string;
}

export interface GitHubCloneRepositoryList {
  repositories: GitHubCloneRepository[];
  /** True when the account has more repositories than the listing limit. */
  truncated: boolean;
}

/** Existing GitHub logins, including managed users; never an argv flag or path. */
export function isGitHubLogin(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
}

export type GitHubRepositorySortOrder = "recent" | "alphabetical";

const nameCollator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function compareGitHubNames(left: string, right: string): number {
  return nameCollator.compare(left, right);
}

/**
 * Most recently updated first, or by name. Repositories without a timestamp
 * sort after dated ones; ties fall back to the name so the order is stable.
 */
export function sortGitHubRepositories(
  repositories: readonly GitHubCloneRepository[],
  order: GitHubRepositorySortOrder,
): GitHubCloneRepository[] {
  const timestamp = (repository: GitHubCloneRepository) => {
    const parsed = repository.updatedAt ? Date.parse(repository.updatedAt) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  return [...repositories].sort((left, right) => {
    if (order === "recent") {
      const difference = timestamp(right) - timestamp(left);
      if (difference > 0) return 1;
      if (difference < 0) return -1;
    }
    return compareGitHubNames(left.name, right.name);
  });
}
