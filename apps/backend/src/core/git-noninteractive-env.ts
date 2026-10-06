import path from "node:path";
import { runCommand } from "./shell.js";

/** Whether a configured SSH command runs OpenSSH itself rather than a wrapper. */
function invokesOpenSsh(command: string): boolean {
  const program = command.trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, "") ?? "";
  return /^ssh(\.exe)?$/i.test(path.basename(program));
}

async function configuredSshCommand(
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const { stdout } = await runCommand("git", ["config", "--get", "core.sshCommand"], {
      cwd,
      env,
      timeoutMs: 10_000,
    });
    return stdout.trim() || null;
  } catch {
    // Exit 1 means the key is unset.
    return null;
  }
}

/**
 * Environment for Git commands that may contact a remote from the backend.
 *
 * Nobody can answer a prompt here: with a passphrase-protected key and no SSH
 * agent, OpenSSH opens the controlling terminal and waits until the command
 * times out. The child is then killed and the UI gets only "Command failed".
 * `BatchMode=yes` makes ssh fail at once with its real error, such as
 * "Permission denied (publickey)". `GIT_TERMINAL_PROMPT=0` does the same for
 * HTTPS credential prompts. Agent and keychain-backed keys still work.
 *
 * The user's SSH command is kept. The batch option is appended to it, following
 * Git's precedence: `GIT_SSH_COMMAND`, then `core.sshCommand`, then `GIT_SSH`,
 * then `ssh`. Wrapper programs are left unchanged because they may not accept
 * OpenSSH options.
 */
export async function nonInteractiveGitEnv(
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const result: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };
  const base =
    env.GIT_SSH_COMMAND?.trim() ||
    (await configuredSshCommand(cwd, env)) ||
    (env.GIT_SSH ? null : "ssh");
  if (base && invokesOpenSsh(base)) {
    result.GIT_SSH_COMMAND = `${base} -o BatchMode=yes`;
  }
  return result;
}
