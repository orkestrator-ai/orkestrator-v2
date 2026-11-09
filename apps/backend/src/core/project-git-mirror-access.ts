/**
 * What a project's Git mirror may hold: no more than its readers' own
 * credential fetches (`docs/architecture/container-lifecycle.md#project-git-mirror`).
 *
 * A container clones with only the GitHub token Settings gives containers
 * (`containerGitHubCredential`, none by default), over HTTPS after
 * `convert_ssh_to_https` in `docker/workspace-setup.sh`, and with nothing for
 * any other host. Each kind of that access gets its own mirror, fetched the
 * same way: the converted URL, that token or none, and no host Git
 * configuration, credential helper, `.netrc` or SSH key. A container is bound
 * only to its own kind's mirror.
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitHubCliSelection } from "./github-cli-binary.js";
import {
  containerGitHubCredentialSource,
  getGitHubTokenLogin,
  resolveContainerGitHubToken,
} from "./github-credentials.js";
import { gitHubTokenCredentialOptions } from "./github-git-credentials.js";
import type { AppConfig } from "./models.js";
import { runCommand } from "./shell.js";

/** Every kind, so a refresh can retire the mirrors of all the others. */
export const GIT_MIRROR_ACCESS_KINDS = ["anonymous", "github-pat", "github-host-cli"] as const;
export type GitMirrorAccessKind = (typeof GIT_MIRROR_ACCESS_KINDS)[number];

export type GitMirrorAccess = {
  kind: GitMirrorAccessKind;
  /**
   * The GitHub token this kind's containers are given, for a GitHub kind only.
   * Held in memory for the one refresh; never written anywhere.
   */
  token?: string;
  /**
   * The agent-test fixture: a host path the container reaches through its own
   * bind (`ORKESTRATOR_AGENT_TEST_GIT_REMOTE`), so `file` is what it uses.
   */
  localRemote?: boolean;
};

/**
 * The URL a container's clone of `gitUrl` uses, as `convert_ssh_to_https` in
 * `docker/workspace-setup.sh` converts it, or null for anything a container's
 * clone cannot reach over HTTP(S).
 */
export function containerCloneUrl(gitUrl: string): string | null {
  const url = gitUrl.trim();
  let converted: string;
  if (/^https?:\/\//.test(url)) converted = url;
  else if (url.startsWith("git@")) {
    const afterAt = url.slice("git@".length);
    const separator = afterAt.indexOf(":");
    if (separator <= 0) return null;
    converted = `https://${afterAt.slice(0, separator)}/${afterAt.slice(separator + 1)}`;
  } else if (url.startsWith("ssh://")) {
    converted = `https://${url.slice("ssh://".length).replace(/^git@/, "")}`;
  } else return null;
  try {
    return new URL(converted).hostname ? converted : null;
  } catch {
    return null;
  }
}

/** Whether a container would send its GitHub token to this clone URL. */
function isGitHubHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

export type ResolveGitMirrorAccessInput = {
  gitUrl: string;
  global: AppConfig["global"];
  gitHubCli: GitHubCliSelection | undefined;
  /** The verified agent-test fixture remote, bound into the container. */
  localRemote?: boolean;
  /**
   * False where containers are never handed a GitHub credential (agent-test
   * profiles skip the sync), so the mirror is fetched with none either.
   */
  containersGetGitHubCredential?: boolean;
};

/**
 * The access a container created now is given for the project's remote, and so
 * the mirror it may read. Resolved at container creation and handed to the
 * refresh that creation starts.
 */
export async function resolveGitMirrorAccess(
  input: ResolveGitMirrorAccessInput,
): Promise<GitMirrorAccess> {
  if (input.localRemote) return { kind: "anonymous", localRemote: true };
  const url = containerCloneUrl(input.gitUrl);
  if (!url || !isGitHubHttpsUrl(url) || input.containersGetGitHubCredential === false) {
    return { kind: "anonymous" };
  }
  const source = containerGitHubCredentialSource(input.global);
  if (source === "none") return { kind: "anonymous" };
  const token = await resolveContainerGitHubToken(input.global, input.gitHubCli);
  if (!token) return { kind: "anonymous" };
  return { kind: source === "pat" ? "github-pat" : "github-host-cli", token };
}

/** The account the access's token acts as; undefined for no token or an unreadable one. */
export function readGitMirrorAccount(
  access: GitMirrorAccess,
  gitHubCli: GitHubCliSelection | undefined,
  run: typeof runCommand = runCommand,
): Promise<string | undefined> {
  if (!access.token) return Promise.resolve(undefined);
  return getGitHubTokenLogin(access.token, gitHubCli, run);
}

/** How a mirror of `gitUrl` is fetched for `access`, or null when it cannot be. */
export type GitMirrorFetchPlan = {
  url: string;
  env: NodeJS.ProcessEnv;
  gitOptions: string[];
};

/**
 * Variables that would hand the fetch something a container does not have:
 * Git's own (configuration, askpass, SSH commands, trace output naming the URL)
 * and the backend's GitHub tokens.
 */
function isolatedBaseEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (name.startsWith("GIT_")) continue;
    if (["GH_TOKEN", "GITHUB_TOKEN", "ORKESTRATOR_GITHUB_TOKEN", "SSH_ASKPASS"].includes(name)) {
      continue;
    }
    env[name] = value;
  }
  return env;
}

/**
 * The fetch a container's own clone would make: its URL, its protocol only, its
 * token or none. `home` must be an empty directory: libcurl reads `~/.netrc`.
 * Proxy variables still apply; host Git settings such as `http.proxy` do not.
 */
export function gitMirrorFetchPlan(
  gitUrl: string,
  access: GitMirrorAccess,
  home: string,
  base: NodeJS.ProcessEnv = process.env,
): GitMirrorFetchPlan | null {
  let url: string | null;
  let protocol: string;
  if (access.localRemote) {
    url = gitUrl;
    protocol = "file";
  } else {
    url = containerCloneUrl(gitUrl);
    if (!url) return null;
    protocol = new URL(url).protocol.slice(0, -1);
  }
  const token = access.kind !== "anonymous" && url && isGitHubHttpsUrl(url) ? access.token : "";
  const env: NodeJS.ProcessEnv = {
    ...isolatedBaseEnv(base),
    HOME: home,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: protocol,
    ...(token ? { ORKESTRATOR_GITHUB_TOKEN: token } : {}),
  };
  return {
    url,
    env,
    gitOptions: token ? gitHubTokenCredentialOptions() : ["-c", "credential.helper="],
  };
}

/** An empty home for one fetch, inside `directory` under a scratch name the refresh removes. */
export function makeFetchHome(directory: string): Promise<string> {
  return mkdtemp(path.join(directory, ".building-home-"));
}
