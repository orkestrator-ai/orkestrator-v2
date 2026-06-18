import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

/**
 * Directories where CLI tools (docker, git, gh, bun, node, …) commonly live but
 * which are NOT present in the minimal PATH that macOS/Linux give to GUI apps
 * launched from Finder/Dock/Applications.
 */
function commonBinDirs(): string[] {
  const home = os.homedir();
  return [
    "/opt/homebrew/bin", // Homebrew (Apple Silicon)
    "/opt/homebrew/sbin",
    "/usr/local/bin", // Homebrew (Intel) + Docker Desktop CLI symlink
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    path.join(home, ".docker/bin"), // Docker Desktop (newer versions)
    path.join(home, ".local/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".cargo/bin"),
  ];
}

/**
 * Ask the user's login shell for its PATH. GUI apps don't run the user's shell
 * profile, so this recovers entries added by .zshrc/.bashrc (nvm, asdf, custom
 * Docker installs, etc.). Best-effort: returns null on any failure.
 */
function loginShellPath(): string | null {
  const shell = process.env.SHELL;
  if (!shell) return null;
  try {
    const output = execFileSync(shell, ["-ilc", "command -v node >/dev/null 2>&1; printf %s \"$PATH\""], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = output.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Repair process.env.PATH so that child processes spawned by the backend can
 * find CLI tools when the app is launched as a packaged GUI app (where the
 * inherited PATH is just /usr/bin:/bin:/usr/sbin:/sbin).
 *
 * No-op on Windows, where GUI apps inherit the full system PATH.
 */
export function fixPath(): void {
  if (process.platform === "win32") return;

  const separator = path.delimiter;
  const existing = (process.env.PATH ?? "").split(separator).filter(Boolean);
  const fromShell = (loginShellPath() ?? "").split(separator).filter(Boolean);

  const merged: string[] = [];
  const seen = new Set<string>();
  for (const dir of [...fromShell, ...existing, ...commonBinDirs()]) {
    if (!seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }

  process.env.PATH = merged.join(separator);
}
