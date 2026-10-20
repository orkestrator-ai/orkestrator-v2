import { gitHubCli } from "./github-cli-binary.js";
import { runCommand } from "./shell.js";
import type { AppConfig } from "./models.js";

export type GitHubCredentialSource = "host-cli" | "pat";

export async function getHostGitHubToken(): Promise<string | undefined> {
  try {
    const { stdout } = await runCommand(
      gitHubCli(),
      ["auth", "token", "--hostname", "github.com"],
      {
        timeoutMs: 10_000,
      },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function gitHubCredentialSource(globalConfig: AppConfig["global"]): GitHubCredentialSource {
  return globalConfig.useHostGitHubCredentials !== false ? "host-cli" : "pat";
}

/**
 * The GitHub token the user selected in Settings: the host's `gh auth login`
 * account by default, or the stored PAT when host credentials are turned off.
 * Shared by container credential sync and the backend's own GitHub API calls.
 */
export async function resolveGitHubToken(
  globalConfig: AppConfig["global"],
): Promise<string | undefined> {
  if (gitHubCredentialSource(globalConfig) === "host-cli") {
    return getHostGitHubToken();
  }
  return globalConfig.githubToken?.trim() || undefined;
}

export async function getContainerGitHubCredentialStatus(
  globalConfig: AppConfig["global"],
): Promise<{ source: GitHubCredentialSource; available: boolean }> {
  if (gitHubCredentialSource(globalConfig) === "host-cli") {
    return {
      source: "host-cli",
      available: Boolean(await getHostGitHubToken()),
    };
  }
  return {
    source: "pat",
    available: Boolean(globalConfig.githubToken?.trim()),
  };
}

let loadGlobalConfig: (() => Promise<AppConfig["global"]>) | undefined;

/** Set once at startup so host `gh` runs can follow the selected credential. */
export function setGitHubCliConfigSource(
  load: (() => Promise<AppConfig["global"]>) | undefined,
): void {
  loadGlobalConfig = load;
}

/**
 * Environment for a `gh` run on the backend host. With host credentials
 * selected, gh uses its own login and `base` is returned unchanged (undefined
 * inherits the backend's environment). With a PAT selected, `GH_TOKEN` makes gh
 * act as that token, matching containers and the GitHub tab.
 */
export async function gitHubCliEnv(
  base?: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv | undefined> {
  const global = await loadGlobalConfig?.();
  if (!global || gitHubCredentialSource(global) !== "pat") return base;
  const token = global.githubToken?.trim();
  if (!token) return base;
  return { ...(base ?? process.env), GH_TOKEN: token };
}
