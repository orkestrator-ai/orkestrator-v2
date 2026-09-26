#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { OrkestratorBackend } from "./core/index.js";
import { fixPath } from "./core/fix-path.js";
import { PreviewPublicationManager } from "./preview-publication.js";
import { OrkestratorGateway } from "./gateway.js";
import { createManagedWebClient } from "./managed-web-client.js";
import { assertSupportedPlatform, parseOptions } from "./options.js";
import { createBackendShutdownHandler } from "./shutdown.js";
import { startReparentWatchdog } from "@orkestrator/protocol/parent-watchdog";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { getTailscaleServeTargetPort, TailscaleServeManager } from "./tailscale-serve.js";
import { configureSshAgentSocketEnvironment } from "./ssh-agent-socket.js";
import { publishInstanceDescriptor } from "./instance-descriptor.js";
import { PUBLIC_API_SCHEMA_VERSION } from "@orkestrator/protocol/public-api";

assertSupportedPlatform();
// Before any other startup work: a rejection thrown while the backend is still
// coming up would otherwise be fatal too, and this process is what the desktop
// supervisor treats as the app itself.
installFatalRejectionGuard({ label: "[Backend]" });
fixPath();
// Capture this before startup awaits. If Electron dies while the backend is
// initializing, reading process.ppid later would see init and lose the only
// identity that lets the orphan watchdog recognize the transition.
const initialParentPid = process.ppid;
const options = parseOptions(process.argv.slice(2));
if (
  (options.tailscaleServe || options.desktopWebClient) &&
  options.host &&
  options.host !== "127.0.0.1"
) {
  const mode = options.desktopWebClient ? "--desktop-web-client" : "--tailscale-serve";
  throw new Error(`${mode} requires --host 127.0.0.1`);
}
await mkdir(options.dataDir, { recursive: true });
const sshAgentSocket = await configureSshAgentSocketEnvironment({
  dataDir: options.dataDir,
  runtimeFlavor: options.runtimeFlavor,
});
if (sshAgentSocket) {
  console.info(`[Backend] SSH agent socket resolved from ${sshAgentSocket.source}`);
} else if (options.runtimeFlavor !== "agent-test") {
  console.warn("[Backend] No usable SSH agent socket was found");
}

let gateway: OrkestratorGateway;
let tailscaleServe: TailscaleServeManager | null = null;
const managedWebClient = options.desktopWebClient
  ? createManagedWebClient(options.tailscaleExecutable, options.dataDir, options.tailscaleServePort)
  : null;
const backend = new OrkestratorBackend({
  dataDir: options.dataDir,
  toolchainBinDir: options.toolchainBinDir,
  appRoot: options.appRoot,
  resourceRoot: options.resourceRoot,
  runtimeFlavor: options.runtimeFlavor,
  worktreeDir: options.worktreeDir,
  dockerImage: options.dockerImage,
  strictDockerOwner: options.strictDockerOwner,
  credentialSources: options.credentialSources,
  emit: (event, payload) => gateway?.emit(event, payload),
});
await backend.init();

gateway = new OrkestratorGateway({
  previews: backend.previews,
  backend,
  dataDir: options.dataDir,
  rendererRoot: options.rendererRoot,
  rendererDevServerUrl: options.rendererDevServerUrl,
  bindAddress:
    options.tailscaleServe || options.desktopWebClient
      ? (options.host ?? "127.0.0.1")
      : options.host,
  fallbackBindAddress: options.fallbackHost,
  port: options.port,
  controlBindAddress: options.controlHost,
  controlPort: options.controlPort,
  compression: options.compression,
  allowNonTailscaleBind:
    options.allowNonTailscaleBind || options.tailscaleServe || options.desktopWebClient,
  allowedOrigins: options.allowedOrigins,
  strictPort: options.strictGatewayPort,
  agentTestMode: options.runtimeFlavor === "agent-test",
  agentTestProfile: options.runtimeProfileId,
  webClientControl: managedWebClient ?? undefined,
});

const gatewayInfo = await gateway.start();
if (!gatewayInfo) {
  throw new Error(
    "No Tailscale address was found. Pass --host with a Tailscale address, or use --host 127.0.0.1 --allow-non-tailscale-bind for local development.",
  );
}

// The gateway's own listeners can never become preview targets.
backend.previews?.reservePorts(
  "gateway",
  [
    gatewayInfo.port,
    gatewayInfo.browserUrl ? Number(new URL(gatewayInfo.browserUrl).port) : 0,
  ].filter((port) => port > 0),
);

let info = gatewayInfo;
if (managedWebClient) {
  managedWebClient.setBrowserListenerUrl(gatewayInfo.browserUrl);
  const config = await backend.invoke<{ global?: { webClientEnabled?: boolean } }>("get_config");
  void managedWebClient
    .setEnabled(config.global?.webClientEnabled ?? true)
    .catch((error: unknown) => {
      console.error(
        `[TailscaleServe] Failed to initialize desktop web access: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  info = {
    ...gatewayInfo,
    // The browser listener itself is loopback-only. Its public HTTPS URL is
    // authoritative in ManagedWebClient and may become available after this
    // backend readiness message has already been emitted.
    browserUrl: undefined,
    browserError: undefined,
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

// Private preview origins are optional: a missing domain or certificate only
// disables browser publication and never blocks the backend from serving.
const previewPublication = backend.previews
  ? new PreviewPublicationManager({ runtime: backend.previews, logger: console })
  : null;
await previewPublication?.start().catch((error: unknown) => {
  console.warn(
    `[previews] Private preview publication did not start: ${error instanceof Error ? error.message : String(error)}`,
  );
});

let removeInstanceDescriptor: (() => Promise<void>) | null = null;
const stop = createBackendShutdownHandler({
  stopTailscaleServe: tailscaleServe ? () => tailscaleServe!.stop() : undefined,
  stopManagedWebClient: managedWebClient ? () => managedWebClient!.shutdown() : undefined,
  stopGateway: async () => {
    await previewPublication?.dispose().catch(() => undefined);
    await gateway.stop();
  },
  stopBackend: async () => {
    await removeInstanceDescriptor?.().catch(() => undefined);
    await backend.shutdown();
  },
  warn: (message) => console.warn(message),
  exit: (code) => process.exit(code),
});
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

// The Electron supervisor cannot deliver SIGTERM if it crashes or is
// force-killed, and this process would otherwise keep every local bridge (and
// each bridge's app-server tree) alive as orphans. When the parent that spawned
// us disappears, run the same drain a SIGTERM would have. Install this before
// the ready contract too: readiness means every lifecycle observer is active.
startReparentWatchdog({
  initialParentPid,
  onReparented: () => {
    console.warn("[Backend] Parent process exited; shutting down local servers");
    void stop("SIGTERM");
  },
});

// Publish the installed-instance descriptor that operator clients resolve
// (`orkestrator --connection …`). It is additive to the readiness line below
// and carries no credential; a failure to write it never blocks serving.
try {
  const identity = (
    await backend.invoke<{
      ok?: boolean;
      result?: { backend?: { installationId?: string; generation?: string } };
    }>("public_action", {
      schemaVersion: PUBLIC_API_SCHEMA_VERSION,
      action: "capabilities",
      actionVersion: 1,
      input: {},
    })
  ).result?.backend;
  if (identity?.installationId && identity.generation) {
    removeInstanceDescriptor = await publishInstanceDescriptor({
      installationId: identity.installationId,
      generation: identity.generation,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      url: info.url,
      ...(info.browserUrl && info.browserUrl !== info.url ? { browserUrl: info.browserUrl } : {}),
      authFile: info.authFile,
      dataDir: options.dataDir,
      appVersion: process.env.ORKESTRATOR_VERSION ?? "development",
      publicApiSchemaVersion: PUBLIC_API_SCHEMA_VERSION,
    });
  }
} catch (error) {
  console.warn(
    `[Backend] Could not publish the instance descriptor: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// Machine-readable startup means both serving and lifecycle handling are ready.
// Install signal handling and parent-death detection first so a supervisor
// cannot act on this line before graceful shutdown is fully armed.
// Authentication material stays in the mode-0600 auth file and must never enter logs.
process.stdout.write(
  `${JSON.stringify({
    type: "orkestrator-backend-ready",
    bindAddress: info.bindAddress,
    port: info.port,
    url: info.url,
    authFile: info.authFile,
    browserUrl: info.browserUrl,
    browserError: info.browserError,
    controlMcpUrl: backend.getControlMcpInfo()?.url,
    controlMcpFile: backend.getControlMcpInfo()?.descriptorFile,
  })}\n`,
);
