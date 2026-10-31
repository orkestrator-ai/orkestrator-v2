import { parseGitHubRepositoryRemote } from "@orkestrator/protocol/github-repository";
import { gitHubCliEnv, type GitHubCliConfigSource } from "./github-credentials.js";

// Git appends get/store/erase as $1. Never store the token, and check the
// credential request too: URL-scoped configuration alone is not a secret boundary.
const PAT_HELPER = `!f() {
  test "$1" = get || return 0
  protocol= host=
  while IFS= read -r line && test -n "$line"; do
    case "$line" in protocol=*) protocol=\${line#protocol=} ;; host=*) host=\${line#host=} ;; esac
  done
  if test "$protocol" = https && test "$host" = github.com; then
    printf '%s\n' 'username=x-access-token' "password=$ORKESTRATOR_GITHUB_TOKEN"
  fi
}; f`;

/** Per-transfer PAT authentication; no secrets in argv, URLs or persisted Git config. */
export async function gitHubGitCredentials(
  source: GitHubCliConfigSource | undefined,
  remote: string,
  base?: NodeJS.ProcessEnv,
): Promise<{ env?: NodeJS.ProcessEnv; gitOptions: string[] }> {
  const parsed = parseGitHubRepositoryRemote(remote);
  if (!parsed.ok) return { gitOptions: [] };
  const env = await gitHubCliEnv(source, base);
  if (!env.GH_TOKEN) return { gitOptions: [] };
  const https = `https://github.com/${parsed.repository.owner}/${parsed.repository.name}.git`;
  return {
    env: { ...env, ORKESTRATOR_GITHUB_TOKEN: env.GH_TOKEN },
    gitOptions: [
      "-c",
      "credential.helper=",
      "-c",
      `credential.https://github.com.helper=${PAT_HELPER}`,
      // An exact rewrite overrides broader host SSH preferences for this transfer.
      "-c",
      `url.${https}.insteadOf=${remote}`,
      "-c",
      `url.${https}.pushInsteadOf=${remote}`,
    ],
  };
}
