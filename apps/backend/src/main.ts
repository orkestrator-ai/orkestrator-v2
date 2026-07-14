#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { OrkestratorBackend } from "./core/index.js";
import { fixPath } from "./core/fix-path.js";
import { OrkestratorGateway } from "./gateway.js";
import { createManagedWebClient } from "./managed-web-client.js";
import { assertSupportedPlatform, parseOptions } from "./options.js";
import { getTailscaleServeTargetPort, TailscaleServeManager } from "./tailscale-serve.js";

assertSupportedPlatform();
fixPath();
const options = parseOptions(process.argv.slice(2));
if (
  (options.tailscaleServe || options.desktopWebClient)
  && options.host
  && options.host !== "127.0.0.1"
) {
  const mode = options.desktopWebClient ? "--desktop-web-client" : "--tailscale-serve";
  throw new Error(`${mode} requires --host 127.0.0.1`);
}
await mkdir(options.dataDir, { recursive: true });

let gateway: OrkestratorGateway;
let tailscaleServe: TailscaleServeManager | null = null;
const managedWebClient = options.desktopWebClient
  ? createManagedWebClient(options.tailscaleExecutable, options.tailscaleServePort)
  : null;
const backend = new OrkestratorBackend({
  dataDir: options.dataDir,
  appRoot: options.appRoot,
  resourceRoot: options.resourceRoot,
  emit: (event, payload) => gateway?.emit(event, payload),
});
await backend.init();

gateway = new OrkestratorGateway({
  backend,
  dataDir: options.dataDir,
  rendererRoot: options.rendererRoot,
  rendererDevServerUrl: options.rendererDevServerUrl,
  bindAddress: options.tailscaleServe || options.desktopWebClient
    ? (options.host ?? "127.0.0.1")
    : options.host,
  fallbackBindAddress: options.fallbackHost,
  port: options.port,
  controlBindAddress: options.controlHost,
  controlPort: options.controlPort,
  allowNonTailscaleBind: options.allowNonTailscaleBind || options.tailscaleServe || options.desktopWebClient,
  allowedOrigins: options.allowedOrigins,
  webClientControl: managedWebClient ?? undefined,
});

const gatewayInfo = await gateway.start();
if (!gatewayInfo) {
  throw new Error("No Tailscale address was found. Pass --host with a Tailscale address, or use --host 127.0.0.1 --allow-non-tailscale-bind for local development.");
}

let info = gatewayInfo;
if (managedWebClient) {
  managedWebClient.setBrowserListenerUrl(gatewayInfo.browserUrl);
  const config = await backend.invoke<{ global?: { webClientEnabled?: boolean } }>("get_config");
  const status = await managedWebClient.setEnabled(config.global?.webClientEnabled ?? true);
  info = {
    ...gatewayInfo,
    browserUrl: status.url ?? undefined,
    browserError: status.error ?? undefined,
  };
} else if (options.tailscaleServe) {
  const browserUrl = gatewayInfo.browserUrl;
  if (!browserUrl) {
    await gateway.stop();
    throw new Error("Tailscale Serve requires an available browser listener");
  }
  tailscaleServe = new TailscaleServeManager(options.tailscaleExecutable);
  try {
    const tailscaleUrl = await tailscaleServe.start(
      getTailscaleServeTargetPort(browserUrl),
      options.tailscaleServePort,
    );
    console.info(`[TailscaleServe] Available at ${tailscaleUrl}`);
    info = { ...gatewayInfo, browserUrl: tailscaleUrl };
  } catch (error) {
    await tailscaleServe.stop().catch(() => undefined);
    await gateway.stop();
    throw error;
  }
}

// Machine-readable startup contract used by the Electron supervisor and service managers.
// Authentication material stays in the mode-0600 auth file and must never enter logs.
process.stdout.write(`${JSON.stringify({
  type: "orkestrator-backend-ready",
  bindAddress: info.bindAddress,
  port: info.port,
  url: info.url,
  authFile: info.authFile,
  browserUrl: info.browserUrl,
  browserError: info.browserError,
})}\n`);

let stopping = false;
async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (tailscaleServe) {
    await tailscaleServe.stop().catch((error: unknown) => {
      console.warn(`[TailscaleServe] Failed to remove Serve configuration: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (managedWebClient) {
    await managedWebClient.shutdown().catch((error: unknown) => {
      console.warn(`[TailscaleServe] Failed to remove desktop web access: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  await gateway.stop();
  process.exit(signal === "SIGINT" ? 130 : 0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
