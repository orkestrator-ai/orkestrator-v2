import { defaultDataDir, isDefaultDataDir } from "./data-dir.js";
import type { BackendOptions } from "./options.js";
import type { liveInstanceIn } from "./instance-descriptor.js";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("backend");

export async function logGatewayPortPolicy(
  options: Pick<BackendOptions, "dataDir" | "port" | "tailscaleServe">,
  env: NodeJS.ProcessEnv,
  findInstance: typeof liveInstanceIn,
): Promise<void> {
  if (!isDefaultDataDir(options.dataDir, process.platform, env)) {
    const main = await findInstance(defaultDataDir(process.platform, env));
    if (main) {
      log.info("port-policy.second-backend", {
        mainPid: main.pid,
        dataDir: options.dataDir,
        gatewayPort: options.port || "free",
        controlPort: env.ORKESTRATOR_CONTROL_MCP_PORT?.trim() ? "from-environment" : "left-to-main",
      });
    }
  }
  if (options.tailscaleServe && options.port === 0) {
    log.warn("port-policy.serve-on-free-port");
  }
}
