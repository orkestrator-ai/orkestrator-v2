import path from "node:path";
import { CommandFailedError, runCommand } from "../shell.js";

/** The remote answered and confirmed the requested branch does not exist. */
export function isMissingRemoteRefFailure(error: unknown): boolean {
  if (!(error instanceof CommandFailedError) || error.timedOut) return false;
  return /couldn't find remote ref|could not find remote ref/i.test(
    `${error.stderr}\n${error.message}`,
  );
}

/**
 * The fetch reached the remote but could not move a local ref, because another
 * Git process in the same repository was updating it at that moment (git
 * prints `cannot lock ref '<ref>': is at X but expected Y`, or
 * `... Unable to create '<ref>.lock': File exists`). Worktrees of one clone
 * share their refs, so a background fetch can race the project's own refresh,
 * another worktree's fetch or a Git command the user runs by hand.
 */
export function isRefLockContentionFailure(error: unknown): boolean {
  if (!(error instanceof CommandFailedError) || error.timedOut) return false;
  return /^error: cannot lock ref '[^\r\n]+': (?:is at [a-f0-9]+ but expected [a-f0-9]+|Unable to create '[^\r\n]+\.lock': File exists\.?)\r?$/m.test(
    error.stderr,
  );
}

/** Keep the executable's original shell spelling, including quoted paths. */
function openSshExecutable(command: string, variant: string | undefined): string | null {
  // Recognize literal executables without rewriting expansions or compound commands.
  const executable = command.match(
    /^\s*((?:[^\s'"\\$`;&|<>()]+|'[^']*'|"[^"\\$`]*"|\\[^\n])+)(?=\s|$)/,
  );
  if (!executable) return null;
  const literal = executable[1]!.replace(/'([^']*)'|"([^"]*)"|\\(.)/g, "$1$2$3");
  if (literal.includes("=") || /[;&|<>()`]/.test(command.slice(executable[0].length))) {
    return null;
  }
  const basename = path.win32
    .basename(path.basename(literal))
    .toLowerCase()
    .replace(/\.exe$/, "");
  const isOpenSsh =
    variant === undefined || variant === "auto"
      ? basename === "ssh"
      : !["simple", "plink", "putty", "tortoiseplink"].includes(variant);
  return isOpenSsh ? executable[0] : null;
}

async function configuredGitValue(
  key: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  run: typeof runCommand,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["config", "--get", key], {
      cwd,
      env,
      timeoutMs: 10_000,
      signal,
    });
    return stdout.trim() || undefined;
  } catch {
    // Unset, unreadable or timed-out config must not leave default ssh interactive.
    return undefined;
  }
}

/**
 * Environment for host Git commands issued through runRemoteGit below.
 *
 * Nobody can answer a prompt here. BatchMode makes OpenSSH fail promptly with
 * its authentication error; GIT_TERMINAL_PROMPT disables HTTPS prompts.
 * Agent and keychain-backed keys still work.
 *
 * Follow Git's precedence: GIT_SSH_COMMAND, core.sshCommand, GIT_SSH, ssh.
 * Insert BatchMode immediately after the executable: OpenSSH uses the first
 * value, so appending cannot override a supplied BatchMode=no. GIT_SSH is an
 * executable path, not shell text, and must be quoted before promotion.
 * Unknown wrappers are preserved: their non-interactive flags are user-owned.
 * Container scripts use the container's own credential/configuration boundary
 * and are deliberately excluded from this host environment resolver.
 */
export async function nonInteractiveGitEnv(
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
  run: typeof runCommand = runCommand,
  signal?: AbortSignal,
): Promise<NodeJS.ProcessEnv> {
  const result: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };
  // Empty environment values should fall through instead of shadowing Git config.
  delete result.GIT_SSH_COMMAND;
  if (!env.GIT_SSH?.trim()) delete result.GIT_SSH;
  const command =
    env.GIT_SSH_COMMAND?.trim() ||
    (await configuredGitValue("core.sshCommand", cwd, env, run, signal));
  const base = command || (env.GIT_SSH?.trim() ? `'${env.GIT_SSH.replace(/'/g, "'\\''")}'` : "ssh");
  const variant = (
    env.GIT_SSH_VARIANT ?? (await configuredGitValue("ssh.variant", cwd, env, run, signal))
  )?.toLowerCase();
  const executable = openSshExecutable(base, variant);
  if (executable) {
    result.GIT_SSH_COMMAND = `${executable} -o BatchMode=yes${base.slice(executable.length)}`;
  } else if (command) {
    result.GIT_SSH_COMMAND = command;
  }
  return result;
}

type RemoteGitCommand = "fetch" | "pull" | "push" | "clone" | "ls-remote";
type RemoteGitOptions = NonNullable<Parameters<typeof runCommand>[2]> & {
  gitOptions?: string[];
};

/**
 * Shared boundary for backend host remote operations. These operations manage
 * project refs/checkouts, not submodule checkouts. Disable recursive fetch/pull
 * so the exported project SSH command never replaces a submodule's own command.
 * Local-only Git and in-container scripts do not use this boundary.
 */
export async function runRemoteGit(
  command: RemoteGitCommand,
  args: string[],
  { gitOptions = [], ...options }: RemoteGitOptions = {},
  run: typeof runCommand = runCommand,
) {
  return run(
    "git",
    [
      ...gitOptions,
      command,
      ...(command === "fetch" || command === "pull" ? ["--no-recurse-submodules"] : []),
      ...args,
    ],
    {
      ...options,
      env: await nonInteractiveGitEnv(
        options.cwd,
        options.env ?? process.env,
        runCommand,
        options.signal,
      ),
    },
  );
}
