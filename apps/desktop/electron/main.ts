import { appShortcut } from "@orkestrator/protocol/keyboard-shortcuts";
import { startEventLoopStallMonitor } from "@orkestrator/protocol/event-loop-stall-monitor";
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
  WebContentsView,
  webContents,
} from "electron";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LOCAL_CONNECTION_ID } from "@orkestrator/protocol/connections";
import { BackendProcess, type BackendHttpClient } from "./backend-process.js";
import {
  BACKEND_EXIT_WAIT_MS,
  prepareAppImageInstall,
  registerBackendShutdown,
} from "./backend-lifecycle.js";
import {
  LINUX_DESKTOP_ENTRY_FILENAME,
  PRODUCT_NAME,
  userDataDirectoryName,
} from "./app-constants.js";
import { desktopApplicationVersion } from "./app-version.js";
import { aboutPanelIconPath, aboutPanelOptions } from "./about-panel.js";
import { registerMainIpc } from "./ipc.js";
import { resolveRuntimeRoots } from "./paths.js";
import { createMainWindow, trustedRendererUrlFor } from "./window.js";
import { NodeWorkspaceScopes } from "./node-workspaces.js";
import {
  DesktopNodeScopes,
  NODE_SCOPE_IDLE_RELEASE_MS,
  type NodeScopeRecord,
} from "./node-scopes.js";
import { DesktopNodeIpc } from "./node-ipc.js";
import {
  NodePreviewRuntimes,
  nodePreviewRequestOrigin,
  nodePreviewUrl,
  routeBrowserPreviews,
  type NodePreviewRuntime,
} from "./node-previews.js";
import { editDesktopConnection } from "./desktop-connection-edits.js";
import { importSavedMachinesOnce } from "./command-node-migration.js";
import { ConnectionManager, DEFAULT_CONNECTION_SCOPE } from "./connection-manager.js";
import {
  LocalBackendCatalogueStore,
  NativeDeviceCatalogueStore,
} from "./connection-catalogue-store.js";
import { registerFederationIpc } from "./federation-ipc.js";
import { SshPromptBroker } from "./ssh-prompt-broker.js";
import { createSshAdapterContext, SshTunnelSupervisor } from "./ssh/index.js";
import { createUnavailableLocalBackend } from "./unavailable-local-backend.js";
import { installRemoteGatewayRequestAuth } from "./remote-gateway-request-auth.js";
import { createWindowRequestAuthorization } from "./window-request-authorization.js";
import { removeRealmPartitions } from "./realm-partition-cleanup.js";
import { ensurePinnedToolchains } from "@orkestrator/toolchain/manager";
import { pinnedArtifactsForPlatforms } from "@orkestrator/toolchain/manifest";
import {
  chooseAgentPlatforms,
  createDialogHostWindow,
  createMacOsPermissionSplashWindow,
  createToolchainBootstrapWindow,
  reportToolchainProgress,
} from "./toolchain-bootstrap-window.js";
import { createToolchainProgressController, preparePinnedToolchains } from "./toolchain-startup.js";
import {
  applyAgentTestPlatformSelection,
  saveAgentPlatformSelection,
} from "./agent-platform-selection.js";
import { loadAgentPlatformSelection } from "@orkestrator/toolchain/platform-selection";
import type {
  BrowserPreviewManager,
  BrowserPreviewServiceTransport,
} from "./browser-preview-manager.js";
import { connectionPreviewBackend } from "./preview-connection-backend.js";
import { PreviewTransportManager } from "./preview-transport-manager.js";
import { createPreviewPortHints } from "./preview-port-hints.js";
import {
  nodePartitionKey,
  PreviewPartitionRetention,
  previewPartitionsInUse,
} from "./preview-partition-retention.js";
import { PreviewExternalHandoff } from "./preview-external-handoff.js";
import { openServiceInExternalBrowser } from "./preview-external-forward.js";
import type { PreviewAttachmentDescriptor } from "@orkestrator/protocol/preview-access";
import type { PreviewCapabilities } from "@orkestrator/protocol/preview-services";
import {
  configurePreviewServiceSession,
  createBrowserPreviewAddressFocusHandler,
  initializeBrowserPreviews,
  registerBrowserPreviewWindowActivation,
} from "./browser-preview-startup.js";
import { createBrowserPreviewMainAdapters } from "./browser-preview-main-adapters.js";
import {
  BROWSER_PREVIEW_CAPTURE_DIRECTORY,
  BrowserPreviewCaptureStore,
} from "./browser-preview-capture-store.js";
import {
  BROWSER_PREVIEW_CAPTURE_EVENT,
  type BrowserPreviewCaptureEvent,
} from "@orkestrator/protocol/browser-preview";
import { registerSecondInstanceFocus } from "./single-instance.js";
import {
  handleStartupFailure,
  registerQuitReopenRelaunch,
  registerWindowAllClosedQuit,
} from "./quit-policy.js";
import { createApplicationMenuTemplate } from "./application-menu.js";
import { RendererDebugTools } from "./renderer-debug-tools.js";
import {
  KeyboardShortcutsController,
  requestAppShortcut,
  type KeyboardShortcutsTarget,
} from "./keyboard-shortcuts-menu.js";
import { KeyboardShortcutsRouting } from "./keyboard-shortcuts-routing.js";
import {
  createAutoUpdateController,
  isAutoUpdateSupported,
  type AutoUpdateController,
} from "./auto-update.js";
import {
  confirmRestartWithCountdown,
  createHostUpdateExecutor,
  type HostUpdateExecutor,
} from "./host-update-executor.js";
import {
  recoverRemoteBackendFailure,
  readRemoteRelaunchMarker,
  writeRemoteRelaunchMarker,
} from "./remote-relaunch.js";
import { relaunchApplication } from "./relaunch.js";
import { showRestartPrompt } from "./restart-prompt.js";
import { createNativeDialogs, installUncaughtExceptionDialog } from "./native-dialogs.js";
import { createDialogAttention } from "./dialog-attention.js";
import { createStartupFailureReporter } from "./startup-failure.js";
import {
  applyWindowTitle,
  focusWindowById,
  projectMenuWindows,
  resolveFocusedWindowContext,
} from "./window-menu.js";
import {
  agentToolsPortForRuntime,
  chromiumSwitchesForRuntime,
  hiddenWindowsForRuntime,
  previewRetentionTimingForRuntime,
  runtimeProfileFromEnvironment,
} from "./runtime-profile.js";
import { hiddenWindowConstructor } from "./hidden-windows.js";
import {
  installProductionApplicationLogging,
  readApplicationLogPolicy,
  registerApplicationLoggingShutdown,
  registerWillQuitHold,
} from "./application-logging.js";
import { claimDesktopLogging, exitWithEssentialLog } from "./essential-logging.js";
import {
  browserPreviewPartitionForWindow,
  browserPreviewServicePartition,
  cleanupFailedDesktopWindow,
  connectionPartitionKey,
  DesktopWindowRequestGate,
  DesktopWindowSlotAllocator,
  releaseBoundWindowIfQuitting,
  rendererPartitionForWindow,
} from "./desktop-window-lifecycle.js";
import {
  createSerializedMacOsPermissionProbe,
  peekPersistedActiveConnectionId,
  probeMacOsPermissions,
  shouldProbeMacOsPermissionsBeforeBackend,
} from "./macos-permissions.js";
import { createClipboardTextWriter } from "./clipboard.js";
import {
  handOverCommandNode,
  previewCommandHandover,
  type CommandHandoverDeps,
} from "./command-handover.js";
import { ArtifactHostManager } from "./artifact-host-manager.js";
import { reportArtifactHostDiagnostics, reportMainThreadStall } from "./diagnostic-logging.js";
import {
  processMemoryDiagnosticInterval,
  startProcessMemoryDiagnostic,
} from "./process-memory-diagnostic.js";
import { ARTIFACT_SHELL_SCHEME_PRIVILEGES } from "./artifact-host-shell.js";
import { ARTIFACT_HOST_CHANNELS } from "@orkestrator/protocol/artifact-host-ipc";
import {
  DesktopWindowContexts,
  createDesktopRelayedLifecycle,
  emitToContents,
} from "./desktop-window-contexts.js";
import { readLocalWindowGatewayTransport } from "./local-window-transport.js";
import { installSocketTypeOfServiceGuard } from "./socket-tos-guard.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { configureLoggerFromEnvironment } from "@orkestrator/protocol/node/logger-environment";
import { applyLogDetail } from "@orkestrator/protocol/node/log-policy";
import { createLiveLogPolicy } from "./live-log-policy.js";
import { createUpdaterLibraryLogger } from "./updater-log.js";
import { desktopDevMode } from "./dev-mode.js";

configureLoggerFromEnvironment(process.env);
const desktopLog = createLogger("desktop");
const previewLog = createLogger("preview");
const updaterLog = createLogger("updater");
const toolchainLog = createLogger("toolchain");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const devMode = desktopDevMode(app);
const isDev = devMode.isDev;
const devServerUrl = devMode.devServerUrl;
if (devMode.ignoredDevRequest) desktopLog.warn("dev-mode.ignored-packaged");
// Electron 45's bundled undici can throw EINVAL from a reset socket on macOS.
installSocketTypeOfServiceGuard();
// Menu items copy synchronously; Electron 44's writeText returns a Promise whose
// rejection would otherwise be unhandled and terminate the main process.
const writeClipboardText = createClipboardTextWriter(clipboard, (error) =>
  desktopLog.error("clipboard.write-failed", { error: formatLogError(error) }),
);
const runtimeProfile = runtimeProfileFromEnvironment();
const runtimeFlavor = runtimeProfile?.flavor ?? (isDev ? "development" : "production");
const productName = runtimeProfile?.electronTitle ?? PRODUCT_NAME;

app.setName(productName);
app.setAboutPanelOptions(
  aboutPanelOptions({
    productName,
    version: desktopApplicationVersion(app),
    iconPath: aboutPanelIconPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      dirname: __dirname,
    }),
  }),
);
for (const name of chromiumSwitchesForRuntime(runtimeFlavor, process.platform)) {
  app.commandLine.appendSwitch(name);
}
// An agent-test profile on macOS, which has no headless platform: no Dock icon,
// no menu bar, never the active app, and every window constructed hidden. The
// browser suites reach the app through the gateway, not these windows.
const hiddenWindows = hiddenWindowsForRuntime(runtimeFlavor, process.platform);
if (hiddenWindows) app.setActivationPolicy("accessory");
const WindowCtor = hiddenWindows ? hiddenWindowConstructor(BrowserWindow) : BrowserWindow;
if (process.platform === "linux") app.setDesktopName(LINUX_DESKTOP_ENTRY_FILENAME);
app.setPath(
  "userData",
  runtimeProfile?.dataDir ?? path.join(app.getPath("appData"), userDataDirectoryName(isDev)),
);
// The live artifact host's trusted viewer shell needs a tuple origin (so the
// content server's frame-ancestors can name it). Must precede `ready`; the
// scheme is only ever handled on each live host's private session.
protocol.registerSchemesAsPrivileged([ARTIFACT_SHELL_SCHEME_PRIVILEGES]);
// Before the writer's first line. The backend's settings changes reach this
// process through `applyStoredLogPolicy`, so none of this waits for a restart.
applyLogDetail(readApplicationLogPolicy(app.getPath("userData")).detail);
// Must follow the userData override and precede installing any persistent writer.
// A rejected secondary launch continues module evaluation until app.quit settles.
const { isPrimaryInstance, essentialLog } = claimDesktopLogging(app, app.getPath("userData"));
const ESSENTIAL_LOG_STOP_WAIT_MS = 2_000;
const applicationLogging =
  isPrimaryInstance && runtimeFlavor === "production"
    ? installProductionApplicationLogging({ dataDir: app.getPath("userData") })
    : null;

const liveLogPolicy = createLiveLogPolicy({
  dataDir: app.getPath("userData"),
  logging: applicationLogging,
});
const applyStoredLogPolicy = liveLogPolicy.apply;
app.on("will-quit", () => liveLogPolicy.dispose());
// Development only (plan 0004): per-process memory and the node scopes held.
const stopProcessMemoryDiagnostic = startProcessMemoryDiagnostic({
  intervalMs: processMemoryDiagnosticInterval(isDev),
  metrics: () => (app.isReady() ? app.getAppMetrics() : []),
  nodeScopes: () =>
    [...windowContexts.values()].reduce((count, context) => count + context.nodes.size, 0),
});
app.on("will-quit", stopProcessMemoryDiagnostic);

let backend: BackendHttpClient | null = null;
let nodeWorkspaceScopes: NodeWorkspaceScopes | null = null;
let connectionManager: ConnectionManager | null = null;
let sshPrompts: SshPromptBroker | null = null;
let connectionListPublish: ReturnType<typeof setTimeout> | null = null;
/** Per-(window, node) scopes, opened by the window renderer through `nodeIpc`. */
const nodeScopes = new DesktopNodeScopes({
  manager: () => connectionManager,
  // Plan item 4002: an unheld node scope goes after the desktop's suspend time.
  idleMs: NODE_SCOPE_IDLE_RELEASE_MS,
  scopes: () => {
    const manager = connectionManager;
    if (!manager) throw new Error("Connections are not initialized");
    // Node scopes pass their own command access; this is only the default.
    return (nodeWorkspaceScopes ??= new NodeWorkspaceScopes((command, args) =>
      manager.invoke(command, args),
    ));
  },
});
type DesktopWindowContext = {
  window: BrowserWindow;
  /** The window's renderer. */
  contents: Electron.WebContents;
  scope: string;
  slot: number;
  /** The connection the window's current previews were created for. */
  previewConnectionId: string;
  browserPreviewManager: BrowserPreviewManager;
  previewTransport: PreviewTransportManager;
  artifactHosts: ArtifactHostManager;
  /** Local events and commands use the gateway directly; see `local-window-transport.ts`. */
  localGatewayTransport?: boolean;
  /** This window's scopes on other nodes, by node; see `node-scopes.ts`. */
  nodes: Map<string, NodeScopeRecord>;
};

let previewPortHints: ReturnType<typeof createPreviewPortHints> | null = null;
let previewPartitionRetention: PreviewPartitionRetention | null = null;
let browserPreviewCaptures: BrowserPreviewCaptureStore | null = null;
const previewExternalHandoff = new PreviewExternalHandoff((url) => shell.openExternal(url));
const desktopWindows = new DesktopWindowContexts<DesktopWindowContext>({
  connections: () => connectionManager,
  createPreviews: (context, connectionId, partitionKey) =>
    createWindowBrowserPreviews(
      context.window,
      context.scope,
      context.slot,
      connectionId,
      partitionKey,
    ),
  cancelPrompts: (webContentsId) => sshPrompts?.cancelFor(webContentsId),
  releaseWorkspaceGrant: (scope) => nodeWorkspaceScopes?.release(scope),
  releaseNodeScopes: (context) => nodeScopes.releaseWindowNodeScopes(context),
  releaseSlot: (slot) => windowSlots.release(slot),
  setConnectionTitle: (context) => setConnectionTitle(context.window, context.scope),
  publishConnectionLists: () => publishConnectionLists(),
  menuChanged: () => createMenu(),
  logger: previewLog,
});
/** Node-addressed invoke, events and gateway snapshots for window renderers. */
const nodeIpc = new DesktopNodeIpc<DesktopWindowContext>({
  nodeScopes,
  manager: () => connectionManager,
  mapNodeConnection: (context, nodeId, connectionId) =>
    desktopWindows.mapNodeConnection(context, nodeId, connectionId),
});
/** Other nodes' preview runtimes in each window, and which tab shows on which. */
const nodePreviews = new NodePreviewRuntimes<DesktopWindowContext, BrowserPreviewManager>({
  windowPreviews: (context) => context.browserPreviewManager,
  isCommandNode: (context, nodeId) => nodeIpc.isCommandNode(context, nodeId),
  openNode: (context, nodeId) => nodeIpc.open(context, nodeId),
  createRuntime: (context, record, partitionKey) =>
    createNodeBrowserPreviews(context, record, partitionKey),
});
const relayedLifecycle = createDesktopRelayedLifecycle(desktopWindows, () =>
  scheduleConnectionListPublish(),
);
const windowContexts = desktopWindows.windows;

function rendererContexts(): DesktopWindowContext[] {
  return desktopWindows.renderers();
}
const MAX_DESKTOP_WINDOWS = 32;
const windowSlots = new DesktopWindowSlotAllocator(MAX_DESKTOP_WINDOWS);
const windowRequestGate = new DesktopWindowRequestGate();
let legacyRendererSessionClaimed = false;
const backendProcess = new BackendProcess();
const getMacOsPermissions = createSerializedMacOsPermissionProbe(() =>
  probeMacOsPermissions({
    runtimeFlavor,
    homeDirectory: os.homedir(),
  }),
);
// Closing a main window may quit; the windowless moments before the first one,
// between programmatic first-run setup handoffs, must not.
const windowAllClosedQuit = registerWindowAllClosedQuit({
  app,
  platform: process.platform,
  alwaysQuit: runtimeFlavor === "agent-test",
});
// Every relaunch goes through here: an AppImage restarts from its image file,
// never from the temporary mount that disappears when this process exits.
const relaunchingApp = {
  relaunch: () => relaunchApplication(app),
  quit: () => app.quit(),
};
const quitReopen = registerQuitReopenRelaunch({
  app,
  allowRelaunch: runtimeFlavor !== "agent-test",
  relaunch: relaunchingApp.relaunch,
});
/** The window a dialog attaches to: the focused one, else any that is open. */
function currentDialogWindow(): BrowserWindow | null {
  return (
    focusedContext()?.window ??
    BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ??
    null
  );
}
const requestDialogAttention = createDialogAttention({
  platform: process.platform,
  agentTest: runtimeFlavor === "agent-test",
  productName,
  dock: () => app.dock,
  Notification,
});
const nativeDialogs = createNativeDialogs<BrowserWindow>({
  hiddenWindows,
  // A headless `dev:test` profile on Linux (HEADLESS_ELECTRON_SWITCHES).
  noDisplay: app.commandLine.getSwitchValue("ozone-platform") === "headless",
  dialog,
  platform: process.platform,
  currentWindow: currentDialogWindow,
  createHostWindow: async () => {
    await app.whenReady();
    return createDialogHostWindow({ BrowserWindowCtor: WindowCtor, dirname: __dirname });
  },
  requestAttention: requestDialogAttention,
});
nativeDialogs.install();
installUncaughtExceptionDialog(process, nativeDialogs);
startEventLoopStallMonitor({
  report: (stall) => reportMainThreadStall(stall, (lagMs) => nativeDialogs.describeStall(lagMs)),
  cpuUsage: () => {
    const usage = process.cpuUsage();
    return usage.user + usage.system;
  },
});
const showNonBlockingError = (title: string, detail: string): void => {
  void showRestartPrompt({
    title,
    detail,
    showMessageBox: (options) => nativeDialogs.showMessageBox("backend-error", options),
    restart: () => {
      quitReopen.scheduleRelaunch();
      app.quit();
    },
  });
};
let startupComplete = false;
let autoUpdate: AutoUpdateController | null = null;
let hostUpdates: HostUpdateExecutor | null = null;
const toolchainProgress = createToolchainProgressController({
  createWindow: () =>
    createToolchainBootstrapWindow({
      BrowserWindowCtor: WindowCtor,
      dirname: __dirname,
    }),
  reportProgress: (window, progress) => reportToolchainProgress(window as BrowserWindow, progress),
  onUnexpectedClose: () => app.quit(),
  logError: (error) =>
    toolchainLog.warn("bootstrap-progress.show-failed", { error: formatLogError(error) }),
});

function emitToWindow(window: BrowserWindow, event: string, payload: unknown): void {
  if (!window.isDestroyed()) window.webContents.send("orkestrator:event", event, payload);
}

function focusedContext(): DesktopWindowContext | null {
  return resolveFocusedWindowContext(
    windowContexts,
    BrowserWindow.getFocusedWindow(),
    desktopWindows.lastFocusedWindowId,
  );
}

function followWindowConnection(context: DesktopWindowContext): void {
  desktopWindows.followConnection(context);
}

function contextForEvent(event?: { sender?: { id: number } }): DesktopWindowContext {
  return desktopWindows.forEvent(event);
}

/** IPC context of a requesting main window. */
type IpcContext = {
  window: BrowserWindow;
  scope: string;
  browserPreviewManager: BrowserPreviewManager | null;
  artifactHosts: ArtifactHostManager | null;
};

function ipcContextForEvent(event?: { sender?: { id: number } }): IpcContext {
  return contextForEvent(event);
}

function emitToConnection(connectionId: string, event: string, payload: unknown): void {
  desktopWindows.emitToConnection(connectionId, event, payload);
}

/**
 * Terminal output stays on main's local stream only while an open window takes
 * it from there. With no window open nothing changes until the next one says.
 */
function syncLocalTerminalRelay(): void {
  if (windowContexts.size > 0) {
    backend?.setTerminalOutputRelay(desktopWindows.needsLocalTerminalRelay());
  }
}

/** Machine state changes arrive in bursts (connect, hello, stream open); coalesce them. */
function scheduleConnectionListPublish(): void {
  if (connectionListPublish) return;
  connectionListPublish = setTimeout(() => {
    connectionListPublish = null;
    refreshConnectionTitles();
    publishConnectionLists();
  }, 50);
}

function emitToFocusedWindow(event: string, payload: unknown): void {
  const context = focusedContext();
  if (context) emitToWindow(context.window, event, payload);
}

/** The focused window's renderer. */
function focusedRenderer(): Electron.WebContents | null {
  const context = focusedContext();
  if (!context) return null;
  return shortcutRouting.focusedTarget(
    webContents.getFocusedWebContents()?.id,
    context.contents.id,
    context.contents,
  ).renderer as Electron.WebContents;
}

// Help → Open Developer Tools, offered only while a renderer has debug logging on.
const rendererDebugTools = new RendererDebugTools(() => createMenu());

const keyboardShortcuts = new KeyboardShortcutsController();
const shortcutRouting = new KeyboardShortcutsRouting(
  () => [...windowContexts.values()],
  keyboardShortcuts,
);

function focusedShortcutTarget(): KeyboardShortcutsTarget | null {
  const context = focusedContext();
  if (!context) return null;
  return shortcutRouting.focusedTarget(
    webContents.getFocusedWebContents()?.id,
    context.contents.id,
    context.contents,
  );
}

// A WebContents receives native input for its subframes too, including opaque
// design frames and artifact documents. Preview views retain their own hook.
app.on("web-contents-created", (_event, contents) => shortcutRouting.register(contents));

function emitToFocusedRenderer(event: string, payload: unknown): void {
  const contents = focusedRenderer();
  if (contents) emitToContents(contents, event, payload);
}

function setConnectionTitle(window: BrowserWindow, scope: string): void {
  const list = connectionManager?.getList(scope);
  const active = list?.connections.find((connection) => connection.active);
  applyWindowTitle(window, productName, active?.name, createMenu);
}

function menuWindowList() {
  return projectMenuWindows(windowContexts, focusedContext()?.window);
}

function focusDesktopWindow(id: number): void {
  focusWindowById(windowContexts, id);
  const context = windowContexts.get(id);
  if (!context || context.window.isDestroyed()) return;
  // Some Linux window managers do not synchronously report native focus back
  // to Electron. The explicit menu choice is still authoritative.
  desktopWindows.lastFocusedWindowId = id;
  createMenu();
}

/**
 * One pending-capture spool per process, shared by every window's previews, so
 * a capture survives renderer unmounts, window closes, and connection switches.
 */
function browserPreviewCaptureStore(): BrowserPreviewCaptureStore {
  if (browserPreviewCaptures) return browserPreviewCaptures;
  const store = new BrowserPreviewCaptureStore({
    directory: path.join(app.getPath("userData"), BROWSER_PREVIEW_CAPTURE_DIRECTORY),
    onChange: (change) => {
      // Content-free: ids, the kind of change, and for an expiry the notice
      // (sanitized page address and times) so the renderer can say so.
      const event: BrowserPreviewCaptureEvent = {
        tabId: change.tabId,
        captureId: change.captureId,
        status: "spool-changed",
        reason: change.reason,
        ...(change.notice ? { expired: change.notice } : {}),
      };
      for (const context of rendererContexts()) {
        emitToContents(context.contents, BROWSER_PREVIEW_CAPTURE_EVENT, event);
      }
    },
  });
  store.ready.catch(() => {
    previewLog.warn("capture-spool.load-failed");
  });
  store.startExpirySweep();
  browserPreviewCaptures = store;
  return store;
}

/** Clears preview partitions of removed services and forgotten connections. */
function previewRetention(): PreviewPartitionRetention {
  previewPartitionRetention ??= new PreviewPartitionRetention({
    partitionsDir: path.join(app.getPath("userData"), "Partitions"),
    pendingFile: path.join(app.getPath("userData"), "preview-partitions-pending.json"),
    sessionFor: (partitionName) => session.fromPartition(partitionName),
    inUse: () =>
      previewPartitionsInUse(
        rendererContexts().flatMap((context) => [
          {
            sharedPartition: browserPreviewPartitionForWindow(
              context.slot,
              context.previewConnectionId,
            ),
            transport: context.previewTransport,
          },
          ...nodePreviews.runtimes(context).map((runtime) => ({
            sharedPartition: runtime.partition,
            transport: runtime,
          })),
        ]),
      ),
  });
  return previewPartitionRetention;
}

/** A node's preview partitions stay while a command node this device uses lists it. */
function rememberPreviewNode(nodeId: string, commandConnectionId: string): void {
  void previewRetention()
    .rememberNode(nodePartitionKey(nodeId), connectionPartitionKey(commandConnectionId))
    .catch(() => previewLog.warn("node.record-failed"));
}

/**
 * A window's preview runtime on `scope`. `node` is set for a node scope's
 * runtime (`createNodeBrowserPreviews`); without it the runtime is the
 * window's own, on its command node.
 */
function createWindowBrowserPreviews(
  createdWindow: BrowserWindow,
  scope: string,
  slot: number,
  connectionId: string,
  partitionKey = connectionId,
  node?: {
    resolveAddress: (url: string) => string;
    requestOrigin: (url: string) => string | null;
  },
) {
  const partition = browserPreviewPartitionForWindow(slot, partitionKey);
  let manager: BrowserPreviewManager | null = null;
  previewPortHints ??= createPreviewPortHints(
    path.join(app.getPath("userData"), "preview-ports.json"),
  );
  // Service previews: a loopback ingress per service over the authenticated
  // tunnel of the connection this runtime was created for. Never borrows
  // another window's backend, and outlives a switch only to release on it.
  const previewBackend = connectionPreviewBackend(
    () => connectionManager?.backendForConnection(connectionId) ?? null,
  );
  const previewTransport = new PreviewTransportManager({
    invoke: <T>(command: string, args: Record<string, unknown>) =>
      previewBackend.invoke<T>(command, args),
    tunnelUrl: () => previewBackend.tunnelUrl(),
    isRemote: () => connectionId !== LOCAL_CONNECTION_ID,
    partitionFor: (target) => browserPreviewServicePartition(slot, partitionKey, target),
    sessionFor: (partitionName) => session.fromPartition(partitionName),
    clientKey: createHash("sha256").update(scope).digest("hex").slice(0, 24),
    portHints: previewPortHints,
    onStateChange: (serviceKey) => manager?.refreshService(serviceKey),
  });
  // A window on a command node also reconciles the nodes reached through it.
  const retentionSource = node
    ? previewTransport
    : {
        listServices: () => previewTransport.listServices(),
        listNodes: () => previewBackend.invoke<unknown>("list_nodes", {}),
        get closed() {
          return previewTransport.closed;
        },
      };
  // Agent-test profiles may shorten the passes; every other flavor ignores that.
  previewRetention().schedule(
    connectionPartitionKey(partitionKey),
    retentionSource,
    previewRetentionTimingForRuntime(runtimeFlavor),
  );
  const transport: BrowserPreviewServiceTransport = {
    acquire: (target, holderId) => previewTransport.acquire(target, holderId),
    release: (serviceKey, holderId) => previewTransport.release(serviceKey, holderId),
    scopeFor: (url) => previewTransport.scopeFor(url),
    describe: (url) => previewTransport.describe(url),
    target: (serviceKey) => previewTransport.target(serviceKey),
    transportState: (serviceKey) => previewTransport.transportState(serviceKey),
    resetSiteData: (target) => previewTransport.resetSiteData(target),
    sessionImportAvailable: () => previewTransport.sessionImportAvailable(),
    importSessionCookies: (target, cookies) =>
      previewTransport.importSessionCookies(target, cookies),
    sessionFor: (partitionName) =>
      configurePreviewServiceSession(session.fromPartition(partitionName), () => manager),
  };
  const emitToOwner = (event: string, payload: unknown) =>
    emitToContents(createdWindow.webContents, event, payload);
  const browserPreviewMainAdapters = createBrowserPreviewMainAdapters({
    emitToRenderers: emitToOwner,
    openExternal: (url) => shell.openExternal(url),
    writeClipboardText,
    logError: (error) =>
      previewLog.error("link.open-external-failed", { error: formatLogError(error) }),
  });
  const runtime = initializeBrowserPreviews({
    fromPartition: (partitionName) => session.fromPartition(partitionName),
    partition,
    WebContentsViewCtor: WebContentsView,
    menu: Menu,
    getWindow: () => createdWindow,
    ...browserPreviewMainAdapters,
    focusAddressBar: createBrowserPreviewAddressFocusHandler({
      getWindow: () => createdWindow,
      emitFocus: (tabId) => emitToOwner("browser-preview-focus-address", tabId),
    }),
    requestPreviewShortcut: (tabId, shortcut) => {
      const target = shortcutRouting.target(manager?.webContentsIdForTab(tabId));
      const owner = appShortcut(shortcut).owner;
      if (owner === "document") keyboardShortcuts.request(target, "toggle");
      else if (owner === "workspace") requestAppShortcut(target?.renderer, shortcut);
      else requestAppShortcut(createdWindow.webContents, shortcut);
    },
    getAuthorization: (url) =>
      connectionManager?.getRendererRequestAuthorization(url, scope) ?? null,
    transport,
    captureStore: browserPreviewCaptureStore(),
    nativeImage,
    ...node,
    // External browsers never inherit Electron's request hooks. They sign in
    // through the private preview origin with a one-use grant POSTed by a
    // loopback handoff page (the grant is never part of a URL), or, for a
    // remote backend without one, open a forward on this machine's loopback.
    openServiceExternally: (target) =>
      openServiceInExternalBrowser({
        remote: connectionId !== LOCAL_CONNECTION_ID,
        publicationAvailable: async () =>
          (await previewBackend.invoke<PreviewCapabilities>("get_preview_capabilities", {}))
            .surfaces.browserTopLevel.available,
        forward: () => previewTransport.forwardExternally(target),
        openExternal: (url) => shell.openExternal(url),
        publish: async () => {
          const attachment = await previewBackend.invoke<PreviewAttachmentDescriptor>(
            "create_preview_attachment",
            {
              serviceId: target.serviceId,
              surface: "browser-top-level",
              path: target.path,
              clientKey: createHash("sha256").update(scope).digest("hex").slice(0, 24),
            },
          );
          if (attachment.backendInstanceId !== target.backendInstanceId || !attachment.bootstrap) {
            throw new Error("This backend cannot publish the preview to an external browser.");
          }
          await previewExternalHandoff.open(attachment.attachmentId, attachment.bootstrap);
        },
      }),
  });
  manager = runtime.manager;
  return { ...runtime, previewTransport };
}

/**
 * A node scope's preview runtime in a window (`node-previews.ts`): the
 * window's renderer owns it, and its views are plain `WebContentsView`s in
 * window coordinates. Its partition is the node's (`node:<nodeId>`), and its
 * services tunnel over the node scope's connection.
 */
function createNodeBrowserPreviews(
  context: DesktopWindowContext,
  record: NodeScopeRecord,
  partitionKey: string,
): NodePreviewRuntime<BrowserPreviewManager> {
  if (!connectionManager) throw new Error("Connections are not initialized");
  rememberPreviewNode(record.nodeId, context.previewConnectionId);
  const previews = createWindowBrowserPreviews(
    context.window,
    record.scope,
    context.slot,
    connectionManager.getConnectionId(record.scope),
    partitionKey,
    {
      // Address-bar previews load through the node's own gateway (its current route).
      resolveAddress: (url) =>
        nodePreviewUrl(connectionManager?.getGatewayBaseUrl(record.scope) ?? null, url),
      // A workspace grant is admitted only from the node's own origin or a
      // command node's portal; the desktop's default origin is neither.
      requestOrigin: nodePreviewRequestOrigin,
    },
  );
  return {
    controller: previews.manager,
    partition: browserPreviewPartitionForWindow(context.slot, partitionKey),
    partitionsInUse: () => previews.previewTransport.partitionsInUse(),
    dispose: () => {
      previews.manager.destroyAll();
      void previews.previewTransport.disposeAll().catch((error: unknown) => {
        previewLog.warn("transport.close-failed", { error: formatLogError(error) });
      });
    },
  };
}

/**
 * One live interactive-artifact host per window, on its own sandboxed view
 * and fresh nonpersistent session. Events go to this window's renderer only.
 * A renderer reload leaves the host without an owner, so it is closed.
 */
function createWindowArtifactHosts(createdWindow: BrowserWindow): ArtifactHostManager {
  const owner = createdWindow.webContents;
  const artifactHosts = new ArtifactHostManager({
    getWindow: () => createdWindow,
    WebContentsViewCtor: WebContentsView,
    fromPartition: (partition) => session.fromPartition(partition, { cache: false }),
    emit: (event) => {
      if (!createdWindow.isDestroyed() && !owner.isDestroyed()) {
        owner.send(ARTIFACT_HOST_CHANNELS.event, event);
      }
    },
    // Content-free reason counters only; never URLs or page data.
    reportDiagnostics: reportArtifactHostDiagnostics,
  });
  owner.on("did-navigate", () => artifactHosts.closeAll("window-closed"));
  return artifactHosts;
}

/**
 * Updates are checked after the first window exists, so a slow or failing
 * update server can never delay or break startup.
 */
function autoUpdateSupported(): boolean {
  return isAutoUpdateSupported({
    isPackaged: app.isPackaged,
    runtimeFlavor,
    platform: process.platform,
    env: process.env,
    resourcesPath: process.resourcesPath,
  });
}

async function startAutoUpdate(): Promise<void> {
  if (!autoUpdateSupported()) return;
  try {
    const { default: electronUpdater } = await import("electron-updater");
    electronUpdater.autoUpdater.logger = createUpdaterLibraryLogger();
    const { VersionOrderedGitHubProvider } = await import("./github-update-provider.js");
    electronUpdater.autoUpdater.setFeedURL({
      provider: "custom",
      updateProvider: VersionOrderedGitHubProvider,
    });
    autoUpdate = createAutoUpdateController({
      updater: electronUpdater.autoUpdater,
      productName,
      currentVersion: app.getVersion(),
      getWindow: () => focusedContext()?.window ?? null,
      showMessageBox: (window, options) => nativeDialogs.showMessageBox("updater", options, window),
      onCheckResult: (report) => hostUpdates?.reportCheck(report),
      ...(process.platform === "linux"
        ? { prepareForInstall: () => prepareAppImageInstall(app, backendProcess) }
        : {}),
    });
    autoUpdate.start();
    createMenu();
    startHostUpdates(autoUpdate);
  } catch (error) {
    updaterLog.error("unavailable", { error: formatLogError(error) });
  }
}

/** Applies update requests from remote clients of the Local backend. */
function startHostUpdates(engine: AutoUpdateController): void {
  const local = backend;
  if (!local) return;
  hostUpdates = createHostUpdateExecutor({
    channel: {
      snapshot: () => local.hostUpdaterSnapshot(),
      report: (report) => local.reportHostUpdater(report),
    },
    engine,
    beforeInstall: ({ jobId, version }) =>
      writeRemoteRelaunchMarker(app.getPath("userData"), { jobId, version }),
    confirmRestart: ({ version, restartAt, signal }) => {
      if (process.platform === "darwin") app.dock?.bounce("critical");
      return confirmRestartWithCountdown({
        version,
        restartAt,
        signal,
        productName,
        window: currentDialogWindow(),
        showMessageBox: (window, options) =>
          nativeDialogs.showMessageBox("remote-restart", options, window as BrowserWindow),
        notify: (title, body) => {
          if (Notification.isSupported()) new Notification({ title, body }).show();
        },
      });
    },
  });
  void hostUpdates.start().catch((error: unknown) => {
    updaterLog.error("remote.unavailable", { error: formatLogError(error) });
  });
}

function createMenu(): void {
  const template = createApplicationMenuTemplate({
    platform: process.platform,
    productName,
    windows: menuWindowList(),
    newWindow: () => {
      void createWindow().catch((error) =>
        desktopLog.error("window.create-failed", { error: formatLogError(error) }),
      );
    },
    // A tab belongs to the focused window's workspace.
    closeTab: () => emitToFocusedRenderer("menu-close-tab", undefined),
    selectWindow: (id) => focusDesktopWindow(id),
    zoom: (direction) => emitToFocusedWindow("menu-zoom", direction),
    // The dialog belongs to the focused renderer.
    showKeyboardShortcuts: (request) => keyboardShortcuts.request(focusedShortcutTarget(), request),
    // Settings belong to the window's shell, so the menu item takes the same
    // path as ⌘, typed in a native view.
    openSettings: () => {
      const context = focusedContext();
      if (context && !context.window.isDestroyed())
        requestAppShortcut(context.window.webContents, "open-settings");
    },
    checkForUpdates: autoUpdate ? () => void autoUpdate?.checkNow() : undefined,
    // The focused renderer, then the window's own; then an opted-in
    // background renderer. Only opted-in contents are opened.
    openDeveloperTools: rendererDebugTools.anyEnabled()
      ? () => {
          const context = focusedContext();
          rendererDebugTools.open([focusedRenderer(), context?.contents]);
        }
      : undefined,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(connectionId?: string): Promise<void> {
  if (!connectionManager) throw new Error("Connections are not initialized");
  if (quitReopen.isQuitting()) throw new Error(`${productName} is quitting`);
  const currentContext = focusedContext();
  // A new window opens on the focused window's command node.
  const inheritedConnectionId =
    connectionId ??
    (currentContext
      ? connectionManager.getConnectionId(currentContext.scope)
      : connectionManager.getList().activeConnectionId);
  const scope = randomUUID();
  const slot = windowSlots.allocate();
  let connectionList: ReturnType<ConnectionManager["getList"]>;
  try {
    connectionList = await connectionManager.bind(scope, inheritedConnectionId);
  } catch (error) {
    windowSlots.release(slot);
    throw error;
  }
  // A quit may have stopped the Local backend while the binding was pending.
  if (
    releaseBoundWindowIfQuitting({
      isQuitting: quitReopen.isQuitting,
      releaseScope: () => connectionManager?.release(scope),
      releaseSlot: () => windowSlots.release(slot),
    })
  ) {
    throw new Error(`${productName} is quitting`);
  }
  const activeConnection = connectionList.connections.find((connection) => connection.active);
  const activeConnectionId = activeConnection?.id ?? LOCAL_CONNECTION_ID;
  const useLegacyDefaultSession = !legacyRendererSessionClaimed;
  legacyRendererSessionClaimed = true;
  // Read per window at creation: a window already open keeps its transport, so
  // one that misbehaves can be left for a new one on the other transport.
  const localGatewayTransport =
    backend !== null && readLocalWindowGatewayTransport(app.getPath("userData"));
  // One authorizer for the window's renderer over its command scope and every
  // node scope it opens later (the same `nodes` map the context holds).
  const nodes = new Map<string, NodeScopeRecord>();
  const requestAuth = createWindowRequestAuthorization(
    connectionManager,
    { scope, nodes },
    localGatewayTransport ? (url) => backend?.directTransportAuthorization(url) ?? null : null,
  );
  let registered = false;
  const allocation: { window: BrowserWindow | null } = { window: null };
  try {
    await createMainWindow({
      BrowserWindowCtor: WindowCtor,
      menu: Menu,
      writeClipboardText,
      dirname: __dirname,
      isDev,
      appPath: app.getAppPath(),
      rendererRoot: isDev ? undefined : path.join(process.resourcesPath, "web"),
      devServerUrl,
      title: `${productName} — ${activeConnection?.name ?? "Local"}`,
      partition: rendererPartitionForWindow(slot, activeConnectionId, useLegacyDefaultSession),
      openDevTools: !hiddenWindows,
      beforeLoad: (createdWindow) => {
        allocation.window = createdWindow;
        const emitToOwner = (event: string, payload: unknown) =>
          emitToWindow(createdWindow, event, payload);
        installRemoteGatewayRequestAuth(
          createdWindow.webContents.session.webRequest,
          requestAuth.authorization,
          { requestOrigin: requestAuth.requestOrigin },
        );
        const browserPreviewRuntime = createWindowBrowserPreviews(
          createdWindow,
          scope,
          slot,
          activeConnectionId,
        );
        const artifactHosts = createWindowArtifactHosts(createdWindow);
        const webContentsId = createdWindow.webContents.id;
        const windowClosed = desktopWindows.register({
          window: createdWindow,
          contents: createdWindow.webContents,
          scope,
          slot,
          previewConnectionId: activeConnectionId,
          browserPreviewManager: browserPreviewRuntime.manager,
          previewTransport: browserPreviewRuntime.previewTransport,
          artifactHosts,
          nodes,
          localGatewayTransport,
        });
        registered = true;
        syncLocalTerminalRelay();
        createMenu();
        createdWindow.on("page-title-updated", (event) => {
          event.preventDefault();
          setConnectionTitle(createdWindow, scope);
        });
        // A reloaded window no longer knows about its prompts or node scopes.
        createdWindow.webContents.on("did-navigate", () => {
          sshPrompts?.cancelFor(webContentsId);
          const context = windowContexts.get(webContentsId);
          if (context) nodeScopes.releaseWindowNodeScopes(context);
        });
        createdWindow.webContents.on("did-finish-load", () => {
          // A new window can join an already-open pooled event stream and
          // therefore miss its transport-level connected frame. Force the
          // same authoritative reconciliation after every document load.
          emitToOwner("native-event-stream-connected", undefined);
        });
        createdWindow.on("focus", () => {
          desktopWindows.lastFocusedWindowId = webContentsId;
          createMenu();
        });
        createdWindow.once("closed", () => {
          windowClosed();
          syncLocalTerminalRelay();
        });
      },
    });
    windowAllClosedQuit.markMainWindowCreated();
  } catch (error) {
    cleanupFailedDesktopWindow({
      window: allocation.window,
      registered,
      releaseScope: () => connectionManager?.release(scope),
      releaseSlot: () => windowSlots.release(slot),
    });
    throw error;
  }
}

function refreshConnectionTitles(): void {
  for (const context of windowContexts.values()) {
    if (context.window.isDestroyed()) continue;
    try {
      setConnectionTitle(context.window, context.scope);
    } catch {
      // A window still binding its connection sets its title once bound.
    }
  }
}

function publishConnectionLists(): void {
  if (!connectionManager) return;
  for (const context of windowContexts.values()) {
    try {
      emitToWindow(
        context.window,
        "desktop-connections-changed",
        connectionManager.getList(context.scope),
      );
    } catch {
      // A window still binding its connection receives its list once bound.
    }
  }
}

/** A window's command node changed: its node scopes belonged to the previous one. */
async function releaseWindowNodeScopes(context: DesktopWindowContext): Promise<void> {
  nodeScopes.releaseWindowNodeScopes(context);
}

function registerIpc(): void {
  ipcMain.handle("orkestrator:keyboard-shortcuts:closed", (event) => {
    shortcutRouting.closed(event.sender.id);
  });
  const manager = () => {
    if (!connectionManager) throw new Error("Connections are not initialized");
    return connectionManager;
  };
  const scopeForEvent = (event?: { sender?: { id: number } }) => ipcContextForEvent(event).scope;
  // A workspace grant cannot administer its node; say where that is done
  // instead of surfacing the node's refusal. A named leaf is refused
  // (`DesktopNodeIpc.adminScope`).
  const machineAdminScope = (event?: { sender?: { id: number } }, nodeId?: string) =>
    nodeIpc.adminScope(contextForEvent(event), nodeId);
  // Node scopes belong to a window.
  const nodeWindowContext = (event?: { sender?: { id: number } }) => {
    const context = event?.sender ? windowContexts.get(event.sender.id) : undefined;
    if (!context) throw new Error("Only a window can open other machines' scopes.");
    return context;
  };
  // Connection management acts on the window's own (command node) connection.
  const controlScopeForEvent = (event?: { sender?: { id: number } }) =>
    contextForEvent(event).scope;
  const commandHandoverDeps = (event?: { sender?: { id: number } }): CommandHandoverDeps => {
    const connections = manager();
    return {
      currentConnectionId: connections.getConnectionId(controlScopeForEvent(event)),
      invokeOn: (connectionId, command, args = {}) =>
        connections.invokeOn(connectionId, command, args),
      installationIdOf: (connectionId) => connections.installationIdOf(connectionId),
      connectionIdOf: (nodeId) => connections.connectionIdOf(nodeId),
      machineImportEntry: (connectionId) => connections.machineImportEntry(connectionId),
    };
  };
  const updateWindowTitle = (event: { sender?: { id: number } } | undefined) =>
    desktopWindows.updateWindowTitle(event);
  registerMainIpc({
    getBackend: (event, nodeId) => {
      if (nodeId !== undefined) return nodeIpc.backendFor(nodeWindowContext(event), nodeId);
      const scope = scopeForEvent(event);
      // The contract envelope (`options.envelope`) goes on to the backend
      // client, which sends its fields next to `command` and `args` (item 1003).
      return {
        invoke: (command, args, options) => {
          nodeWorkspaceScopes?.noteUse(scope);
          return options?.envelope
            ? manager().invoke(command, args, scope, { envelope: options.envelope })
            : manager().invoke(command, args, scope);
        },
      };
    },
    getMainWindow: (event) => ipcContextForEvent(event).window,
    getArtifactHosts: (event) => ipcContextForEvent(event).artifactHosts,
    setRendererDebugLogging: (event, enabled) => {
      rendererDebugTools.reportSender(event, enabled, (id) => webContents.fromId(id));
    },
    ipc: ipcMain,
    clipboardApi: clipboard,
    createClipboardItem: (items) => new ClipboardItem(items),
    shellApi: shell,
    appApi: {
      exit: (code) => exitWithEssentialLog(app, essentialLog, code),
      quit: () => app.quit(),
      relaunch: () => quitReopen.scheduleRelaunch(),
    },
    nativeImageApi: nativeImage,
    getMacOsPermissions,
    listConnections: (event) => manager().getList(controlScopeForEvent(event)),
    probeConnection: (connectionId) => {
      return manager().probe(connectionId);
    },
    connectToRemote: async (input, event) => {
      const context = contextForEvent(event);
      const list = await editDesktopConnection(context, { kind: "connect", input }, manager(), () =>
        releaseWindowNodeScopes(context),
      );
      followWindowConnection(context);
      refreshConnectionTitles();
      publishConnectionLists();
      return list;
    },
    updateConnectionToken: async (connectionId, token, event) => {
      const list = await manager().updateToken(connectionId, token, controlScopeForEvent(event));
      publishConnectionLists();
      return list;
    },
    renameConnection: async (connectionId, nickname, event) => {
      try {
        return await manager().rename(connectionId, nickname, controlScopeForEvent(event));
      } finally {
        // A durable rename survives the requesting window closing during its save.
        refreshConnectionTitles();
        publishConnectionLists();
      }
    },
    previewCommandHandover: (targetConnectionId, event) =>
      previewCommandHandover(commandHandoverDeps(event), targetConnectionId),
    handOverCommandNode: async (input, event) => {
      const deps = commandHandoverDeps(event);
      const result = await handOverCommandNode(deps, input, previewRetention());
      // The window follows the new command node.
      if (input.targetConnectionId !== deps.currentConnectionId) {
        const context = contextForEvent(event);
        await editDesktopConnection(
          context,
          { kind: "use", connectionId: input.targetConnectionId },
          manager(),
          () => releaseWindowNodeScopes(context),
        );
        followWindowConnection(context);
        updateWindowTitle(event);
      }
      publishConnectionLists();
      return result;
    },
    useConnection: (connectionId, event) => desktopWindows.useConnection(connectionId, event),
    forgetConnection: async (connectionId, event) => {
      const context = contextForEvent(event);
      const list = await editDesktopConnection(
        context,
        { kind: "forget", connectionId },
        manager(),
        () => releaseWindowNodeScopes(context),
      );
      followWindowConnection(context);
      // Every window has left the connection; its preview site data is unreachable.
      await previewRetention()
        .forgetConnection(connectionPartitionKey(connectionId), {
          includeShared: !Array.from(windowContexts.values()).some(
            (other) => other.previewConnectionId === connectionId,
          ),
        })
        .catch(() => previewLog.warn("connection-cleanup.record-failed"));
      updateWindowTitle(event);
      publishConnectionLists();
      return list;
    },
    openConnectionWindow: async (connectionId) => createWindow(connectionId),
    getBrowserPreviews: (event) => ipcContextForEvent(event).browserPreviewManager,
    browserPreviewRouting: routeBrowserPreviews(nodePreviews, {
      window: contextForEvent,
      nodeWindow: nodeWindowContext,
    }),
    trustedRendererUrl: isDev
      ? (devServerUrl ?? "http://127.0.0.1:1420")
      : pathToFileURL(path.join(process.resourcesPath, "web", "index.html")).href,
    getWebClientStatus: (event, nodeId) =>
      manager().getWebClientStatus(machineAdminScope(event, nodeId)),
    setWebClientEnabled: (enabled, event, nodeId) =>
      manager().setWebClientEnabled(enabled, machineAdminScope(event, nodeId)),
    resetWebClientServe: (event, nodeId) =>
      manager().resetWebClientServe(machineAdminScope(event, nodeId)),
    getGatewayTokenSettings: (event, nodeId) =>
      manager().getTokenSettings(machineAdminScope(event, nodeId)),
    setGatewayToken: (token, event, nodeId) =>
      manager().setToken(token, machineAdminScope(event, nodeId)),
    nodes: {
      open: (event, nodeId) => nodeIpc.openForRenderer(nodeWindowContext(event), nodeId),
      release: (event, nodeId) => nodeIpc.release(nodeWindowContext(event), nodeId),
      gateway: (event, nodeId) => nodeIpc.gateway(nodeWindowContext(event), nodeId),
    },
  });
  const afterCatalogueChange = <T>(list: T): T => {
    scheduleConnectionListPublish();
    return list;
  };
  ipcMain.on("orkestrator:ssh-prompt-answer", (event, promptId: unknown, answer: unknown) => {
    sshPrompts?.answer(event.sender.id, promptId, answer);
  });
  registerFederationIpc({
    ipc: ipcMain,
    trustedRendererUrl: rendererUrl(),
    gatewaySnapshot: (event) => {
      const context = contextForEvent(event);
      const identity = manager().getBackendIdentity(context.scope);
      const onLocalGateway =
        context.localGatewayTransport === true &&
        identity.connectionId === LOCAL_CONNECTION_ID &&
        backend !== null;
      return {
        baseUrl: manager().getGatewayBaseUrl(context.scope),
        ...(onLocalGateway && backend ? { localGatewayBaseUrl: backend.origin } : {}),
        connectionId: identity.connectionId,
        backendId: identity.backendId,
        legacyOrigin: identity.legacyOrigin,
        backendOnThisDevice: manager().isScopeOnThisDevice(context.scope),
        localInstallationId: manager().localInstallationId(),
      };
    },
    connectSsh: async (event, input) =>
      afterCatalogueChange(await manager().connectSsh(input, controlScopeForEvent(event))),
    probeSshHostKey: (_event, input) => manager().probeSshHostKey(input),
    trustSshHostKey: (_event, probeId) => manager().trustSshHostKey(probeId),
    removeRoute: async (event, connectionId, routeId) =>
      afterCatalogueChange(
        await manager().removeRoute(connectionId, routeId, controlScopeForEvent(event)),
      ),
    setRouteOrder: async (event, connectionId, routeIds) =>
      afterCatalogueChange(
        await manager().setRouteOrder(connectionId, routeIds, controlScopeForEvent(event)),
      ),
    setRouteEnabled: async (event, connectionId, routeId, enabled) =>
      afterCatalogueChange(
        await manager().setRouteEnabled(
          connectionId,
          routeId,
          enabled,
          controlScopeForEvent(event),
        ),
      ),
    useRoute: async (event, connectionId, routeId) =>
      afterCatalogueChange(
        await manager().useRoute(connectionId, routeId, controlScopeForEvent(event)),
      ),
    setAutoConnect: async (event, connectionId, autoConnect) =>
      afterCatalogueChange(
        await manager().setAutoConnect(connectionId, autoConnect, controlScopeForEvent(event)),
      ),
    setFeatures: async (event, features) =>
      afterCatalogueChange(await manager().setFeatures(features, controlScopeForEvent(event))),
    addRelayedListen: (event, name) => desktopWindows.addRelayedListen(event, name),
    removeRelayedListen: (event, name) => desktopWindows.removeRelayedListen(event, name),
    resetRelayedListens: (event) => desktopWindows.resetRelayedListens(event),
  });
}

function rendererUrl(): string {
  return trustedRendererUrlFor({
    isDev,
    devServerUrl,
    rendererIndexPath: path.join(process.resourcesPath, "web", "index.html"),
  });
}

async function startApplication(): Promise<void> {
  const { appRoot, resourceRoot } = resolveRuntimeRoots({
    isDev,
    dirname: __dirname,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });
  const dataDir = app.getPath("userData");
  // An agent-test profile takes its selection from the launcher rather than the
  // durable per-installation choice, so an isolated run never inherits or
  // rewrites the user's. It must still be a real selection: managed CLI-backed
  // platforms such as Grok need their toolchain provisioned for the profile.
  const isAgentTest = runtimeFlavor === "agent-test";
  const storedPlatformSelection = isAgentTest
    ? { enabled: runtimeProfile?.agentPlatforms ?? [], needsFirstRunChoice: false }
    : await loadAgentPlatformSelection(dataDir);
  const enabledAgentPlatforms = storedPlatformSelection.needsFirstRunChoice
    ? await chooseAgentPlatforms({ BrowserWindowCtor: WindowCtor, dirname: __dirname })
    : storedPlatformSelection.enabled;
  if (storedPlatformSelection.needsFirstRunChoice) {
    await saveAgentPlatformSelection(dataDir, enabledAgentPlatforms);
  }
  // Downloading a toolchain the app then refuses to offer is not provisioning.
  // The backend derives the enabled set from this profile's own state, so the
  // launcher's choice has to be written where it will read it.
  if (isAgentTest) {
    await applyAgentTestPlatformSelection(dataDir, enabledAgentPlatforms);
  }
  const artifacts = pinnedArtifactsForPlatforms(enabledAgentPlatforms);
  // After a remote-requested update nobody may be at this computer: retry on
  // our own before parking on a dialog the remote client cannot see.
  const remoteRelaunch = isAgentTest ? null : readRemoteRelaunchMarker(dataDir);
  if (remoteRelaunch) {
    updaterLog.info("remote.relaunched", { version: remoteRelaunch.version });
  }
  // Startup blocks on this step, so its duration is the toolchain's share of
  // launch-to-ready (to-do 1202 task 13 compares it before and after stamps).
  const toolchainStartedAt = performance.now();
  const toolchainBinDir = await preparePinnedToolchains({
    dataDir,
    ensure: ensurePinnedToolchains,
    // Since Electron 44 a server requesting a client certificate makes net
    // requests auto-select a matching one (select-client-certificate is not
    // handled). Toolchain hosts do not request one, so this is left as is.
    fetchImpl: (input, init) => net.fetch(input, init),
    onProgress: (progress) => toolchainProgress.report(progress),
    showMessageBox: (options) => nativeDialogs.showMessageBox("toolchain-setup", options),
    quit: () => app.quit(),
    logError: (error) => toolchainLog.error("prepare.failed", { error: formatLogError(error) }),
    artifacts,
    // Nobody is watching an agent-driven `dev:test` run, so a modal asking
    // whether to retry would hang the launcher instead of failing it: the
    // profile never reaches ready, never exits, and the cause stays trapped in a
    // dialog rather than in the log directory dev:status points at.
    interactive: !isAgentTest,
    ...(remoteRelaunch ? { unattendedRetries: { attempts: 10, delayMs: 30_000 } } : {}),
  });
  if (!toolchainBinDir) return;
  toolchainLog.info("prepare.ready", {
    durationMs: Math.round(performance.now() - toolchainStartedAt),
  });
  // Raise Files and Folders prompts before restored pipelines or agents can
  // walk the home directory. Show an in-app explanation first so the system
  // dialogs have context; skip the walk for agent-test and remote-only launches.
  const persistedActiveConnectionId = peekPersistedActiveConnectionId(dataDir);
  if (
    shouldProbeMacOsPermissionsBeforeBackend({
      runtimeFlavor,
      persistedActiveConnectionId,
    })
  ) {
    const splash = await createMacOsPermissionSplashWindow({
      BrowserWindowCtor: WindowCtor,
      dirname: __dirname,
    });
    try {
      await getMacOsPermissions();
    } finally {
      if (!splash.isDestroyed()) splash.close();
    }
  }
  const catalogueStore = new NativeDeviceCatalogueStore(path.join(dataDir, "connections"));
  let localStartError: Error | null = null;
  const startLocal = () =>
    backendProcess.start({
      isDev,
      appVersion: desktopApplicationVersion(app),
      dataDir,
      appRoot,
      resourceRoot,
      toolchainBinDir,
      rendererDevServerUrl: devServerUrl,
      gatewayHost: runtimeProfile?.gatewayHost,
      gatewayPort: runtimeProfile?.gatewayPort,
      allowNonTailscaleBind: runtimeFlavor === "agent-test",
      desktopWebClient: runtimeFlavor !== "agent-test",
      desktopUpdater: autoUpdateSupported(),
      runtimeFlavor,
      runtimeProfileId: runtimeProfile?.id,
      worktreeDir: runtimeProfile?.worktreeDir,
      dockerImage: runtimeProfile?.dockerImage,
      strictDockerOwner: runtimeFlavor === "agent-test",
      strictGatewayPort: runtimeFlavor === "agent-test",
      credentialSources: runtimeProfile?.credentialSources,
      agentToolsPort: agentToolsPortForRuntime(runtimeFlavor, runtimeProfile),
      // Before any window exists, so a launch with the setting on never opens
      // the unfiltered stream only to replace it for the first window.
      relayTerminalOutput: !readLocalWindowGatewayTransport(dataDir),
      onLogPolicyChanged: applyStoredLogPolicy,
      onEvent: (event, payload) => {
        hostUpdates?.handleEvent(event, payload);
        liveLogPolicy.onEvent(event, payload);
        if (connectionManager) connectionManager.handleLocalEvent(event, payload);
      },
      onUnexpectedExit: (error) => {
        connectionManager?.markLocalBackendUnavailable();
        emitToConnection("local", "local-backend-unavailable", { message: error.message });
        publishConnectionLists();
        // Shortly after a remote-requested update, relaunch instead of a modal
        // nobody may answer, so the remote client gets its backend back.
        if (recoverRemoteBackendFailure(dataDir, relaunchingApp)) {
          desktopLog.error("backend.exited-recovering", {
            error: formatLogError(error, { stack: false }),
          });
          return;
        }
        desktopLog.error("backend.exited", { error: formatLogError(error, { stack: false }) });
        showNonBlockingError(
          `${productName} backend stopped`,
          `${error.message}\n\nLocal work is unavailable. Remote windows remain connected; restart the application to recover Local.`,
        );
      },
    });
  try {
    backend = await startLocal();
  } catch (error) {
    // A client-only desktop keeps its saved remote machines usable when the
    // local execution backend cannot start. Without any, there is nothing to
    // show and startup fails as before.
    const saved = await catalogueStore.load().catch(() => null);
    if (isAgentTest || !saved || saved.backends.length === 0) throw error;
    localStartError = error instanceof Error ? error : new Error(String(error));
    desktopLog.error("backend.start-failed", { error: formatLogError(error) });
  }
  sshPrompts = new SshPromptBroker(() => {
    const context = focusedContext();
    return context && !context.window.isDestroyed()
      ? {
          id: context.window.webContents.id,
          send: (event, payload) => emitToWindow(context.window, event, payload),
        }
      : null;
  });
  const sshTunnels =
    process.platform === "darwin" || process.platform === "linux"
      ? new SshTunnelSupervisor({
          context: createSshAdapterContext({
            knownHostsFile: path.join(dataDir, "ssh", "known_hosts"),
          }),
          prompt: (request) => sshPrompts?.prompt(request) ?? Promise.resolve(null),
        })
      : null;
  const localClient = backend ?? createUnavailableLocalBackend();
  connectionManager = new ConnectionManager({
    localBackend: localClient,
    localBackendAvailable: backend !== null,
    secureStorage: safeStorage,
    catalogueStore,
    legacyCatalogue: backend
      ? new LocalBackendCatalogueStore(localClient, () => backend !== null)
      : null,
    sshTunnels,
    onEvent: () => undefined,
    onConnectionEvent: (connectionId, event, payload) =>
      desktopWindows.relayBackendEvent(connectionId, event, payload),
    onStateChange: relayedLifecycle.onStateChange,
  });
  await connectionManager.initialize();
  if (backend) await backend.invoke("get_config");
  if (backend && runtimeFlavor !== "agent-test") {
    const manager = connectionManager;
    const local = backend;
    // Saved machines become leaves of this desktop's command node, once.
    void importSavedMachinesOnce({
      connectionsDir: path.join(dataDir, "connections"),
      machines: () => manager.savedMachinesForCommandNode(),
      invoke: (command, args) => local.invoke(command, args),
    })
      .then((result) => {
        if (result !== "already-imported") {
          desktopLog.info("saved-machines.attached", {
            imported: result.imported,
            skipped: result.skipped,
            needsCredential: result.needsCredential,
          });
        }
      })
      .catch((error: unknown) => {
        desktopLog.warn("saved-machines.attach-failed", {
          errorName: error instanceof Error ? error.name : "unknown",
        });
      });
  }
  app.on("will-quit", () => {
    previewPartitionRetention?.dispose();
    connectionManager?.dispose();
  });

  // Before any window exists, so no session holds a partition being removed.
  await previewRetention()
    .sweepPending()
    .catch(() => undefined);
  // The retired workspace realms' storage (plan item 6003, decision 13.7 A).
  await removeRealmPartitions(app.getPath("userData"));
  createMenu();
  registerIpc();
  const queuedNewWindows = windowRequestGate.markReady();
  await createWindow();
  connectionManager.release(DEFAULT_CONNECTION_SCOPE);
  for (let index = 0; index < queuedNewWindows; index += 1) {
    await createWindow();
  }
  await toolchainProgress.close();
  startupComplete = true;
  if (localStartError) {
    emitToConnection("local", "local-backend-unavailable", { message: localStartError.message });
    showNonBlockingError(
      `${productName} local backend did not start`,
      `${localStartError.message}\n\nYour saved remote machines are still available. Restart the application to retry Local.`,
    );
  }
  await startAutoUpdate();

  if (runtimeProfile) {
    const info = backendProcess.getInfo();
    process.stdout.write(
      `${JSON.stringify({
        type: "orkestrator-electron-ready",
        profile: runtimeProfile.id,
        electronPid: process.pid,
        backendPid: backendProcess.getPid(),
        authFile: info?.authFile,
        browserUrl: info?.browserUrl,
        invokeUrl: info?.url,
      })}\n`,
    );
  }
}

if (isPrimaryInstance) {
  registerBrowserPreviewWindowActivation({
    onActivate: (listener) => app.on("activate", listener),
    // Startup owns its first window. A quit-time reopen must be handled even
    // while a window exists or another activation is creating one.
    handleActivate: () => quitReopen.deferReopenWhileQuitting() || !startupComplete,
    getWindowCount: () => BrowserWindow.getAllWindows().length,
    createWindow,
    onCreateError: (error) =>
      desktopLog.error("window.recreate-failed", { error: formatLogError(error) }),
  });
  // Registered first: a launch during quit relaunches instead of reaching
  // windows that are closing or bound to the stopped Local backend.
  app.on("second-instance", () => {
    quitReopen.deferReopenWhileQuitting();
  });
  registerSecondInstanceFocus(
    app,
    () => (quitReopen.isQuitting() ? null : (focusedContext()?.window ?? null)),
    () => {
      if (quitReopen.isQuitting() || !windowRequestGate.request()) return;
      void createWindow().catch((error) =>
        desktopLog.error("window.second-launch-failed", { error: formatLogError(error) }),
      );
    },
  );

  void app
    .whenReady()
    .then(startApplication)
    .catch((error: unknown) => {
      handleStartupFailure({
        isQuitting: quitReopen.isQuitting,
        recover: () =>
          runtimeFlavor !== "agent-test" &&
          recoverRemoteBackendFailure(app.getPath("userData"), relaunchingApp),
        error,
        report: createStartupFailureReporter({
          agentTest: runtimeFlavor === "agent-test",
          productName,
          dialogs: nativeDialogs,
        }),
        quit: () => app.quit(),
      });
    });
} else {
  desktopLog.warn("instance.already-running", {
    product: productName,
    dataDir: app.getPath("userData"),
  });
}

const backendShutdown = registerBackendShutdown(app, backendProcess);
// The loopback handoff page only exists while a sign-in is pending.
app.on("will-quit", () => {
  void previewExternalHandoff.close().catch(() => undefined);
});
// The backend's drain is logged through this process: flush after it.
registerApplicationLoggingShutdown(app, applicationLogging, undefined, {
  settled: backendShutdown.stopped,
  timeoutMs: BACKEND_EXIT_WAIT_MS,
});
if (essentialLog) {
  registerWillQuitHold(
    app,
    async () => {
      await backendShutdown.stopped().catch(() => undefined);
      await essentialLog.stop();
    },
    BACKEND_EXIT_WAIT_MS + ESSENTIAL_LOG_STOP_WAIT_MS,
  );
}
