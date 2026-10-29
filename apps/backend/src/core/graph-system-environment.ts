/**
 * How graph system nodes run `git` and `gh` in a run's environment (item
 * 207), with the credentials an agent there would use: on the host the
 * project's own Git configuration (non-interactive, `runRemoteGit`) and the
 * `gh` credential selected in Settings (`gitHubCliEnv`); in a container the
 * container's runtime credential (`withContainerRuntimeCredential`), as the
 * PR monitor and Ship's agent do. Every call holds the environment mutation
 * fence, like `createEnvironmentCommandRunner`.
 *
 * Errors are reduced to one bounded, credential-free line
 * ({@link graphCommandErrorLine}); payloads passed as arguments (a pull
 * request body) are redacted from them.
 */
import { quoteShell } from "./commands-agent-support.js";
import { createEnvironmentCommandRunner, readEnvironmentWorkspaceFile } from "./commands-review.js";
import { dockerExec } from "./commands-container-exec.js";
import { withContainerRuntimeCredential } from "./container-scripts.js";
import type { EnvironmentMutationFence } from "./environment-replacement-fence.js";
import { gitHubCli } from "./github-cli-binary.js";
import { gitHubCliEnv } from "./github-credentials.js";
import { sanitizeGitHubError } from "./github.js";
import { runRemoteGit } from "./git-noninteractive-env.js";
import type { Environment } from "./models.js";
import { runCommand } from "./shell.js";

export interface GraphShellOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Argument values to keep out of errors (a pull request body). */
  redact?: readonly string[];
}

/** `git` and `gh` in an environment's worktree. */
export interface GraphEnvironmentShell {
  /** Local Git in the worktree: no network, no credentials. */
  git(environment: Environment, args: string[], options?: GraphShellOptions): Promise<string>;
  /** Git that talks to the remote, with the environment's credentials. */
  remoteGit(
    environment: Environment,
    command: "push" | "ls-remote" | "fetch",
    args: string[],
    options?: GraphShellOptions,
  ): Promise<string>;
  /** The GitHub CLI with the environment's credentials, run in the worktree. */
  gh(environment: Environment, args: string[], options?: GraphShellOptions): Promise<string>;
  /** A confined file of the worktree (a sealed review package), without following links. */
  readFile(environment: Environment, relativePath: string): Promise<Buffer>;
}

const MAX_ERROR_LINE = 300;

/**
 * One line of a failed command's message: no credentials (`https://user:x@`,
 * GitHub tokens), no redacted payloads, at most 300 characters.
 */
export function graphCommandErrorLine(error: unknown, redact: readonly string[] = []): string {
  let text = sanitizeGitHubError(error);
  for (const value of redact) {
    if (value.length >= 8) text = text.split(value).join("[redacted]");
  }
  text = text.replace(/(https?:\/\/)[^\s/@]+@/gi, "$1");
  const line =
    text
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .find((entry) => !/^command failed/i.test(entry)) ?? text.trim();
  return line.length <= MAX_ERROR_LINE ? line : `${line.slice(0, MAX_ERROR_LINE - 1)}…`;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The production shell over the host and Docker. */
export function createGraphEnvironmentShell(
  fence: Pick<EnvironmentMutationFence, "beginMutation">,
): GraphEnvironmentShell {
  const held = async <T>(environment: Environment, run: () => Promise<T>): Promise<T> => {
    const release = fence.beginMutation(environment.id);
    try {
      return await run();
    } finally {
      release();
    }
  };
  const worktree = (environment: Environment): string => {
    if (!environment.worktreePath) throw new Error("The environment's worktree is not available");
    return environment.worktreePath;
  };
  const container = (environment: Environment): string => {
    if (!environment.containerId) throw new Error("The environment's container is not running");
    return environment.containerId;
  };
  const inContainer = (
    environment: Environment,
    command: string[],
    options: GraphShellOptions,
  ): Promise<string> =>
    dockerExec(
      container(environment),
      withContainerRuntimeCredential(`cd /workspace && ${command.map(quoteShell).join(" ")}`),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.redact,
      options.signal,
    );

  return {
    git: (environment, args, options = {}) =>
      held(environment, async () =>
        environment.environmentType === "local"
          ? (
              await runCommand("git", args, {
                cwd: worktree(environment),
                timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                signal: options.signal,
              })
            ).stdout
          : inContainer(environment, ["git", ...args], options),
      ),
    remoteGit: (environment, command, args, options = {}) =>
      held(environment, async () =>
        environment.environmentType === "local"
          ? (
              await runRemoteGit(command, args, {
                cwd: worktree(environment),
                timeoutMs: options.timeoutMs ?? 120_000,
                signal: options.signal,
              })
            ).stdout
          : inContainer(environment, ["git", command, ...args], {
              ...options,
              timeoutMs: options.timeoutMs ?? 120_000,
            }),
      ),
    gh: (environment, args, options = {}) =>
      held(environment, async () =>
        environment.environmentType === "local"
          ? (
              await runCommand(gitHubCli(), args, {
                cwd: worktree(environment),
                timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                env: await gitHubCliEnv(),
                signal: options.signal,
                redactValues: options.redact,
              })
            ).stdout
          : inContainer(environment, ["gh", ...args], options),
      ),
    readFile: (environment, relativePath) =>
      readEnvironmentWorkspaceFile(
        environment,
        createEnvironmentCommandRunner(environment, fence),
        relativePath,
      ),
  };
}
