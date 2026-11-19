/**
 * Whether a pull request targets the branch its project's settings name as
 * the PR base. An agent can open a pull request against another branch (a
 * `--base` it chose itself, or a stale default), and merging that one lands
 * the work somewhere the user did not intend. The action bar's merge dialog,
 * the ticket view and the pull request screen all show the PR's real base in
 * red and ask before merging when this returns a mismatch.
 */
import type { EnvironmentPrDestination } from "@/lib/backend/config-integrations";
import { defaultPrTargetBranch } from "@orkestrator/protocol/git-workflow-prompts";
export { configuredPrTargetForPullRequest } from "@orkestrator/protocol/github-repository";

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
 * The project's configured PR target uses the same fallback as PR creation. Blank values count as
 * unset, because settings persist a cleared base as `""`. `null` when the
 * project's settings are not known, so nothing is flagged on a guess.
 */
export function configuredPrTargetBranch(
  repository: PrTargetRepositoryConfig | null | undefined,
): string | null {
  if (!repository) return null;
  return defaultPrTargetBranch(repository.prBaseBranch);
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

export function environmentPrDestination(
  prUrl: string | null | undefined,
  actualBase: string | null | undefined,
  configuredBase: string | null,
): EnvironmentPrDestination | null {
  const base = actualBase?.trim();
  if (!prUrl || !base) return null;
  return {
    expectedPrUrl: prUrl,
    expectedBaseRef: base,
    ...(configuredBase ? { expectedTargetBranch: configuredBase } : {}),
  };
}

export function pullRequestLabel(url: string | null | undefined): string {
  const number = url?.match(/\/pull\/(\d+)/)?.[1];
  return number ? `pull request #${number}` : "this pull request";
}
