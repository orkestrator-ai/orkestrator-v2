/**
 * Whether a pull request targets the branch its project's settings name as
 * the PR base. An agent can open a pull request against another branch (a
 * `--base` it chose itself, or a stale default), and merging that one lands
 * the work somewhere the user did not intend. The action bar's merge dialog,
 * the ticket view and the pull request screen all show the PR's real base in
 * red and ask before merging when this returns a mismatch.
 */
import type { GitHubPullRequestRef } from "@orkestrator/protocol/github-pull-requests";
import { parseGitHubRepositoryRemote } from "@orkestrator/protocol/github-repository";

/** The two settings fields the configured target is read from. */
export type PrTargetRepositoryConfig = {
  prBaseBranch?: string | null;
  defaultBranch?: string | null;
};

export type PrTargetMismatch = {
  /** The branch the pull request actually merges into. */
  actual: string;
  /** The project's configured PR base branch. */
  configured: string;
};

/**
 * The project's configured PR target: its PR base branch, else its default
 * branch, as the backend's PR monitor reads them. Blank values count as
 * unset, because settings persist a cleared base as `""`. `null` when the
 * project's settings are not known, so nothing is flagged on a guess.
 */
export function configuredPrTargetBranch(
  repository: PrTargetRepositoryConfig | null | undefined,
): string | null {
  if (!repository) return null;
  return repository.prBaseBranch?.trim() || repository.defaultBranch?.trim() || "main";
}

/**
 * The mismatch between a pull request's base and the configured target, or
 * `null` when they agree or either is unknown. The PR monitor records the
 * observed base on the environment (`prBaseBranch`); a PR it has not read yet
 * has none, and is not flagged.
 */
export function prTargetMismatch(input: {
  actualBase: string | null | undefined;
  configuredBase: string | null | undefined;
}): PrTargetMismatch | null {
  const actual = input.actualBase?.trim();
  const configured = input.configuredBase?.trim();
  if (!actual || !configured || actual === configured) return null;
  return { actual, configured };
}

type PrTargetProject = { id: string; gitUrl: string };

/**
 * The configured target for a pull request opened by reference, found
 * through the project whose GitHub remote is the PR's repository. A pull
 * request in a repository no project tracks has no configured target. When
 * several projects track the repository and their settings disagree, the
 * target is ambiguous and nothing is flagged.
 */
export function configuredPrTargetForPullRequest(
  ref: Pick<GitHubPullRequestRef, "owner" | "repo">,
  projects: readonly PrTargetProject[],
  repositories: Readonly<Record<string, PrTargetRepositoryConfig | undefined>>,
): string | null {
  const owner = ref.owner.toLowerCase();
  const repo = ref.repo.toLowerCase();
  const targets = new Set<string>();
  for (const project of projects) {
    const parsed = parseGitHubRepositoryRemote(project.gitUrl);
    if (!parsed.ok) continue;
    if (
      parsed.repository.owner.toLowerCase() !== owner ||
      parsed.repository.name.toLowerCase() !== repo
    ) {
      continue;
    }
    const target = configuredPrTargetBranch(repositories[project.id]);
    if (target) targets.add(target);
  }
  return targets.size === 1 ? ([...targets][0] ?? null) : null;
}
