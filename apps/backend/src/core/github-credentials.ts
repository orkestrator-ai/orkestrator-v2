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
        env: hostGitHubCliEnv(),
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

/** Ignore inherited tokens so host mode means the stored `gh auth login`. */
function hostGitHubCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

/** Environment for a host `gh` run using exactly the credential selected in Settings. */
export async function gitHubCliEnv(base?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const global = await loadGlobalConfig?.();
  const env = hostGitHubCliEnv(base);
  if (!global || gitHubCredentialSource(global) !== "pat") return env;
  const token = global.githubToken?.trim();
  if (!token) {
    throw new Error(
      "GitHub personal access token is missing. Add a token under GitHub authentication in Settings, or enable host GitHub CLI credentials, then retry",
    );
  }
  return { ...env, GH_TOKEN: token };
}
