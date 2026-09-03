export type GitHubRepositoryRef = {
  owner: string;
  name: string;
};

export type GitHubRepositoryParseFailureReason =
  | "missing"
  | "invalid-url"
  | "unsupported-host-or-protocol"
  | "invalid-path";

export type GitHubRepositoryParseResult =
  | { ok: true; repository: GitHubRepositoryRef }
  | { ok: false; reason: GitHubRepositoryParseFailureReason };

const VALID_GITHUB_REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;

function repositoryRef(owner: string, name: string): GitHubRepositoryRef | null {
  const normalizedOwner = owner.trim();
  const normalizedName = name.trim().replace(/\.git$/i, "");
  if (
    !normalizedOwner ||
    !normalizedName ||
    !VALID_GITHUB_REPOSITORY_PART.test(normalizedOwner) ||
    !VALID_GITHUB_REPOSITORY_PART.test(normalizedName)
  ) {
    return null;
  }
  return { owner: normalizedOwner, name: normalizedName };
}

/**
 * Parses the GitHub URL stored on a project into a repository identity.
 *
 * Only github.com HTTPS and SSH remotes are accepted. The returned identity
 * contains no protocol, userinfo, port, query, or fragment from the input, so
 * callers can safely construct their own API paths and canonical page URLs.
 */
export function parseGitHubRepositoryRemote(gitUrl: string): GitHubRepositoryParseResult {
  const value = gitUrl.trim();
  if (!value) return { ok: false, reason: "missing" };

  const scpMatch = value.match(/^(?:[^@\s]+@)?github\.com:([^/\s]+)\/([^/\s]+)\/?$/i);
  if (scpMatch?.[1] && scpMatch[2]) {
    const repository = repositoryRef(scpMatch[1], scpMatch[2]);
    return repository ? { ok: true, repository } : { ok: false, reason: "invalid-url" };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }

  if (
    parsed.hostname.toLowerCase() !== "github.com" ||
    (parsed.protocol !== "https:" && parsed.protocol !== "ssh:")
  ) {
    return { ok: false, reason: "unsupported-host-or-protocol" };
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "invalid-path" };
  }

  const repository = repositoryRef(parts[0], parts[1]);
  return repository ? { ok: true, repository } : { ok: false, reason: "invalid-url" };
}
