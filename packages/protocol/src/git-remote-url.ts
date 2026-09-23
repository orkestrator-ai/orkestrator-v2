/**
 * Whether a project Git URL has a shape Orkestrator can hand to `git clone`:
 * HTTP(S), `ssh://`, or scp-style `git@host:owner/repo`.
 *
 * Deliberately permissive — the remote, not this check, is the authority on
 * whether the repository exists. It only stops obvious typos and local paths
 * from being stored as a project's remote.
 */
export function isGitRemoteUrl(value: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/).+/.test(value.trim());
}

/** Remove URL userinfo before a remote is persisted or exposed to clients. */
export function withoutUrlCredentials(gitUrl: string): string {
  return gitUrl.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#]*@/, "$1");
}
