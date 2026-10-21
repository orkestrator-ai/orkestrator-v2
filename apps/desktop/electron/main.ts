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
} from "electron";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LOCAL_CONNECTION_ID } from "@orkestrator/protocol/connections";
import { BackendProcess, type BackendHttpClient } from "./backend-process.js";
import { prepareAppImageInstall, registerBackendShutdown } from "./backend-lifecycle.js";
import {
  LINUX_DESKTOP_ENTRY_FILENAME,
  PRODUCT_NAME,
  userDataDirectoryName,
} from "./app-constants.js";
import { registerMainIpc } from "./ipc.js";
import { resolveRuntimeRoots } from "./paths.js";
import {
  createMainWindow,
  installRendererNavigationGuards,
  trustedRendererUrlFor,
} from "./window.js";
import { ConnectionManager, DEFAULT_CONNECTION_SCOPE } from "./connection-manager.js";
import {
  LocalBackendCatalogueStore,
  NativeDeviceCatalogueStore,
} from "./connection-catalogue-store.js";
import { registerFederationIpc } from "./federation-ipc.js";
import { BackendPanelViews, type PanelRecord } from "./backend-panel-views.js";
import { SshPromptBroker } from "./ssh-prompt-broker.js";
import { createSshAdapterContext, SshTunnelSupervisor } from "./ssh/index.js";
import { createUnavailableLocalBackend } from "./unavailable-local-backend.js";
import { installRemoteGatewayRequestAuth } from "./remote-gateway-request-auth.js";
import { ensurePinnedToolchains } from "@orkestrator/toolchain/manager";
import { pinnedArtifactsForPlatforms } from "@orkestrator/toolchain/manifest";
import {
  chooseAgentPlatforms,
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
import { PreviewTransportManager } from "./preview-transport-manager.js";
import { createPreviewPortHints } from "./preview-port-hints.js";
import { PreviewExternalHandoff } from "./preview-external-handoff.js";
import type { PreviewAttachmentDescriptor } from "@orkestrator/protocol/preview-access";
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
import { claimSingleInstanceLock, registerSecondInstanceFocus } from "./single-instance.js";
import {
  handleStartupFailure,
  registerQuitReopenRelaunch,
  registerWindowAllClosedQuit,
} from "./quit-policy.js";
import { createApplicationMenuTemplate } from "./application-menu.js";
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
import {
  applyWindowTitle,
  focusWindowById,
  projectMenuWindows,
  resolveFocusedWindowContext,
} from "./window-menu.js";
import { chromiumSwitchesForRuntime, runtimeProfileFromEnvironment } from "./runtime-profile.js";
import {
  installProductionApplicationLogging,
  registerApplicationLoggingShutdown,
} from "./application-logging.js";
import {
  browserPreviewPartitionForWindow,
  browserPreviewServicePartition,
  cleanupFailedDesktopWindow,
  DesktopWindowRequestGate,
  DesktopWindowSlotAllocator,
  releaseBoundWindowIfQuitting,
  rendererPartitionForPanel,
  rendererPartitionForWindow,
} from "./desktop-window-lifecycle.js";
import {
  createSerializedMacOsPermissionProbe,
  peekPersistedActiveConnectionId,
  probeMacOsPermissions,
  shouldProbeMacOsPermissionsBeforeBackend,
} from "./macos-permissions.js";
import { createClipboardTextWriter } from "./clipboard.js";
import { ArtifactHostManager } from "./artifact-host-manager.js";
import { ARTIFACT_SHELL_SCHEME_PRIVILEGES } from "./artifact-host-shell.js";
import { ARTIFACT_HOST_CHANNELS } from "@orkestrator/protocol/artifact-host-ipc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.ELECTRON_DEV === "1";
// Menu items copy synchronously; Electron 44's writeText returns a Promise whose
// rejection would otherwise be unhandled and terminate the main process.
const writeClipboardText = createClipboardTextWriter(clipboard, (message, error) =>
  console.error(message, error),
);
const runtimeProfile = runtimeProfileFromEnvironment();
const runtimeFlavor = runtimeProfile?.flavor ?? (isDev ? "development" : "production");
const productName = runtimeProfile?.electronTitle ?? PRODUCT_NAME;

app.setName(productName);
for (const name of chromiumSwitchesForRuntime(runtimeFlavor, process.platform)) {
  app.commandLine.appendSwitch(name);
}
if (process.platform === "linux") app.setDesktopName(LINUX_DESKTOP_ENTRY_FILENAME);
app.setPath(
  "userData",
  runtimeProfile?.dataDir ?? path.join(app.getPath("appData"), userDataDirectoryName(isDev)),
);
// The live artifact host's trusted viewer shell needs a tuple origin (so the
// content server's frame-ancestors can name it). Must precede `ready`; the
// scheme is only ever handled on each live host's private session.
protocol.registerSchemesAsPrivileged([ARTIFACT_SHELL_SCHEME_PRIVILEGES]);
const applicationLogging =
  runtimeFlavor === "production"
    ? installProductionApplicationLogging({ dataDir: app.getPath("userData") })
    : null;

// Must follow the `userData` override above: the lock is scoped to that path.
const isPrimaryInstance = claimSingleInstanceLock(app);

let backend: BackendHttpClient | null = null;
let connectionManager: ConnectionManager | null = null;
let panelViews: BackendPanelViews | null = null;
/** Backend-scoped panel views, keyed by their own webContents ID. */
const panelContexts = new Map<number, PanelRecord>();
let sshPrompts: SshPromptBroker | null = null;
let connectionListPublish: ReturnType<typeof setTimeout> | null = null;
type DesktopWindowContext = {
  window: BrowserWindow;
  scope: string;
  slot: number;
  browserPreviewManager: BrowserPreviewManager;
  previewTransport: PreviewTransportManager;
  artifactHosts: ArtifactHostManager;
};
let previewPortHints: ReturnType<typeof createPreviewPortHints> | null = null;
let browserPreviewCaptures: BrowserPreviewCaptureStore | null = null;
const previewExternalHandoff = new PreviewExternalHandoff((url) => shell.openExternal(url));
const windowContexts = new Map<number, DesktopWindowContext>();
const MAX_DESKTOP_WINDOWS = 32;
const windowSlots = new DesktopWindowSlotAllocator(MAX_DESKTOP_WINDOWS);
const windowRequestGate = new DesktopWindowRequestGate();
let legacyRendererSessionClaimed = false;
let lastFocusedWindowId: number | null = null;
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
const quitReopen = registerQuitReopenRelaunch({
  app,
  allowRelaunch: runtimeFlavor !== "agent-test",
});
let startupComplete = false;
let autoUpdate: AutoUpdateController | null = null;
let hostUpdates: HostUpdateExecutor | null = null;
const toolchainProgress = createToolchainProgressController({
  createWindow: () =>
    createToolchainBootstrapWindow({
      BrowserWindowCtor: BrowserWindow,
      dirname: __dirname,
    }),
  reportProgress: (window, progress) => reportToolchainProgress(window as BrowserWindow, progress),
  onUnexpectedClose: () => app.quit(),
  logError: (error) => console.error("[Toolchains] Failed to show bootstrap progress:", error),
});

function emitToWindow(window: BrowserWindow, event: string, payload: unknown): void {
  if (!window.isDestroyed()) window.webContents.send("orkestrator:event", event, payload);
}

function focusedContext(): DesktopWindowContext | null {
  return resolveFocusedWindowContext(
    windowContexts,
    BrowserWindow.getFocusedWindow(),
    lastFocusedWindowId,
  );
}

function contextForEvent(event?: { sender?: { id: number } }): DesktopWindowContext {
  const context = event?.sender ? windowContexts.get(event.sender.id) : null;
  if (!context) throw new Error("The requesting window is no longer available");
  return context;
}

/**
 * IPC context of a requesting renderer: a main window, or a backend-scoped
 * panel inside one. Panels have no native previews or artifact hosts of
 * their own in this release; those features fall back to their non-native
 * presentations there.
 */
type IpcContext = {
  window: BrowserWindow;
  scope: string;
  browserPreviewManager: BrowserPreviewManager | null;
  artifactHosts: ArtifactHostManager | null;
  panel: PanelRecord | null;
};

function ipcContextForEvent(event?: { sender?: { id: number } }): IpcContext {
  const senderId = event?.sender?.id;
  const windowContext = senderId === undefined ? undefined : windowContexts.get(senderId);
  if (windowContext) {
    return {
      window: windowContext.window,
      scope: windowContext.scope,
      browserPreviewManager: windowContext.browserPreviewManager,
      artifactHosts: windowContext.artifactHosts,
      panel: null,
    };
  }
  const panel = senderId === undefined ? undefined : panelContexts.get(senderId);
  const parent = panel ? windowContexts.get(panel.parentWebContentsId) : undefined;
  if (!panel || !parent) throw new Error("The requesting window is no longer available");
  return {
    window: parent.window,
    scope: panel.scope,
    browserPreviewManager: null,
    artifactHosts: null,
    panel,
  };
}

function emitToWebContents(
  webContents: { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void },
  event: string,
  payload: unknown,
): void {
  if (!webContents.isDestroyed()) webContents.send("orkestrator:event", event, payload);
}

function emitToConnection(connectionId: string, event: string, payload: unknown): void {
  if (!connectionManager) return;
  for (const context of windowContexts.values()) {
    if (connectionManager.getConnectionId(context.scope) === connectionId) {
      emitToWindow(context.window, event, payload);
    }
  }
  for (const panel of panelContexts.values()) {
    if (panel.connectionId === connectionId) {
      emitToWebContents(panel.webContents as never, event, payload);
    }
  }
}

/** Events of a machine a window observes for its federated views. */
function emitObservedEvent(
  connectionId: string,
  epoch: number,
  event: string,
  payload: unknown,
  scopes: readonly string[],
): void {
  for (const context of windowContexts.values()) {
    if (!scopes.includes(context.scope) || context.window.isDestroyed()) continue;
    context.window.webContents.send(
      "orkestrator:backend-event",
      connectionId,
      epoch,
      event,
      payload,
    );
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
  lastFocusedWindowId = id;
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
      for (const context of windowContexts.values()) {
        emitToWindow(context.window, BROWSER_PREVIEW_CAPTURE_EVENT, event);
      }
    },
  });
  store.ready.catch(() => {
    console.warn("[BrowserPreview] Pending capture spool could not be loaded");
  });
  store.startExpirySweep();
  browserPreviewCaptures = store;
  return store;
}

function createWindowBrowserPreviews(
  createdWindow: BrowserWindow,
  scope: string,
  slot: number,
  connectionId: string,
) {
  const partition = browserPreviewPartitionForWindow(slot, connectionId);
  let manager: BrowserPreviewManager | null = null;
  previewPortHints ??= createPreviewPortHints(
    path.join(app.getPath("userData"), "preview-ports.json"),
  );
  // Service previews: a loopback ingress per service over the authenticated
  // tunnel of *this window's* connection. Never borrows another window's backend.
  const previewTransport = new PreviewTransportManager({
    invoke: <T>(command: string, args: Record<string, unknown>) => {
      if (!connectionManager) throw new Error("Connections are not initialized");
      return connectionManager.invoke<T>(command, args, scope);
    },
    tunnelUrl: () => connectionManager?.getPreviewTunnelUrl(scope) ?? null,
    isRemote: () => connectionManager?.getConnectionId(scope) !== LOCAL_CONNECTION_ID,
    partitionFor: (target) => browserPreviewServicePartition(slot, connectionId, target),
    sessionFor: (partitionName) => session.fromPartition(partitionName),
    clientKey: createHash("sha256").update(scope).digest("hex").slice(0, 24),
    portHints: previewPortHints,
    onStateChange: (serviceKey) => manager?.refreshService(serviceKey),
    logger: console,
  });
  const transport: BrowserPreviewServiceTransport = {
    acquire: (target, holderId) => previewTransport.acquire(target, holderId),
    release: (serviceKey, holderId) => previewTransport.release(serviceKey, holderId),
    scopeFor: (url) => previewTransport.scopeFor(url),
    describe: (url) => previewTransport.describe(url),
    target: (serviceKey) => previewTransport.target(serviceKey),
    transportState: (serviceKey) => previewTransport.transportState(serviceKey),
    resetSiteData: (target) => previewTransport.resetSiteData(target),
    sessionFor: (partitionName) =>
      configurePreviewServiceSession(session.fromPartition(partitionName), () => manager),
  };
  const emitToOwner = (event: string, payload: unknown) =>
    emitToWindow(createdWindow, event, payload);
  const browserPreviewMainAdapters = createBrowserPreviewMainAdapters({
    emitToRenderers: emitToOwner,
    openExternal: (url) => shell.openExternal(url),
    writeClipboardText,
    logError: (message, error) => console.error(message, error),
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
    getAuthorization: (url) =>
      connectionManager?.getRendererRequestAuthorization(url, scope) ?? null,
    transport,
    captureStore: browserPreviewCaptureStore(),
    nativeImage,
    // External browsers never inherit Electron's request hooks: they sign in
    // through the private preview origin with a one-use grant POSTed by a
    // loopback handoff page. The grant is never part of a URL.
    openServiceExternally: async (target) => {
      if (!connectionManager) throw new Error("Connections are not initialized");
      const attachment = await connectionManager.invoke<PreviewAttachmentDescriptor>(
        "create_preview_attachment",
        {
          serviceId: target.serviceId,
          surface: "browser-top-level",
          path: target.path,
          clientKey: createHash("sha256").update(scope).digest("hex").slice(0, 24),
        },
        scope,
      );
      if (attachment.backendInstanceId !== target.backendInstanceId || !attachment.bootstrap) {
        throw new Error("This backend cannot publish the preview to an external browser.");
      }
      await previewExternalHandoff.open(attachment.attachmentId, attachment.bootstrap);
    },
  });
  manager = runtime.manager;
  return { ...runtime, previewTransport };
}

/**
 * One live interactive-artifact host per window, on its own sandboxed view
 * and fresh nonpersistent session. Events go to this window's renderer only.
 * A renderer reload leaves the host without an owner, so it is closed.
 */
function createWindowArtifactHosts(createdWindow: BrowserWindow): ArtifactHostManager {
  const artifactHosts = new ArtifactHostManager({
    getWindow: () => createdWindow,
    WebContentsViewCtor: WebContentsView,
    fromPartition: (partition) => session.fromPartition(partition, { cache: false }),
    emit: (event) => {
      if (!createdWindow.isDestroyed()) {
        createdWindow.webContents.send(ARTIFACT_HOST_CHANNELS.event, event);
      }
    },
    // Content-free reason counters only; never URLs or page data.
    reportDiagnostics: (diagnostics) => console.info("[ArtifactHost] host ended", diagnostics),
  });
  createdWindow.webContents.on("did-navigate", () => artifactHosts.closeAll("window-closed"));
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
      showMessageBox: (window, options) =>
        window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options),
      onCheckResult: (report) => hostUpdates?.reportCheck(report),
      ...(process.platform === "linux"
        ? { prepareForInstall: () => prepareAppImageInstall(app, backendProcess) }
        : {}),
    });
    autoUpdate.start();
    createMenu();
    startHostUpdates(autoUpdate);
  } catch (error) {
    console.error("[Updater] Auto-update is unavailable:", error);
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
        window: focusedContext()?.window ?? BrowserWindow.getAllWindows()[0] ?? null,
        showMessageBox: (window, options) =>
          dialog.showMessageBox(window as BrowserWindow, options),
        notify: (title, body) => {
          if (Notification.isSupported()) new Notification({ title, body }).show();
        },
      });
    },
  });
  void hostUpdates.start().catch((error: unknown) => {
    console.error("[Updater] Remote updates are unavailable:", error);
  });
}

function createMenu(): void {
  const template = createApplicationMenuTemplate({
    productName,
    windows: menuWindowList(),
    newWindow: () => {
      void createWindow().catch((error) =>
        console.error("[Desktop] Failed to create a new window:", error),
      );
    },
    closeTab: () => emitToFocusedWindow("menu-close-tab", undefined),
    selectWindow: (id) => focusDesktopWindow(id),
    zoom: (direction) => emitToFocusedWindow("menu-zoom", direction),
    checkForUpdates: autoUpdate ? () => void autoUpdate?.checkNow() : undefined,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(connectionId?: string): Promise<void> {
  if (!connectionManager) throw new Error("Connections are not initialized");
  if (quitReopen.isQuitting()) throw new Error(`${productName} is quitting`);
  const currentContext = focusedContext();
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
  let registered = false;
  const allocation: { window: BrowserWindow | null } = { window: null };
  try {
    await createMainWindow({
      BrowserWindowCtor: BrowserWindow,
      menu: Menu,
      writeClipboardText,
      dirname: __dirname,
      isDev,
      appPath: app.getAppPath(),
      rendererRoot: isDev ? undefined : path.join(process.resourcesPath, "web"),
      devServerUrl: process.env.VITE_DEV_SERVER_URL,
      title: `${productName} — ${activeConnection?.name ?? "Local"}`,
      partition: rendererPartitionForWindow(slot, activeConnectionId, useLegacyDefaultSession),
      beforeLoad: (createdWindow) => {
        allocation.window = createdWindow;
        const emitToOwner = (event: string, payload: unknown) =>
          emitToWindow(createdWindow, event, payload);
        installRemoteGatewayRequestAuth(
          createdWindow.webContents.session.webRequest,
          (url) => connectionManager?.getRendererRequestAuthorization(url, scope) ?? null,
        );
        const browserPreviewRuntime = createWindowBrowserPreviews(
          createdWindow,
          scope,
          slot,
          activeConnectionId,
        );
        const artifactHosts = createWindowArtifactHosts(createdWindow);
        const webContentsId = createdWindow.webContents.id;
        windowContexts.set(webContentsId, {
          window: createdWindow,
          scope,
          slot,
          browserPreviewManager: browserPreviewRuntime.manager,
          previewTransport: browserPreviewRuntime.previewTransport,
          artifactHosts,
        });
        lastFocusedWindowId = webContentsId;
        registered = true;
        createMenu();
        createdWindow.on("page-title-updated", (event) => {
          event.preventDefault();
          setConnectionTitle(createdWindow, scope);
        });
        // A reloaded parent no longer knows about its panels or prompts.
        createdWindow.webContents.on("did-navigate", () => {
          panelViews?.closeAllFor(webContentsId);
          sshPrompts?.cancelFor(webContentsId);
        });
        createdWindow.webContents.on("did-finish-load", () => {
          // A new window can join an already-open pooled event stream and
          // therefore miss its transport-level connected frame. Force the
          // same authoritative reconciliation after every document load.
          emitToOwner("native-event-stream-connected", undefined);
        });
        createdWindow.on("focus", () => {
          lastFocusedWindowId = webContentsId;
          createMenu();
        });
        createdWindow.once("closed", () => {
          const closing = windowContexts.get(webContentsId);
          closing?.browserPreviewManager.destroyAll();
          closing?.artifactHosts.dispose();
          // Owned local listeners and tunnel connections end with the window;
          // the backend's services and applications keep running.
          void closing?.previewTransport.disposeAll().catch((error: unknown) => {
            console.warn("[Previews] Failed to close preview transport:", error);
          });
          panelViews?.closeAllFor(webContentsId);
          sshPrompts?.cancelFor(webContentsId);
          windowContexts.delete(webContentsId);
          connectionManager?.release(scope);
          windowSlots.release(slot);
          if (lastFocusedWindowId === webContentsId) {
            lastFocusedWindowId = windowContexts.keys().next().value ?? null;
          }
          createMenu();
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
  for (const panel of panelContexts.values()) {
    try {
      emitToWebContents(
        panel.webContents as never,
        "desktop-connections-changed",
        connectionManager.getList(panel.scope),
      );
    } catch {
      // A panel still binding its machine receives its list once bound.
    }
  }
}

function registerIpc(): void {
  const manager = () => {
    if (!connectionManager) throw new Error("Connections are not initialized");
    return connectionManager;
  };
  const scopeForEvent = (event?: { sender?: { id: number } }) => ipcContextForEvent(event).scope;
  const updateWindowTitle = (event: { sender?: { id: number } } | undefined) => {
    const senderId = event?.sender?.id;
    const context = senderId === undefined ? undefined : windowContexts.get(senderId);
    if (context) setConnectionTitle(context.window, context.scope);
  };
  registerMainIpc({
    getBackend: (event) => {
      const scope = scopeForEvent(event);
      return { invoke: (command, args) => manager().invoke(command, args, scope) };
    },
    getMainWindow: (event) => ipcContextForEvent(event).window,
    getArtifactHosts: (event) => ipcContextForEvent(event).artifactHosts,
    ipc: ipcMain,
    clipboardApi: clipboard,
    createClipboardItem: (items) => new ClipboardItem(items),
    shellApi: shell,
    appApi: {
      exit: (code) => app.exit(code),
      quit: () => app.quit(),
      relaunch: () => quitReopen.scheduleRelaunch(),
    },
    nativeImageApi: nativeImage,
    getMacOsPermissions,
    listConnections: (event) => manager().getList(scopeForEvent(event)),
    probeConnection: (connectionId) => {
      return manager().probe(connectionId);
    },
    connectToRemote: async (input, event) => {
      const list = await manager().connect(input, scopeForEvent(event));
      refreshConnectionTitles();
      publishConnectionLists();
      return list;
    },
    updateConnectionToken: async (connectionId, token, event) => {
      const list = await manager().updateToken(connectionId, token, scopeForEvent(event));
      publishConnectionLists();
      return list;
    },
    renameConnection: async (connectionId, nickname, event) => {
      try {
        return await manager().rename(connectionId, nickname, scopeForEvent(event));
      } finally {
        // A durable rename survives the requesting window closing during its save.
        refreshConnectionTitles();
        publishConnectionLists();
      }
    },
    useConnection: async (connectionId, event) => {
      if (ipcContextForEvent(event).panel) {
        throw new Error("A machine panel stays bound to its machine. Open another panel instead.");
      }
      const context = contextForEvent(event);
      const nextPreviewRuntime = createWindowBrowserPreviews(
        context.window,
        context.scope,
        context.slot,
        connectionId,
      );
      let list: ReturnType<ConnectionManager["getList"]>;
      try {
        list = await manager().use(connectionId, context.scope);
      } catch (error) {
        nextPreviewRuntime.manager.destroyAll();
        void nextPreviewRuntime.previewTransport.disposeAll().catch(() => undefined);
        throw error;
      }
      context.browserPreviewManager.destroyAll();
      // A connection change cancels transport owned for the previous backend.
      void context.previewTransport.disposeAll().catch((error: unknown) => {
        console.warn("[Previews] Failed to close preview transport:", error);
      });
      context.browserPreviewManager = nextPreviewRuntime.manager;
      context.previewTransport = nextPreviewRuntime.previewTransport;
      updateWindowTitle(event);
      publishConnectionLists();
      return list;
    },
    forgetConnection: async (connectionId, event) => {
      const list = await manager().forget(connectionId, scopeForEvent(event));
      updateWindowTitle(event);
      publishConnectionLists();
      return list;
    },
    openConnectionWindow: async (connectionId) => createWindow(connectionId),
    getBrowserPreviews: (event) => ipcContextForEvent(event).browserPreviewManager,
    trustedRendererUrl: isDev
      ? (process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:1420")
      : pathToFileURL(path.join(process.resourcesPath, "web", "index.html")).href,
    getWebClientStatus: (event) => manager().getWebClientStatus(scopeForEvent(event)),
    setWebClientEnabled: (enabled, event) =>
      manager().setWebClientEnabled(enabled, scopeForEvent(event)),
    resetWebClientServe: (event) => manager().resetWebClientServe(scopeForEvent(event)),
    getGatewayTokenSettings: (event) => manager().getTokenSettings(scopeForEvent(event)),
    setGatewayToken: (token, event) => manager().setToken(token, scopeForEvent(event)),
  });
  const ownerWindow = (event: { sender?: { id: number } }) => {
    const senderId = event.sender?.id;
    const context = senderId === undefined ? undefined : windowContexts.get(senderId);
    if (!context) throw new Error("Only a main window can manage machine panels.");
    return { context, senderId: senderId! };
  };
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
    invokeOn: (event, connectionId, command, args) =>
      manager().invokeOn(scopeForEvent(event), connectionId, command, args),
    observe: (event, connectionId) => manager().observe(scopeForEvent(event), connectionId),
    unobserve: (event, connectionId) => manager().unobserve(scopeForEvent(event), connectionId),
    gatewaySnapshot: (event) => {
      const context = ipcContextForEvent(event);
      const identity = manager().getBackendIdentity(context.scope);
      return {
        baseUrl: manager().getGatewayBaseUrl(context.scope),
        connectionId: identity.connectionId,
        backendId: identity.backendId,
        legacyOrigin: identity.legacyOrigin,
        panel: context.panel !== null,
      };
    },
    connectSsh: async (event, input) =>
      afterCatalogueChange(await manager().connectSsh(input, scopeForEvent(event))),
    probeSshHostKey: (_event, input) => manager().probeSshHostKey(input),
    trustSshHostKey: (_event, probeId) => manager().trustSshHostKey(probeId),
    removeRoute: async (event, connectionId, routeId) =>
      afterCatalogueChange(
        await manager().removeRoute(connectionId, routeId, scopeForEvent(event)),
      ),
    setRouteOrder: async (event, connectionId, routeIds) =>
      afterCatalogueChange(
        await manager().setRouteOrder(connectionId, routeIds, scopeForEvent(event)),
      ),
    setRouteEnabled: async (event, connectionId, routeId, enabled) =>
      afterCatalogueChange(
        await manager().setRouteEnabled(connectionId, routeId, enabled, scopeForEvent(event)),
      ),
    useRoute: async (event, connectionId, routeId) =>
      afterCatalogueChange(await manager().useRoute(connectionId, routeId, scopeForEvent(event))),
    setAutoConnect: async (event, connectionId, autoConnect) =>
      afterCatalogueChange(
        await manager().setAutoConnect(connectionId, autoConnect, scopeForEvent(event)),
      ),
    setFeatures: async (event, features) =>
      afterCatalogueChange(await manager().setFeatures(features, scopeForEvent(event))),
    openPanel: async (event, input) => {
      const { context } = ownerWindow(event);
      if (!panelViews) throw new Error("Machine panels are not available.");
      return panelViews.open(context.window as never, input);
    },
    setPanelBounds: (event, panelId, bounds) =>
      panelViews?.setBounds(ownerWindow(event).senderId, panelId, bounds),
    setPanelVisible: (event, panelId, visible) =>
      panelViews?.setVisible(ownerWindow(event).senderId, panelId, visible),
    closePanel: (event, panelId) => panelViews?.close(ownerWindow(event).senderId, panelId),
  });
}

function rendererUrl(): string {
  return trustedRendererUrlFor({
    isDev,
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
    rendererIndexPath: path.join(process.resourcesPath, "web", "index.html"),
  });
}

function createPanelViews(): BackendPanelViews {
  return new BackendPanelViews({
    WebContentsViewCtor: WebContentsView as never,
    preloadPath: path.join(__dirname, "preload.js"),
    rendererUrl: rendererUrl(),
    partitionFor: (connectionId) => rendererPartitionForPanel(connectionId),
    bindScope: async (scope, connectionId) => {
      if (!connectionManager) throw new Error("Connections are not initialized");
      await connectionManager.bind(scope, connectionId);
    },
    releaseScope: (scope) => connectionManager?.release(scope),
    installRequestAuth: (webContents, scope) =>
      installRemoteGatewayRequestAuth(
        webContents.session.webRequest as never,
        (url) => connectionManager?.getRendererRequestAuthorization(url, scope) ?? null,
      ),
    installNavigationGuards: (webContents) =>
      installRendererNavigationGuards(webContents as never, rendererUrl()),
    register: (panel) => {
      panelContexts.set(panel.webContents.id, panel);
      panel.webContents.on("did-finish-load", () => {
        emitToWebContents(panel.webContents as never, "native-event-stream-connected", undefined);
      });
    },
    unregister: (webContentsId) => {
      panelContexts.delete(webContentsId);
    },
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
    ? await chooseAgentPlatforms({ BrowserWindowCtor: BrowserWindow, dirname: __dirname })
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
    console.info(`[Updater] Relaunched to install ${remoteRelaunch.version} for a remote request`);
  }
  const toolchainBinDir = await preparePinnedToolchains({
    dataDir,
    ensure: ensurePinnedToolchains,
    // Since Electron 44 a server requesting a client certificate makes net
    // requests auto-select a matching one (select-client-certificate is not
    // handled). Toolchain hosts do not request one, so this is left as is.
    fetchImpl: (input, init) => net.fetch(input, init),
    onProgress: (progress) => toolchainProgress.report(progress),
    showMessageBox: (options) => dialog.showMessageBox(options),
    quit: () => app.quit(),
    logError: (error) => console.error("[Toolchains] Failed to prepare pinned tools:", error),
    artifacts,
    // Nobody is watching an agent-driven `dev:test` run, so a modal asking
    // whether to retry would hang the launcher instead of failing it: the
    // profile never reaches ready, never exits, and the cause stays trapped in a
    // dialog rather than in the log directory dev:status points at.
    interactive: !isAgentTest,
    ...(remoteRelaunch ? { unattendedRetries: { attempts: 10, delayMs: 30_000 } } : {}),
  });
  if (!toolchainBinDir) return;
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
      BrowserWindowCtor: BrowserWindow,
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
      appVersion: app.getVersion(),
      dataDir,
      appRoot,
      resourceRoot,
      toolchainBinDir,
      rendererDevServerUrl: isDev ? process.env.VITE_DEV_SERVER_URL : undefined,
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
      onEvent: (event, payload) => {
        hostUpdates?.handleEvent(event, payload);
        if (connectionManager) connectionManager.handleLocalEvent(event, payload);
      },
      onUnexpectedExit: (error) => {
        connectionManager?.markLocalBackendUnavailable();
        emitToConnection("local", "local-backend-unavailable", { message: error.message });
        publishConnectionLists();
        // Shortly after a remote-requested update, relaunch instead of a modal
        // nobody may answer, so the remote client gets its backend back.
        if (recoverRemoteBackendFailure(dataDir, app)) {
          console.error(
            `[Desktop] Local backend exited after an update; applying unattended recovery: ${error.message}`,
          );
          return;
        }
        dialog.showErrorBox(
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
    console.error("[Desktop] Local backend failed to start; continuing with remote machines.");
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
    onConnectionEvent: emitToConnection,
    onObservedEvent: emitObservedEvent,
    onStateChange: scheduleConnectionListPublish,
  });
  await connectionManager.initialize();
  if (backend) await backend.invoke("get_config");
  panelViews = createPanelViews();
  app.on("will-quit", () => connectionManager?.dispose());

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
    dialog.showErrorBox(
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
    onCreateError: (error) => console.error("[Desktop] Failed to recreate the main window:", error),
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
        console.error("[Desktop] Failed to create a window for a second launch:", error),
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
          recoverRemoteBackendFailure(app.getPath("userData"), app),
        error,
        report: (failure) => {
          console.error("[Desktop] Startup failed:", failure);
          dialog.showErrorBox(
            `${productName} failed to start`,
            failure instanceof Error ? failure.message : String(failure),
          );
        },
        quit: () => app.quit(),
      });
    });
} else {
  console.error(
    `[Desktop] Another ${productName} instance is already using ${app.getPath("userData")}. Quit it and try again.`,
  );
}

registerBackendShutdown(app, backendProcess);
// The loopback handoff page only exists while a sign-in is pending.
app.on("will-quit", () => {
  void previewExternalHandoff.close().catch(() => undefined);
});
registerApplicationLoggingShutdown(app, applicationLogging);
