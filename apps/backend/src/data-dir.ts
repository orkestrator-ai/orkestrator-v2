/**
 * Where a backend keeps its data when `--data-dir` and `ORKESTRATOR_DATA_DIR`
 * say nothing.
 *
 * Its own module, free of the gateway and the rest of `options.ts`, so the
 * standalone CLI can resolve the same directory the service it installs for
 * will use without importing the service.
 */
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_SLUG } from "./core/constants.js";

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    throw new Error("Orkestrator does not support Windows. Use macOS or Linux.");
  }
}

export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  assertSupportedPlatform(platform);
  if (platform === "darwin") return path.join(home, "Library", "Application Support", APP_SLUG);
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), APP_SLUG);
}

/**
 * Whether `dataDir` is the platform default data directory, comparing real
 * paths so a symlink to the default still counts. Only that directory's
 * backend may hold the user's fixed per-user ports (the Control MCP's 34122).
 */
export function isDefaultDataDir(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): boolean {
  const canonical = (value: string): string => {
    try {
      return realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  return canonical(dataDir) === canonical(defaultDataDir(platform, env, home));
}
