import type { OrkestratorGateway } from "./gateway.js";
import type { ManagedWebClient } from "./managed-web-client.js";
import { startStandaloneTailscaleServe, type TailscaleServeManager } from "./tailscale-serve.js";

type Gateway = Pick<OrkestratorGateway, "start" | "stop">;
type Serve = Pick<TailscaleServeManager, "start" | "stop">;

export interface GatewayStartupDependencies {
  createGateway: () => Gateway;
  reservePorts: (ports: number[]) => void;
  loadWebClientEnabled: () => Promise<boolean>;
  shutdownBackend: () => Promise<void>;
  managedWebClient: Pick<
    ManagedWebClient,
    "setBrowserListenerUrl" | "setEnabled" | "shutdown"
  > | null;
  tailscaleServe: boolean;
  tailscaleServePort: number;
  createTailscaleServe: () => Serve;
  logger: Pick<Console, "info" | "error">;
}

/** Startup owns cleanup until the main entrypoint installs its signal handler. */
export async function startGatewayServices(deps: GatewayStartupDependencies) {
  let gateway: Gateway | undefined;
  let tailscaleServe: Serve | null = null;
  try {
    gateway = deps.createGateway();
    const gatewayInfo = await gateway.start();
    if (!gatewayInfo) {
      throw new Error(
        "No Tailscale address was found. Pass --host with a Tailscale address, or use --host 127.0.0.1 --allow-non-tailscale-bind for local development.",
      );
    }
    deps.reservePorts(
      [
        gatewayInfo.port,
        gatewayInfo.browserUrl ? Number(new URL(gatewayInfo.browserUrl).port) : 0,
        gatewayInfo.loopbackClientUrl ? Number(new URL(gatewayInfo.loopbackClientUrl).port) : 0,
      ].filter((port) => port > 0),
    );
    let info = gatewayInfo;
    if (deps.managedWebClient) {
      deps.managedWebClient.setBrowserListenerUrl(gatewayInfo.browserUrl);
      const enabled = await deps.loadWebClientEnabled();
      void deps.managedWebClient.setEnabled(enabled).catch((error: unknown) => {
        deps.logger.error(
          `[TailscaleServe] Failed to initialize desktop web access: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      // The managed client owns the public URL; this listener is loopback-only.
      info = { ...gatewayInfo, browserUrl: undefined, browserError: undefined };
    } else if (deps.tailscaleServe) {
      if (!gatewayInfo.browserUrl) {
        throw new Error("Tailscale Serve requires an available browser listener");
      }
      tailscaleServe = deps.createTailscaleServe();
      const tailscaleUrl = await startStandaloneTailscaleServe(
        tailscaleServe,
        gatewayInfo.browserUrl,
        deps.tailscaleServePort,
      );
      deps.logger.info(`[TailscaleServe] Available at ${tailscaleUrl}`);
      info = { ...gatewayInfo, browserUrl: tailscaleUrl };
    }
    return { gatewayInfo, info, tailscaleServe };
  } catch (error) {
    // Each cleanup is attempted even if a preceding stop rejects or throws.
    // Preserve the startup error, which explains why readiness was not reached.
    for (const cleanup of [
      () => tailscaleServe?.stop(),
      () => deps.managedWebClient?.shutdown(),
      () => gateway?.stop(),
      () => deps.shutdownBackend(),
    ]) {
      try {
        await cleanup();
      } catch {
        // Best effort while unwinding startup; never mask its original error.
      }
    }
    throw error;
  }
}
