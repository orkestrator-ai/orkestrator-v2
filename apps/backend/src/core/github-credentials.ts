import { gitHubCli, type GitHubCliSelection } from "./github-cli-binary.js";
import { runCommand } from "./shell.js";
import type { AppConfig } from "./models.js";

export type GitHubCredentialSource = "host-cli" | "pat";
export type ContainerGitHubCredentialSource = GitHubCredentialSource | "none";

/** The host's `gh auth login` token, read with the backend's `gh`. */
export async function getHostGitHubToken(
  gitHubCliSelection: GitHubCliSelection | undefined,
): Promise<string | undefined> {
  try {
    const { stdout } = await runCommand(
      gitHubCli(gitHubCliSelection),
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
 * The token for the backend's own GitHub calls: the host's `gh auth login`
 * account by default, or the stored PAT when host credentials are turned off.
 * Containers have their own setting; see {@link resolveContainerGitHubToken}.
 */
export async function resolveGitHubToken(
  globalConfig: AppConfig["global"],
  gitHubCliSelection: GitHubCliSelection | undefined,
): Promise<string | undefined> {
  if (gitHubCredentialSource(globalConfig) === "host-cli") {
    return getHostGitHubToken(gitHubCliSelection);
  }
  return globalConfig.githubToken?.trim() || undefined;
}

export function containerGitHubCredentialSource(
  globalConfig: AppConfig["global"],
): ContainerGitHubCredentialSource {
  return globalConfig.containerGitHubCredential ?? "none";
}

/**
 * The token containers receive. An agent in any container can read it and reach
 * whatever it reaches, so the host token is read only when the user chose to
 * share it: with sharing off it never enters this process for a container.
 */
export async function resolveContainerGitHubToken(
  globalConfig: AppConfig["global"],
  gitHubCliSelection: GitHubCliSelection | undefined,
): Promise<string | undefined> {
  const source = containerGitHubCredentialSource(globalConfig);
  if (source === "host-cli") return getHostGitHubToken(gitHubCliSelection);
  if (source === "pat") return globalConfig.githubToken?.trim() || undefined;
  return undefined;
}

/** A GitHub login, or an app's `name[bot]`; anything else is not trusted as one. */
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

/**
 * The account a token acts as, lower-cased (GitHub logins ignore case), read
 * with `gh api user`. Undefined when it cannot be read: no `gh`, no network, a
 * token `/user` refuses, or an answer that is not a login. The token goes by
 * environment only and is never logged; neither is the error.
 */
export async function getGitHubTokenLogin(
  token: string,
  gitHubCliSelection: GitHubCliSelection | undefined,
  run: typeof runCommand = runCommand,
): Promise<string | undefined> {
  try {
    const { stdout } = await run(
      gitHubCli(gitHubCliSelection),
      ["api", "--hostname", "github.com", "user", "--jq", ".login"],
      { timeoutMs: 10_000, env: { ...hostGitHubCliEnv(), GH_TOKEN: token } },
    );
    const login = stdout.trim();
    return GITHUB_LOGIN_PATTERN.test(login) ? login.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export async function getContainerGitHubCredentialStatus(
  globalConfig: AppConfig["global"],
  gitHubCliSelection: GitHubCliSelection | undefined,
): Promise<{ source: ContainerGitHubCredentialSource; available: boolean }> {
  return {
    source: containerGitHubCredentialSource(globalConfig),
    available: Boolean(await resolveContainerGitHubToken(globalConfig, gitHubCliSelection)),
  };
}

/**
 * Where a host `gh` run reads the credential selected in Settings: the storage
 * of the backend it runs for. Absent, it uses the host's `gh auth login`.
 */
export type GitHubCliConfigSource = { loadConfig(): Promise<Pick<AppConfig, "global">> };

/** Ignore inherited tokens so host mode means the stored `gh auth login`. */
function hostGitHubCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

/** Environment for a host `gh` run using exactly the credential selected in Settings. */
export async function gitHubCliEnv(
  source: GitHubCliConfigSource | undefined,
  base?: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const global = (await source?.loadConfig())?.global;
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
