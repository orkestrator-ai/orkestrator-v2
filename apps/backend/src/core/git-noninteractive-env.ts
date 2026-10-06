import path from "node:path";
import { runCommand } from "./shell.js";

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
): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["config", "--get", key], {
      cwd,
      env,
      timeoutMs: 10_000,
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
): Promise<NodeJS.ProcessEnv> {
  const result: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };
  // Empty environment values should fall through instead of shadowing Git config.
  delete result.GIT_SSH_COMMAND;
  if (!env.GIT_SSH?.trim()) delete result.GIT_SSH;
  const command =
    env.GIT_SSH_COMMAND?.trim() || (await configuredGitValue("core.sshCommand", cwd, env, run));
  const base = command || (env.GIT_SSH?.trim() ? `'${env.GIT_SSH.replace(/'/g, "'\\''")}'` : "ssh");
  const variant = (
    env.GIT_SSH_VARIANT ?? (await configuredGitValue("ssh.variant", cwd, env, run))
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
      env: await nonInteractiveGitEnv(options.cwd, options.env ?? process.env),
    },
  );
}
