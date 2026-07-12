// Git URL validation and parsing utilities

/**
 * Validates if a string is a valid Git URL
 * Supports SSH (git@github.com:user/repo.git) and HTTPS formats
 */
export function isValidGitUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;

  // SSH format: git@github.com:user/repo.git
  if (trimmed.startsWith("git@")) {
    return trimmed.includes(":") && (trimmed.includes("/") || trimmed.endsWith(".git"));
  }

  // HTTPS format: https://github.com/user/repo.git
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    return (
      trimmed.includes("github.com") ||
      trimmed.includes("gitlab.com") ||
      trimmed.includes("bitbucket.org") ||
      trimmed.endsWith(".git")
    );
  }

  return false;
}

/**
 * Extracts the repository name from a Git URL
 */
export function extractRepoName(gitUrl: string): string {
  const url = gitUrl.trim();

  // Remove .git suffix if present
  const cleaned = url.endsWith(".git") ? url.slice(0, -4) : url;

  // Try to extract the last path component
  const lastSlash = cleaned.lastIndexOf("/");
  if (lastSlash !== -1) {
    const name = cleaned.slice(lastSlash + 1);
    if (name) return name;
  }

  // For SSH URLs like git@github.com:user/repo
  const colonIndex = cleaned.lastIndexOf(":");
  if (colonIndex !== -1) {
    const afterColon = cleaned.slice(colonIndex + 1);
    const slashIndex = afterColon.lastIndexOf("/");
    if (slashIndex !== -1) {
      const name = afterColon.slice(slashIndex + 1);
      if (name) return name;
    }
    return afterColon;
  }

  // Fallback to the whole URL
  return url;
}

/**
 * Normalizes a Git URL for comparison (removes trailing .git, lowercase host)
 */
export function normalizeGitUrl(url: string): string {
  let normalized = url.trim().toLowerCase();
  if (normalized.endsWith(".git")) {
    normalized = normalized.slice(0, -4);
  }
  return normalized;
}
