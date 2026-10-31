import { defaultDataDir, isDefaultDataDir } from "./data-dir.js";
import type { BackendOptions } from "./options.js";
import type { liveInstanceIn } from "./instance-descriptor.js";

export async function logGatewayPortPolicy(
  options: Pick<BackendOptions, "dataDir" | "port" | "tailscaleServe">,
  env: NodeJS.ProcessEnv,
  logger: Pick<Console, "info" | "warn">,
  findInstance: typeof liveInstanceIn,
): Promise<void> {
  if (!isDefaultDataDir(options.dataDir, process.platform, env)) {
    const main = await findInstance(defaultDataDir(process.platform, env));
    if (main) {
      const gatewayPort = options.port
        ? `asks for gateway port ${options.port}`
        : "takes a free gateway port";
      const controlPort = env.ORKESTRATOR_CONTROL_MCP_PORT?.trim()
        ? "uses ORKESTRATOR_CONTROL_MCP_PORT for its Control MCP"
        : "leaves the fixed Control MCP port to it";
      logger.info(
        `[Backend] Another backend (pid ${main.pid}) serves the default data directory; this one serves ${options.dataDir}, ${gatewayPort} and ${controlPort}.`,
      );
    }
  }
  if (options.tailscaleServe && options.port === 0) {
    logger.warn(
      "[Backend] --tailscale-serve on a free gateway port: owned Serve targets are recovered across restarts. Pass --port with --strict-gateway-port to keep one port.",
    );
  }
}
