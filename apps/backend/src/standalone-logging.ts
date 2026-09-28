import {
  BACKEND_LOG_FILE_PREFIX,
  DESKTOP_SUPERVISED_ENV,
  installProductionApplicationLogging,
  type InstalledApplicationLogging,
} from "@orkestrator/protocol/application-logging";
import type { BackendOptions } from "./options.js";

/**
 * Persists a standalone backend's console output under `<dataDir>/logs`.
 *
 * Under Electron the desktop process captures this backend's stdout and stderr
 * into its own log, but a backend started directly (`bun dist/main.js`, as a
 * headless or Tailscale-served host) writes only to its terminal. That is where
 * bridge restarts and every `[claude:<env>]` bridge line go, so without a file
 * an agent that vanished mid-turn left no trace once the scrollback was gone.
 *
 * Follows the same Debug logging setting and retention as the desktop log, and
 * writes beside it under its own file prefix.
 */
export function installStandaloneBackendLogging(
  options: Pick<BackendOptions, "dataDir" | "runtimeFlavor">,
  env: NodeJS.ProcessEnv = process.env,
): InstalledApplicationLogging | null {
  if (env[DESKTOP_SUPERVISED_ENV] === "1") {
    // Only this directly supervised process should inherit the flag. Agent
    // CLIs, terminals and bridges can launch independent backends later.
    delete env[DESKTOP_SUPERVISED_ENV];
    return null;
  }
  // Isolated test profiles keep their diagnostics under the profile's logDir.
  if (options.runtimeFlavor === "agent-test") return null;
  return installProductionApplicationLogging({
    dataDir: options.dataDir,
    filePrefix: BACKEND_LOG_FILE_PREFIX,
  });
}

/** Flushes buffered entries before exit, bounded so a stalled disk cannot hang shutdown. */
export async function stopStandaloneBackendLogging(
  logging: InstalledApplicationLogging | null,
  timeoutMs = 2_000,
): Promise<void> {
  if (!logging) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([logging.stop().catch(() => undefined), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
