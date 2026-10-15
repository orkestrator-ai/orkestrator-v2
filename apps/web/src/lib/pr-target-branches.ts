import type { ProjectGitBranch } from "@orkestrator/protocol/coordinator";

/**
 * Branch names a pull request could target, as `gh pr create --base` expects
 * them. A PR base has to exist on the remote, so remote-tracking branches are
 * offered with their remote prefix stripped; local branches are only a fallback
 * for a repository that has never been fetched. The configured default leads.
 */
export function prTargetBranchSuggestions(
  branches: readonly ProjectGitBranch[],
  defaultBranch: string,
): string[] {
  const remote = branches.flatMap((branch) =>
    branch.kind === "remote" && branch.remote && branch.name.startsWith(`${branch.remote}/`)
      ? [branch.name.slice(branch.remote.length + 1)]
      : [],
  );
  const names =
    remote.length > 0
      ? remote
      : branches.flatMap((branch) => (branch.kind === "local" ? [branch.name] : []));
  const unique = [...new Set(names)].filter((name) => name !== defaultBranch).sort();
  return defaultBranch ? [defaultBranch, ...unique] : unique;
}
