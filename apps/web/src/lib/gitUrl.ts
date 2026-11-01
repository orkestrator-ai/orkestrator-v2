import { parseGitHubRepositoryRemote } from "@orkestrator/protocol/github-repository";

/**
 * Converts a GitHub clone URL into the canonical repository page URL.
 * Returns null for non-GitHub remotes and malformed repository paths.
 */
export function getGitHubRepositoryUrl(gitUrl: string): string | null {
  const result = parseGitHubRepositoryRemote(gitUrl);
  if (!result.ok) return null;
  return `https://github.com/${result.repository.owner}/${result.repository.name}`;
}
