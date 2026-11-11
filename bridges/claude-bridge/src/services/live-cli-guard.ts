// Live Claude probes must not run the operator's managed toolchain.
//
// An agent shell started by the production app inherits its `CLAUDE_CLI_PATH`,
// which points into the real data directory's `toolchains/`. A live probe that
// honoured it would execute that binary, and agents may not touch the real
// data directory (AGENTS.md, "Production Orkestrator shares this host"). Two
// `verify:claude:mcp-live` runs did exactly that before this guard existed
// (to-do 0039 task 1). The probes call `refuseRealDataDirClaudeCli()` before
// starting anything, so such a run now fails at once with a fix instead.
//
// Point `CLAUDE_CLI_PATH` at a throwaway install
// (`mise run toolchain:install --data-dir <throwaway dir> --tool claude`) or
// unset it to use the SDK's bundled CLI. An operator deliberately using their
// own install sets ORKESTRATOR_LIVE_ALLOW_REAL_DATA_DIR_CLI=1.
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const ALLOW_REAL_DATA_DIR_CLI_ENV = "ORKESTRATOR_LIVE_ALLOW_REAL_DATA_DIR_CLI";

const APP_SLUG = "orkestrator-v2";

/** The platform default data directory, as `apps/backend/src/data-dir.ts` resolves it. */
export function defaultOrkestratorDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", APP_SLUG);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), APP_SLUG);
}

function canonical(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The reason a live probe must not start, or `null` when `CLAUDE_CLI_PATH` is
 * unset or names a binary outside the real data directory. A path that is
 * lexically inside is refused without touching it; otherwise the executable
 * is resolved, so a symlink into the data directory still counts. The data
 * directory itself is never resolved, only its parent.
 */
export function realDataDirClaudeCliRefusal(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string | null {
  const executable = env.CLAUDE_CLI_PATH?.trim();
  if (!executable || env[ALLOW_REAL_DATA_DIR_CLI_ENV] === "1") return null;
  const dataDir = path.resolve(defaultOrkestratorDataDir(platform, env, home));
  const roots = [dataDir, path.join(canonical(path.dirname(dataDir)), path.basename(dataDir))];
  const inside = (candidate: string) => roots.some((root) => isInside(candidate, root));
  if (!inside(path.resolve(executable)) && !inside(canonical(executable))) return null;
  return (
    "CLAUDE_CLI_PATH names a Claude CLI inside the real Orkestrator data directory, " +
    "which live probes must not run. Point it at a throwaway install " +
    "(`mise run toolchain:install --data-dir <throwaway dir> --tool claude`, then " +
    "CLAUDE_CLI_PATH=<throwaway dir>/toolchains/claude/<version>/<platform>/claude), " +
    `unset it to use the SDK's bundled CLI, or set ${ALLOW_REAL_DATA_DIR_CLI_ENV}=1 ` +
    "to run your own install deliberately."
  );
}

/** Throws before a live probe starts a CLI from the real data directory. */
export function refuseRealDataDirClaudeCli(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): void {
  const refusal = realDataDirClaudeCliRefusal(env, platform, home);
  if (refusal) throw new Error(refusal);
}
