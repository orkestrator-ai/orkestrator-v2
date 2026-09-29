/**
 * Where a backend keeps its data when `--data-dir` and `ORKESTRATOR_DATA_DIR`
 * say nothing.
 *
 * Its own module, free of the gateway and the rest of `options.ts`, so the
 * standalone CLI can resolve the same directory the service it installs for
 * will use without importing the service.
 */
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
