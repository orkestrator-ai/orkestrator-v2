import path from "node:path";
import type { SshBinaryLookup } from "./context.js";

const SYSTEM_SSH_DIRECTORIES = ["/usr/bin"];

/**
 * Locate the system OpenSSH client. Prefers `/usr/bin` (the platform build on
 * macOS and most Linux distributions), then the PATH. Windows has no qualified
 * adapter yet, so finding `ssh.exe` there is deliberately not treated as
 * support.
 */
export async function locateOpenSshBinaries(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isExecutable: (file: string) => Promise<boolean>,
): Promise<SshBinaryLookup> {
  if (platform === "win32") return { ok: false, reason: "unsupported-platform" };
  const directories = [...SYSTEM_SSH_DIRECTORIES, ...searchPath(env.PATH)];
  const ssh = await firstExecutable(directories, "ssh", isExecutable);
  if (!ssh) return { ok: false, reason: "not-found" };
  const sshKeygen =
    (await firstExecutable([path.dirname(ssh)], "ssh-keygen", isExecutable)) ??
    (await firstExecutable(directories, "ssh-keygen", isExecutable));
  return { ok: true, binaries: { ssh, sshKeygen } };
}

function searchPath(value: string | undefined): string[] {
  if (!value) return [];
  // Only absolute entries: a relative PATH entry would resolve against the
  // current directory, which may be repository content.
  return value.split(path.delimiter).filter((entry) => path.isAbsolute(entry));
}

async function firstExecutable(
  directories: readonly string[],
  name: string,
  isExecutable: (file: string) => Promise<boolean>,
): Promise<string | null> {
  const seen = new Set<string>();
  for (const directory of directories) {
    const candidate = path.join(directory, name);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}
