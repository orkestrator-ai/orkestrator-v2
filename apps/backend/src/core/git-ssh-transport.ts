import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { classifyCommandFailure } from "@orkestrator/protocol/node/command-failure-reason";
import { runRemoteGit } from "./git-noninteractive-env.js";
import { runCommand } from "./shell.js";
import type { EnvironmentLifecycleRemedy } from "@orkestrator/protocol/contract/domains/environments";

/**
 * A project whose `origin` is a GitHub SSH remote cannot fetch on a network
 * that blocks outbound port 22, while HTTPS to the same host often works.
 * These helpers recognize that failure, check whether HTTPS would work
 * instead, and switch the checkout's `origin` when the user asks.
 *
 * Only the host checkout's `origin` changes. The project's stored `gitUrl`
 * (its identity, and what a container clones) is left alone: containers
 * already convert an SSH remote to HTTPS before cloning
 * (`convert_ssh_to_https` in `docker/workspace-setup.sh`).
 */

const log = createLogger("environment");

export interface SshConnectFailure {
  readonly host: string;
  readonly port: number;
}

// OpenSSH's own wording, as Git relays it: `ssh: connect to host <host> port
// <port>: <strerror>`. macOS says "Operation timed out", Linux "Connection
// timed out". Only connect-level failures: an authentication refusal is a
// different problem with a different fix.
const SSH_CONNECT_FAILURE =
  /ssh: connect to host ([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?) port (\d{1,5}): (?:operation timed out|connection timed out|connection refused|network is unreachable|no route to host)/i;

/**
 * The host and port OpenSSH could not connect to, or null. The host is
 * restricted to hostname characters, so the result is safe to show.
 */
export function sshConnectFailure(text: string): SshConnectFailure | null {
  const match = SSH_CONNECT_FAILURE.exec(text.slice(-16 * 1024));
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host: match[1]!.toLowerCase(), port };
}

export interface GitHubRepository {
  readonly owner: string;
  readonly repo: string;
}

const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

function gitHubRepository(owner: string, repoWithSuffix: string): GitHubRepository | null {
  const repo = repoWithSuffix.replace(/\.git$/i, "");
  if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) return null;
  if ([owner, repo].some((part) => part === "." || part === "..")) return null;
  return { owner, repo };
}

/**
 * The repository a GitHub SSH remote names (`git@github.com:owner/repo.git` or
 * `ssh://git@github.com[:22]/owner/repo.git`), or null for anything else,
 * HTTPS remotes and other hosts included.
 */
export function gitHubSshRemote(url: string): GitHubRepository | null {
  const value = url.trim();
  const scp = /^git@github\.com:\/?([^/\s]+)\/([^/\s]+?)\/?$/i.exec(value);
  if (scp) return gitHubRepository(scp[1]!, scp[2]!);
  const ssh = /^ssh:\/\/(?:git@)?github\.com(?::22)?\/([^/\s]+)\/([^/\s]+?)\/?$/i.exec(value);
  if (ssh) return gitHubRepository(ssh[1]!, ssh[2]!);
  return null;
}

/** The HTTPS remote for a GitHub repository. Carries no credential. */
export function gitHubHttpsUrl({ owner, repo }: GitHubRepository): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * The checkout's raw `remote.origin.url`, or null. Read from config rather
 * than `remote get-url`, which applies `insteadOf` rewrites.
 */
async function readRawOriginUrl(
  projectPath: string,
  run: typeof runCommand,
): Promise<string | null> {
  try {
    const { stdout } = await run(
      "git",
      ["-C", projectPath, "config", "--get", "remote.origin.url"],
      { timeoutMs: 10_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Whether Git has a credential helper for github.com over HTTPS. Never reads a credential. */
async function hasGitHubCredentialHelper(
  projectPath: string,
  run: typeof runCommand,
): Promise<boolean> {
  try {
    const { stdout } = await run(
      "git",
      ["-C", projectPath, "config", "--get-urlmatch", "credential.helper", "https://github.com"],
      { timeoutMs: 10_000 },
    );
    // An empty last value resets the helper list: nothing would answer.
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Long enough for a slow TLS handshake, short enough to add little to a failed start. */
export const HTTPS_PROBE_TIMEOUT_MS = 20_000;

export type HttpsAccessProbe =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "no-credential-helper" | "unreachable" };

/**
 * Whether this checkout could talk to `httpsUrl` without a prompt: a credential
 * helper is configured for github.com, and `git ls-remote` over HTTPS answers.
 * The listing proves reachability and, for a private repository, that the
 * helper's credential is accepted. Its output is discarded.
 */
export async function probeGitHubHttpsAccess(
  projectPath: string,
  httpsUrl: string,
  run: typeof runCommand = runCommand,
): Promise<HttpsAccessProbe> {
  if (!(await hasGitHubCredentialHelper(projectPath, run))) {
    return { ok: false, reason: "no-credential-helper" };
  }
  try {
    await runRemoteGit(
      "ls-remote",
      ["--quiet", httpsUrl, "HEAD"],
      { cwd: projectPath, timeoutMs: HTTPS_PROBE_TIMEOUT_MS, maxOutputBytes: 64 * 1024 },
      run,
    );
    return { ok: true };
  } catch (error) {
    log.info("git-https-probe.failed", {
      ...classifyCommandFailure(error, { tools: ["git"] }),
      error: formatLogError(error),
    });
    return { ok: false, reason: "unreachable" };
  }
}

/**
 * The remedy to offer after a start failed to reach the project's remote over
 * SSH: `use-https` when `origin` is a GitHub SSH remote and HTTPS works from
 * this checkout, otherwise null. Never throws.
 */
export async function detectHttpsRemedy(
  projectPath: string,
  run: typeof runCommand = runCommand,
): Promise<EnvironmentLifecycleRemedy | null> {
  try {
    const origin = await readRawOriginUrl(projectPath, run);
    const repository = origin ? gitHubSshRemote(origin) : null;
    if (!repository) return null;
    const probe = await probeGitHubHttpsAccess(projectPath, gitHubHttpsUrl(repository), run);
    return probe.ok ? "use-https" : null;
  } catch (error) {
    log.warn("git-https-remedy.failed", { error: formatLogError(error) });
    return null;
  }
}

/** Fixed, user-facing refusals of `switchOriginToHttps`. */
export const USE_HTTPS_REMOTE_ERRORS = {
  notGitHubSsh:
    "This project's origin remote is not a GitHub SSH remote, so there is nothing to switch.",
  noCredentialHelper:
    "Git has no HTTPS credentials for github.com. Sign in with `gh auth login`, run `gh auth setup-git`, then retry.",
  unreachable:
    "Couldn't reach GitHub over HTTPS with your credentials either. Check your network connection and `gh auth status`, then retry.",
} as const;

/**
 * Points the checkout's `origin` at the HTTPS form of its GitHub SSH remote,
 * after checking HTTPS works from here, so a switch never leaves a project
 * worse off. Already-HTTPS GitHub remotes answer as done. Worktrees share the
 * repository's config, so every local environment of the project follows.
 */
export async function switchOriginToHttps(
  projectPath: string,
  run: typeof runCommand = runCommand,
): Promise<{ remoteUrl: string; changed: boolean }> {
  const origin = await readRawOriginUrl(projectPath, run);
  if (origin && /^https:\/\/github\.com\//i.test(origin)) {
    return { remoteUrl: origin.replace(/^(https:\/\/)[^/?#]*@/, "$1"), changed: false };
  }
  const repository = origin ? gitHubSshRemote(origin) : null;
  if (!repository) throw new Error(USE_HTTPS_REMOTE_ERRORS.notGitHubSsh);
  const remoteUrl = gitHubHttpsUrl(repository);
  const probe = await probeGitHubHttpsAccess(projectPath, remoteUrl, run);
  if (!probe.ok) {
    throw new Error(
      probe.reason === "no-credential-helper"
        ? USE_HTTPS_REMOTE_ERRORS.noCredentialHelper
        : USE_HTTPS_REMOTE_ERRORS.unreachable,
    );
  }
  await run("git", ["-C", projectPath, "remote", "set-url", "origin", remoteUrl], {
    timeoutMs: 10_000,
  });
  log.info("git-origin.switched-to-https", {});
  return { remoteUrl, changed: true };
}
