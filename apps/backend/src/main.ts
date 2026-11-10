#!/usr/bin/env bun
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { Effect } from "effect";
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { OrkestratorBackend } from "./core/index.js";
import { APP_VERSION } from "./core/constants.js";
import { fixPath } from "./core/fix-path.js";
import { dropInheritedAgentToolConnection } from "./core/agent-tools.js";
import { PreviewPublicationManager } from "./preview-publication.js";
import { OrkestratorGateway } from "./gateway.js";
import {
  assertProxiedModeHost,
  gatewayAllowsNonTailscaleBind,
  gatewayBindAddress,
} from "./gateway-bind-policy.js";
import { createManagedWebClient } from "./managed-web-client.js";
import { assertSupportedPlatform, parseOptions } from "./options.js";
import { createBackendExitHandler } from "./shutdown.js";
import { startReparentWatchdog } from "@orkestrator/protocol/parent-watchdog";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { TailscaleServeManager } from "./tailscale-serve.js";
import { createStandaloneServeOwnershipStore } from "./standalone-serve-ownership.js";
import { logGatewayPortPolicy } from "./gateway-port-policy.js";
import { createBackendLifetime, gatewayServicesStage } from "./startup-services.js";
import { configureSshAgentSocketEnvironment } from "./ssh-agent-socket.js";
import { instanceEndpoints, liveInstanceIn } from "./instance-descriptor.js";
import { createInstanceDescriptorPublication } from "./instance-descriptor-publication.js";
import { PUBLIC_API_SCHEMA_VERSION } from "@orkestrator/protocol/public-api";
import { leaseActivatedToolchainSet } from "@orkestrator/toolchain/manager";
import path from "node:path";
import { readLauncherState, standaloneLayout } from "@orkestrator/protocol/node/standalone-service";
import { createStandaloneUpdater } from "./host-standalone-updater.js";
import { loadAgentTestHostCursorApiKey } from "./core/agent-test-cursor-credential.js";
import {
  installStandaloneBackendLogging,
  stopStandaloneBackendLogging,
} from "./standalone-logging.js";
import { installBoundedConsole } from "./bounded-console.js";
import {
  addEventLoopStallContext,
  startEventLoopStallMonitor,
} from "@orkestrator/protocol/event-loop-stall-monitor";
import { commandTimings } from "./core/command-timing.js";
import { recurringWorkMetrics } from "./core/recurring-work-metrics.js";
import { slowStorageOperations } from "./core/storage-slow-operations.js";
import {
  DESKTOP_SUPERVISED_ENV,
  readApplicationLogPolicy,
} from "@orkestrator/protocol/node/application-logging";
import { applyLogDetail } from "@orkestrator/protocol/node/log-policy";
import { configureLoggerFromEnvironment } from "@orkestrator/protocol/node/logger-environment";
import {
  installUncaughtExceptionLog,
  logUnhandledRejection,
} from "@orkestrator/protocol/node/process-failure-log";

const log = createLogger("backend");
const previewLog = createLogger("preview");

assertSupportedPlatform();
// First, before anything logs: Bun's console writes to a stalled stdout reader
// block this whole process (see bounded-console.ts).
const boundedConsole = installBoundedConsole();
// Before standalone logging clears the flag: the desktop reads this process's
// stdio and needs each logger entry's level (docs/architecture/logging.md).
configureLoggerFromEnvironment(process.env, {
  relayToSupervisor: process.env[DESKTOP_SUPERVISED_ENV] === "1",
});
// A stall line says how much CPU this process used during it: near the stall's
// length means its own thread was busy, far below means it waited.
startEventLoopStallMonitor({
  cpuUsage: () => {
    const usage = process.cpuUsage();
    return usage.user + usage.system;
  },
});
// A stall line names the slow SQLite calls, the commands and the recurring jobs
// that ran during it.
addEventLoopStallContext((window) => slowStorageOperations.stallContext(window));
addEventLoopStallContext((window) => commandTimings.stallContext(window));
addEventLoopStallContext((window) => recurringWorkMetrics.stallContext(window));
// Before any other startup work: a rejection thrown while the backend is still
// coming up would otherwise be fatal too, and this process is what the desktop
// supervisor treats as the app itself.
installFatalRejectionGuard({ label: "[Backend]", onRejection: logUnhandledRejection });
installUncaughtExceptionLog();
// Login-shell profiles are child processes too; sanitize before discovering PATH.
dropInheritedAgentToolConnection();
fixPath();
// Capture this before startup awaits. If Electron dies while the backend is
// initializing, reading process.ppid later would see init and lose the only
// identity that lets the orphan watchdog recognize the transition.
const initialParentPid = process.ppid;
const options = parseOptions(process.argv.slice(2));
assertProxiedModeHost(options);
// Establish persistence before any fallible startup await (including toolchain
// lease inspection). Supervised backends still relay to their desktop owner.
const standaloneLogging = installStandaloneBackendLogging(options);
await mkdir(options.dataDir, { recursive: true });
loadAgentTestHostCursorApiKey({
  dataDir: options.dataDir,
  runtimeFlavor: options.runtimeFlavor,
  credentialSources: new Set(options.credentialSources),
});
await leaseActivatedToolchainSet(options.dataDir, options.toolchainBinDir);
// Before anything logs at a level the settings may turn off. The backend's log
// policy service keeps this live from here on.
applyLogDetail(readApplicationLogPolicy(options.dataDir).detail);
log.info("starting", { version: APP_VERSION });
await logGatewayPortPolicy(options, process.env, liveInstanceIn);
const sshAgentSocket = await configureSshAgentSocketEnvironment({
  dataDir: options.dataDir,
  runtimeFlavor: options.runtimeFlavor,
});
if (sshAgentSocket) {
  log.info("ssh-socket.resolved", { source: sshAgentSocket.source });
} else if (options.runtimeFlavor !== "agent-test") {
  log.warn("ssh-socket.missing");
}

// A launcher-supervised standalone backend updates itself; the launcher passes
// its directory, which must be this data directory's.
const standaloneLayoutForService =
  options.standaloneUpdaterDir &&
  path.resolve(options.standaloneUpdaterDir) === standaloneLayout(options.dataDir).root
    ? standaloneLayout(options.dataDir)
    : null;
if (options.standaloneUpdaterDir && !standaloneLayoutForService) {
  log.warn("standalone-updater.mismatch");
}

// Before any stage starts (AGENTS.md invariant 16): a signal, or the parent's
// death, during `init()` or gateway start stops exactly what was started
// instead of taking Bun's default action with no drain, and a failed startup
// releases it too before exiting 1. The steps above start nothing that
// outlives the process.
const lifetime = createBackendLifetime({
  exit: createBackendExitHandler({
    stopLogging: () => stopStandaloneBackendLogging(standaloneLogging),
    flushConsole: (timeoutMs) => boundedConsole.flush(timeoutMs),
    exit: (code) => process.exit(code),
  }),
});
process.on("SIGINT", () => void lifetime.stop("SIGINT"));
process.on("SIGTERM", () => void lifetime.stop("SIGTERM"));

// The Electron supervisor cannot deliver SIGTERM if it crashes or is
// force-killed, and this process would otherwise keep every local bridge (and
// each bridge's app-server tree) alive as orphans. When the parent that spawned
// us disappears, run the same drain a SIGTERM would have. Install this before
// the ready contract too: readiness means every lifecycle observer is active.
startReparentWatchdog({
  initialParentPid,
  onReparented: () => {
    log.warn("parent.exited");
    void lifetime.stop("SIGTERM");
  },
});

let gateway!: OrkestratorGateway;
const managedWebClient = options.desktopWebClient
  ? createManagedWebClient(options.tailscaleExecutable, options.dataDir, options.tailscaleServePort)
  : null;
const backend = new OrkestratorBackend({
  dataDir: options.dataDir,
  applicationLogging: standaloneLogging,
  toolchainBinDir: options.toolchainBinDir,
  appRoot: options.appRoot,
  resourceRoot: options.resourceRoot,
  runtimeFlavor: options.runtimeFlavor,
  worktreeDir: options.worktreeDir,
  dockerImage: options.dockerImage,
  strictDockerOwner: options.strictDockerOwner,
  credentialSources: options.credentialSources,
  agentToolsPort: options.agentToolsPort,
  hostUpdater: options.desktopUpdater
    ? "desktop"
    : standaloneLayoutForService
      ? "standalone"
      : "none",
  hostRollbackEvidence: () =>
    standaloneLayoutForService ? readLauncherState(standaloneLayoutForService).rollback : null,
  emit: (event, payload) => gateway?.emit(event, payload),
  commandNode: options.commandNode,
});
let instancePublication: ReturnType<typeof createInstanceDescriptorPublication> | null = null;

// Each stage's release runs when the backend stops, in reverse order; see
// `BackendLifetime` for why stages finish before a stop interrupts startup.
await lifetime.start(
  Effect.gen(function* () {
    // Released even after a failed `init()`: `shutdown()` stops whatever it started.
    yield* lifetime.stage(
      () => backend.init(),
      [
        { step: "instance-descriptor", run: () => instancePublication?.close(), fatal: true },
        { step: "local-servers", run: () => backend.shutdown(), fatal: true },
      ],
    );

    const { gatewayInfo, info } = yield* gatewayServicesStage(lifetime, {
      createGateway: () => {
        return (gateway = new OrkestratorGateway({
          previews: backend.previews,
          backend,
          dataDir: options.dataDir,
          rendererRoot: options.rendererRoot,
          rendererDevServerUrl: options.rendererDevServerUrl,
          bindAddress: gatewayBindAddress(options),
          fallbackBindAddress: options.fallbackHost,
          port: options.port,
          controlBindAddress: options.controlHost,
          controlPort: options.controlPort,
          loopbackClientPort: options.loopbackClientPort,
          backendHello: () => backend.backendHelloIdentity(),
          nodeHooks: backend.nodeGateway(),
          compression: options.compression,
          allowNonTailscaleBind: gatewayAllowsNonTailscaleBind(options),
          allowedOrigins: options.allowedOrigins,
          strictPort: options.strictGatewayPort,
          agentTestMode: options.runtimeFlavor === "agent-test",
          agentTestProfile: options.runtimeProfileId,
          webClientControl: managedWebClient ?? undefined,
          hostUpdaterControl: options.desktopUpdater
            ? {
                snapshot: () => backend.hostMaintenance.snapshotWithImpact(),
                report: (report) => backend.hostMaintenance.report(report),
              }
            : undefined,
        }));
      },
      reservePorts: (ports) => backend.previews?.reservePorts("gateway", ports),
      loadWebClientEnabled: async () => {
        const config = await backend.invoke<{ global?: { webClientEnabled?: boolean } }>(
          "get_config",
        );
        return config.global?.webClientEnabled ?? true;
      },
      managedWebClient,
      tailscaleServe: options.tailscaleServe,
      tailscaleServePort: options.tailscaleServePort,
      standaloneServeOwnership: createStandaloneServeOwnershipStore(options.dataDir),
      createTailscaleServe: () => new TailscaleServeManager(options.tailscaleExecutable),
    });

    // Command nodes register these on their leaves, so a client that loaded this
    // node's portal can reach a leaf directly.
    backend.setPortalOriginsSource(() =>
      [
        gatewayInfo.browserUrl,
        info.browserUrl,
        managedWebClient?.getStatus().url ?? undefined,
        ...(options.allowedOrigins ?? []),
        options.rendererDevServerUrl,
      ].filter((origin): origin is string => Boolean(origin)),
    );

    // Handed to another node that becomes this node's command node: the token and
    // only the addresses that serve this backend (not other allowed origins).
    backend.setSelfAccessSource(async () => ({
      token: (await gateway.getTokenSettings()).token,
      origins: [gatewayInfo.browserUrl, info.browserUrl, managedWebClient?.getStatus().url].filter(
        (origin): origin is string => Boolean(origin),
      ),
    }));

    // Transcript artifacts: the executable-content origin must differ from, and
    // may be framed only by, the application's own page origins.
    backend.setTranscriptArtifactApplicationOrigins({
      application: [
        gatewayInfo.browserUrl,
        info.browserUrl,
        ...(options.allowedOrigins ?? []),
      ].filter((origin): origin is string => Boolean(origin)),
      development: options.rendererDevServerUrl ? [options.rendererDevServerUrl] : [],
    });

    // Private preview origins are optional: a missing domain or certificate only
    // disables browser publication and never blocks the backend from serving.
    const publication = backend.previews
      ? new PreviewPublicationManager({
          runtime: backend.previews,
          // Warn when the preview domain shares a site with any of these.
          applicationOrigins: () => [
            gatewayInfo.browserUrl,
            info.browserUrl,
            managedWebClient?.getStatus().url,
            ...(options.allowedOrigins ?? []),
          ],
        })
      : null;
    yield* lifetime.stage(
      () =>
        publication?.start().catch((error: unknown) => {
          previewLog.warn("publication.start-failed", { error: formatLogError(error) });
        }),
      [{ step: "preview-publication", run: () => publication?.dispose() }],
    );

    let instanceIdentity: { installationId: string; generation: string; startedAt: string } | null =
      null;
    const descriptor = createInstanceDescriptorPublication({
      subscribe: (listener) => backend.onControlMcpStateChange(listener),
      snapshot: () => {
        if (!instanceIdentity) return null;
        const controlMcp = backend.getControlMcpEndpointState();
        return {
          ...instanceIdentity,
          pid: process.pid,
          url: info.url,
          ...(info.browserUrl && info.browserUrl !== info.url
            ? { browserUrl: info.browserUrl }
            : {}),
          endpoints: instanceEndpoints(gatewayInfo),
          ...(controlMcp ? { controlMcp } : {}),
          authFile: info.authFile,
          dataDir: options.dataDir,
          appVersion: APP_VERSION,
          publicApiSchemaVersion: PUBLIC_API_SCHEMA_VERSION,
        };
      },
      onError: (error) => {
        log.warn("instance.republish-failed", { error: formatLogError(error) });
      },
    });
    instancePublication = descriptor;

    // Publish the installed-instance descriptor that operator clients resolve
    // (`orkestrator --connection …`). It is additive to the readiness line below
    // and carries no credential; a failure to write it never blocks serving.
    yield* lifetime.stage(async () => {
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
          instanceIdentity = {
            installationId: identity.installationId,
            generation: identity.generation,
            startedAt: new Date().toISOString(),
          };
          await descriptor.refresh();
        }
      } catch (error) {
        log.warn("instance.publish-failed", { error: formatLogError(error) });
      }
    });

    // Machine-readable startup means both serving and lifecycle handling are ready.
    // Signal handling and parent-death detection were installed before startup,
    // so a supervisor cannot act on this line before graceful shutdown is armed.
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
        loopbackClientUrl: info.loopbackClientUrl,
        loopbackClientError: info.loopbackClientError,
        controlMcpUrl: backend.getControlMcpInfo()?.url,
        controlMcpFile: backend.getControlMcpInfo()?.descriptorFile,
      })}\n`,
    );
    // The standalone launcher observes the descriptor, not stdout. A publication
    // failure must leave the update pending so its eventual rollback can fail it.
    if (!standaloneLayoutForService || descriptor.published) {
      backend.hostMaintenance.markReady();
      // Settle the previous process's job before the executor can observe it.
      // In particular, a stale requested job must never be dispatched again.
      if (standaloneLayoutForService) {
        createStandaloneUpdater({
          service: backend.hostMaintenance,
          layout: standaloneLayoutForService,
          dataDir: options.dataDir,
          currentVersion: APP_VERSION,
          // The launcher sees `restart-requested` and starts the new release.
          shutdown: () => void lifetime.stop("SIGTERM"),
        }).start();
      }
    }
  }),
);
