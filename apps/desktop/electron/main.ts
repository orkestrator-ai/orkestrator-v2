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
import { installDefaultContextMenu } from "./context-menu.js";
import {
  realmChildViewClass,
  WorkspaceViews,
  type WorkspaceViewRecord,
} from "./workspace-views.js";
import { NodeWorkspaceScopes } from "./node-workspaces.js";
import { editDesktopConnection, setDesktopWorkspaceTarget } from "./window-workspace-target.js";
import { importSavedMachinesOnce } from "./command-node-migration.js";
import { ConnectionManager, DEFAULT_CONNECTION_SCOPE } from "./connection-manager.js";
import {
  LocalBackendCatalogueStore,
  NativeDeviceCatalogueStore,
} from "./connection-catalogue-store.js";
import { PORTAL_EVENT_CHANNEL, registerFederationIpc } from "./federation-ipc.js";
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
import { connectionPreviewBackend, rebindWindowPreviews } from "./preview-connection-backend.js";
import { PreviewTransportManager } from "./preview-transport-manager.js";
import { createPreviewPortHints } from "./preview-port-hints.js";
import {
  PreviewPartitionRetention,
  previewPartitionsInUse,
} from "./preview-partition-retention.js";
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
  connectionPartitionKey,
  DesktopWindowRequestGate,
  DesktopWindowSlotAllocator,
  releaseBoundWindowIfQuitting,
  rendererPartitionForRealm,
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
let nodeWorkspaceScopes: NodeWorkspaceScopes | null = null;
let connectionManager: ConnectionManager | null = null;
let sshPrompts: SshPromptBroker | null = null;
let connectionListPublish: ReturnType<typeof setTimeout> | null = null;
let workspaceViews: WorkspaceViews | null = null;
type DesktopWindowContext = {
  window: BrowserWindow;
  /** The renderer: the window's own, or a workspace realm inside it. */
  contents: Electron.WebContents;
  scope: string;
  slot: number;
  /** The connection the window's current previews were created for. */
  previewConnectionId: string;
  browserPreviewManager: BrowserPreviewManager;
  previewTransport: PreviewTransportManager;
  artifactHosts: ArtifactHostManager;
  /**
   * While the window's workspace is on another node: the scope that keeps
   * the window's own (command node) connection, for the portal channel.
   */
  portalScope: string | null;
  target: WindowWorkspaceTarget | null;
  /** A workspace realm: another node's workspace in a window's central region. */
  realm: { parentWebContentsId: number; viewId: string } | null;
};
type WindowWorkspaceTarget = {
  nodeId: string;
  nodeName: string;
  path: "direct" | "relay";
  routeKind?: "https" | "ssh";
  via?: string;
};

let previewPortHints: ReturnType<typeof createPreviewPortHints> | null = null;
let previewPartitionRetention: PreviewPartitionRetention | null = null;
let browserPreviewCaptures: BrowserPreviewCaptureStore | null = null;
const previewExternalHandoff = new PreviewExternalHandoff((url) => shell.openExternal(url));
const windowContexts = new Map<number, DesktopWindowContext>();
/** Workspace realms, by their own renderer's ID. */
const realmContexts = new Map<number, DesktopWindowContext>();
/** A realm's node binding, from its scope's bind until its context exists. */
const realmBindings = new Map<
  string,
  {
    scope: string;
    portalScope: string | null;
    target: WindowWorkspaceTarget | null;
    window: { isDestroyed(): boolean };
  }
>();

/** Every renderer: main windows and the realms inside them. */
function rendererContexts(): DesktopWindowContext[] {
  return [...windowContexts.values(), ...realmContexts.values()];
}
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

function emitToContents(contents: Electron.WebContents, event: string, payload: unknown): void {
  if (!contents.isDestroyed()) contents.send("orkestrator:event", event, payload);
}

function focusedContext(): DesktopWindowContext | null {
  return resolveFocusedWindowContext(
    windowContexts,
    BrowserWindow.getFocusedWindow(),
    lastFocusedWindowId,
  );
}

/** End a window's previews when its connection changed; see `rebindWindowPreviews`. */
function followWindowConnection(context: DesktopWindowContext): void {
  if (!connectionManager) return;
  rebindWindowPreviews(context, connectionManager.getConnectionId(context.scope), (connectionId) =>
    createWindowBrowserPreviews(
      context.window,
      context.scope,
      context.slot,
      connectionId,
      // A workspace connection is new on every switch; preview site data
      // stays with the node, as it would for a direct connection.
      context.target ? `node:${context.target.nodeId}` : connectionId,
    ),
  );
}

function contextForEvent(event?: { sender?: { id: number } }): DesktopWindowContext {
  const context = event?.sender
    ? (windowContexts.get(event.sender.id) ?? realmContexts.get(event.sender.id))
    : null;
  if (!context) throw new Error("The requesting window is no longer available");
  return context;
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

/** The scope that holds the window's own connection: the command node it was opened on. */
function controlScope(context: DesktopWindowContext): string {
  return context.portalScope ?? context.scope;
}

function emitToConnection(connectionId: string, event: string, payload: unknown): void {
  if (!connectionManager) return;
  for (const context of rendererContexts()) {
    if (connectionManager.getConnectionId(context.scope) === connectionId) {
      emitToContents(context.contents, event, payload);
    }
    // The portal channel of a realm: its window's command node.
    if (
      context.portalScope &&
      connectionManager.getConnectionId(context.portalScope) === connectionId &&
      !context.contents.isDestroyed()
    ) {
      context.contents.send(PORTAL_EVENT_CHANNEL, event, payload);
    }
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

/** The focused renderer of the focused window: one of its realms, or the window's own. */
function emitToFocusedRenderer(event: string, payload: unknown): void {
  const context = focusedContext();
  if (!context) return;
  const realm = Array.from(realmContexts.values()).find(
    (candidate) =>
      candidate.realm?.parentWebContentsId === context.contents.id &&
      !candidate.contents.isDestroyed() &&
      candidate.contents.isFocused(),
  );
  emitToContents((realm ?? context).contents, event, payload);
}

function setConnectionTitle(window: BrowserWindow, scope: string): void {
  const context = windowContexts.get(window.webContents.id);
  if (context?.target) {
    applyWindowTitle(window, productName, context.target.nodeName, createMenu);
    return;
  }
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
      for (const context of rendererContexts()) {
        emitToContents(context.contents, BROWSER_PREVIEW_CAPTURE_EVENT, event);
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

/** Clears preview partitions of removed services and forgotten connections. */
function previewRetention(): PreviewPartitionRetention {
  previewPartitionRetention ??= new PreviewPartitionRetention({
    partitionsDir: path.join(app.getPath("userData"), "Partitions"),
    pendingFile: path.join(app.getPath("userData"), "preview-partitions-pending.json"),
    sessionFor: (partitionName) => session.fromPartition(partitionName),
    inUse: () =>
      previewPartitionsInUse(
        rendererContexts().map((context) => ({
          sharedPartition: browserPreviewPartitionForWindow(
            context.slot,
            context.target ? `node:${context.target.nodeId}` : context.previewConnectionId,
          ),
          transport: context.previewTransport,
        })),
      ),
    logger: console,
  });
  return previewPartitionRetention;
}

/** A realm's native views follow it in its window; see `realmChildViewClass`. */
type RealmViewOwner = { contents: Electron.WebContents; ViewCtor: typeof WebContentsView };

function createWindowBrowserPreviews(
  createdWindow: BrowserWindow,
  scope: string,
  slot: number,
  connectionId: string,
  partitionKey = connectionId,
  realm?: RealmViewOwner,
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
    logger: console,
  });
  previewRetention().schedule(connectionPartitionKey(partitionKey), previewTransport, {
    delayMs: 60_000,
    intervalMs: 30 * 60_000,
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
    emitToContents(realm?.contents ?? createdWindow.webContents, event, payload);
  const browserPreviewMainAdapters = createBrowserPreviewMainAdapters({
    emitToRenderers: emitToOwner,
    openExternal: (url) => shell.openExternal(url),
    writeClipboardText,
    logError: (message, error) => console.error(message, error),
  });
  const runtime = initializeBrowserPreviews({
    fromPartition: (partitionName) => session.fromPartition(partitionName),
    partition,
    WebContentsViewCtor: realm?.ViewCtor ?? WebContentsView,
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
  });
  manager = runtime.manager;
  return { ...runtime, previewTransport };
}

/**
 * One live interactive-artifact host per window, on its own sandboxed view
 * and fresh nonpersistent session. Events go to this window's renderer only.
 * A renderer reload leaves the host without an owner, so it is closed.
 */
function createWindowArtifactHosts(
  createdWindow: BrowserWindow,
  realm?: RealmViewOwner,
): ArtifactHostManager {
  const owner = realm?.contents ?? createdWindow.webContents;
  const artifactHosts = new ArtifactHostManager({
    getWindow: () => createdWindow,
    WebContentsViewCtor: realm?.ViewCtor ?? WebContentsView,
    fromPartition: (partition) => session.fromPartition(partition, { cache: false }),
    emit: (event) => {
      if (!createdWindow.isDestroyed() && !owner.isDestroyed()) {
        owner.send(ARTIFACT_HOST_CHANNELS.event, event);
      }
    },
    // Content-free reason counters only; never URLs or page data.
    reportDiagnostics: (diagnostics) => console.info("[ArtifactHost] host ended", diagnostics),
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
    // A tab belongs to the workspace that has focus, which may be a realm.
    closeTab: () => emitToFocusedRenderer("menu-close-tab", undefined),
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
  // A window on another node's workspace opens new windows on its own
  // (command node) connection, never on the workspace.
  const inheritedConnectionId =
    connectionId ??
    (currentContext
      ? connectionManager.getConnectionId(controlScope(currentContext))
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
          contents: createdWindow.webContents,
          scope,
          slot,
          previewConnectionId: activeConnectionId,
          browserPreviewManager: browserPreviewRuntime.manager,
          previewTransport: browserPreviewRuntime.previewTransport,
          artifactHosts,
          portalScope: null,
          target: null,
          realm: null,
        });
        lastFocusedWindowId = webContentsId;
        registered = true;
        createMenu();
        createdWindow.on("page-title-updated", (event) => {
          event.preventDefault();
          setConnectionTitle(createdWindow, scope);
        });
        // A reloaded window no longer knows about its prompts or realms.
        createdWindow.webContents.on("did-navigate", () => {
          sshPrompts?.cancelFor(webContentsId);
          workspaceViews?.closeAllFor(webContentsId);
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
          workspaceViews?.closeAllFor(webContentsId);
          closing?.browserPreviewManager.destroyAll();
          closing?.artifactHosts.dispose();
          // Owned local listeners and tunnel connections end with the window;
          // the backend's services and applications keep running.
          void closing?.previewTransport.disposeAll().catch((error: unknown) => {
            console.warn("[Previews] Failed to close preview transport:", error);
          });
          sshPrompts?.cancelFor(webContentsId);
          windowContexts.delete(webContentsId);
          // Closing never stops the node's work; it only revokes the grant.
          nodeWorkspaceScopes?.release(scope);
          if (closing?.portalScope) connectionManager?.release(closing.portalScope);
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
        connectionManager.getList(controlScope(context)),
      );
    } catch {
      // A window still binding its connection receives its list once bound.
    }
  }
}

/**
 * Workspace realms: another node's workspace in a window's central region,
 * while the window itself stays on its command node. Each realm's scope is
 * bound to the node's workspace — a short-lived grant the window's command
 * node obtains, directly when one of the node's HTTPS routes answers,
 * otherwise over the command node's own route — renewed while the realm is
 * open and revoked after. Its portal scope keeps the command node, so its
 * invoke, events, request credentials and previews follow the node exactly
 * as for a direct connection, and its multi-node views stay where they are.
 */
function createWorkspaceViews(): WorkspaceViews {
  return new WorkspaceViews({
    WebContentsViewCtor: WebContentsView as never,
    preloadPath: path.join(__dirname, "preload.js"),
    rendererUrl: rendererUrl(),
    partitionFor: (nodeId, parentWebContentsId) =>
      rendererPartitionForRealm(windowContexts.get(parentWebContentsId)?.slot ?? 0, nodeId),
    bindScope: async (scope, nodeId, parentWebContentsId) => {
      const manager = connectionManager;
      if (!manager) throw new Error("Connections are not initialized");
      const parent = windowContexts.get(parentWebContentsId);
      if (!parent) throw new Error("The window is not available");
      const commandScope = controlScope(parent);
      await manager.bind(scope, manager.getConnectionId(commandScope));
      // Each realm renews through its own portal scope; this is only the default.
      nodeWorkspaceScopes ??= new NodeWorkspaceScopes((command, args) =>
        manager.invoke(command, args, commandScope),
      );
      const binding = {
        scope,
        portalScope: null as string | null,
        target: null as WindowWorkspaceTarget | null,
        window: parent.window,
      };
      try {
        await setDesktopWorkspaceTarget(
          binding,
          { nodeId },
          {
            manager,
            scopes: nodeWorkspaceScopes,
            committed: () => undefined,
          },
        );
      } catch (error) {
        manager.release(scope);
        throw error;
      }
      realmBindings.set(scope, binding);
    },
    releaseScope: (scope) => {
      const binding = realmBindings.get(scope);
      realmBindings.delete(scope);
      nodeWorkspaceScopes?.release(scope);
      if (binding?.portalScope) connectionManager?.release(binding.portalScope);
      connectionManager?.release(scope);
    },
    installRequestAuth: (webContents, scope) => {
      installRemoteGatewayRequestAuth(
        (webContents as unknown as Electron.WebContents).session.webRequest,
        (url) => connectionManager?.getRendererRequestAuthorization(url, scope) ?? null,
      );
    },
    installNavigationGuards: (webContents) =>
      installRendererNavigationGuards(webContents as never, rendererUrl()),
    register: (record, parentWindow) => registerRealm(record, parentWindow.webContents.id),
    unregister: (record) => unregisterRealm(record),
  });
}

function registerRealm(record: WorkspaceViewRecord, parentWebContentsId: number): void {
  const parent = windowContexts.get(parentWebContentsId);
  const binding = realmBindings.get(record.scope);
  if (!parent || !binding?.target || !connectionManager) {
    throw new Error("The window is not available");
  }
  const contents = record.webContents as unknown as Electron.WebContents;
  const owner: RealmViewOwner = {
    contents,
    ViewCtor: realmChildViewClass(WebContentsView, record.layout),
  };
  const connectionId = connectionManager.getConnectionId(record.scope);
  // Preview site data stays with the node, as it would for a direct connection.
  const previews = createWindowBrowserPreviews(
    parent.window,
    record.scope,
    parent.slot,
    connectionId,
    `node:${binding.target.nodeId}`,
    owner,
  );
  realmContexts.set(contents.id, {
    window: parent.window,
    contents,
    scope: record.scope,
    slot: parent.slot,
    previewConnectionId: connectionId,
    browserPreviewManager: previews.manager,
    previewTransport: previews.previewTransport,
    artifactHosts: createWindowArtifactHosts(parent.window, owner),
    portalScope: binding.portalScope,
    target: binding.target,
    realm: { parentWebContentsId, viewId: record.viewId },
  });
  installDefaultContextMenu(parent.window, Menu, writeClipboardText, contents);
  contents.on("did-finish-load", () => {
    // As for a window: reconcile after every document load.
    emitToContents(contents, "native-event-stream-connected", undefined);
  });
}

function unregisterRealm(record: WorkspaceViewRecord): void {
  const context = realmContexts.get(record.webContents.id);
  realmContexts.delete(record.webContents.id);
  if (!context) return;
  context.browserPreviewManager.destroyAll();
  context.artifactHosts.dispose();
  // Owned local listeners and tunnel connections end with the realm; the
  // node's services and applications keep running.
  void context.previewTransport.disposeAll().catch((error: unknown) => {
    console.warn("[Previews] Failed to close preview transport:", error);
  });
  sshPrompts?.cancelFor(record.webContents.id);
}

/** A window's command node changed: its realms belonged to the previous one. */
async function closeWindowRealms(context: DesktopWindowContext): Promise<void> {
  workspaceViews?.closeAllFor(context.contents.id);
}

function registerIpc(): void {
  const manager = () => {
    if (!connectionManager) throw new Error("Connections are not initialized");
    return connectionManager;
  };
  const views = () => {
    workspaceViews ??= createWorkspaceViews();
    return workspaceViews;
  };
  // Only a window places and messages realms; a realm never opens another.
  const mainWindowContext = (event: { sender?: { id: number } }) => {
    const context = event.sender ? windowContexts.get(event.sender.id) : undefined;
    if (!context) throw new Error("Only a window can show other machines' workspaces.");
    return context;
  };
  const scopeForEvent = (event?: { sender?: { id: number } }) => ipcContextForEvent(event).scope;
  // A workspace grant cannot administer its node; say where that is done
  // instead of surfacing the node's refusal.
  const machineAdminScope = (event?: { sender?: { id: number } }) => {
    const context = contextForEvent(event);
    if (context.target) {
      throw new Error(
        `${context.target.nodeName}'s web access and gateway token are managed from Settings → Machines on the command node.`,
      );
    }
    return context.scope;
  };
  // Connection management acts on the window's own (command node)
  // connection, even while its workspace is on another node.
  const controlScopeForEvent = (event?: { sender?: { id: number } }) =>
    controlScope(contextForEvent(event));
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
    listConnections: (event) => manager().getList(controlScopeForEvent(event)),
    probeConnection: (connectionId) => {
      return manager().probe(connectionId);
    },
    connectToRemote: async (input, event) => {
      const context = contextForEvent(event);
      const list = await editDesktopConnection(context, { kind: "connect", input }, manager(), () =>
        closeWindowRealms(context),
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
    useConnection: async (connectionId, event) => {
      const context = contextForEvent(event);
      const list = await editDesktopConnection(
        context,
        { kind: "use", connectionId },
        manager(),
        () => closeWindowRealms(context),
      );
      followWindowConnection(context);
      updateWindowTitle(event);
      publishConnectionLists();
      return list;
    },
    forgetConnection: async (connectionId, event) => {
      const context = contextForEvent(event);
      const list = await editDesktopConnection(
        context,
        { kind: "forget", connectionId },
        manager(),
        () => closeWindowRealms(context),
      );
      followWindowConnection(context);
      // Every window has left the connection; its preview site data is unreachable.
      await previewRetention()
        .forgetConnection(connectionPartitionKey(connectionId), {
          includeShared: !Array.from(windowContexts.values()).some(
            (other) => other.previewConnectionId === connectionId,
          ),
        })
        .catch(() => console.warn("[Previews] Failed to record forgotten connection cleanup."));
      updateWindowTitle(event);
      publishConnectionLists();
      return list;
    },
    openConnectionWindow: async (connectionId) => createWindow(connectionId),
    getBrowserPreviews: (event) => ipcContextForEvent(event).browserPreviewManager,
    trustedRendererUrl: isDev
      ? (process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:1420")
      : pathToFileURL(path.join(process.resourcesPath, "web", "index.html")).href,
    getWebClientStatus: (event) => manager().getWebClientStatus(machineAdminScope(event)),
    setWebClientEnabled: (enabled, event) =>
      manager().setWebClientEnabled(enabled, machineAdminScope(event)),
    resetWebClientServe: (event) => manager().resetWebClientServe(machineAdminScope(event)),
    getGatewayTokenSettings: (event) => manager().getTokenSettings(machineAdminScope(event)),
    setGatewayToken: (token, event) => manager().setToken(token, machineAdminScope(event)),
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
      return {
        baseUrl: manager().getGatewayBaseUrl(context.scope),
        connectionId: identity.connectionId,
        backendId: identity.backendId,
        legacyOrigin: identity.legacyOrigin,
        ...(context.target && context.portalScope
          ? {
              workspaceTarget: context.target,
              // Window-level presentation stays with the window's own machine.
              portalIdentity: manager().getBackendIdentity(context.portalScope),
            }
          : {}),
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
    openWorkspaceView: (event, input) => {
      const context = mainWindowContext(event);
      return views().open(context.window, input);
    },
    setWorkspaceViewBounds: (event, viewId, bounds) =>
      views().setBounds(mainWindowContext(event).contents.id, viewId, bounds),
    setWorkspaceViewVisible: (event, viewId, visible) =>
      views().setVisible(mainWindowContext(event).contents.id, viewId, visible),
    captureWorkspaceView: (event, viewId) =>
      views().capture(mainWindowContext(event).contents.id, viewId),
    sendToWorkspaceView: (event, viewId, message) =>
      views().send(mainWindowContext(event).contents.id, viewId, message),
    closeWorkspaceView: (event, viewId) =>
      views().close(mainWindowContext(event).contents.id, viewId),
    postFromWorkspaceRealm: (event, message) => {
      if (!event.sender) throw new Error("Only a workspace realm can message its window.");
      views().post(event.sender.id, message);
    },
    portalInvoke: (event, command, args) =>
      manager().invoke(command, args, controlScopeForEvent(event)),
  });
}

function rendererUrl(): string {
  return trustedRendererUrlFor({
    isDev,
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
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
    onStateChange: scheduleConnectionListPublish,
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
          console.info(
            `[Desktop] Saved machines attached to the local command node: ${result.imported} imported, ${result.skipped} skipped, ${result.needsCredential} need a token`,
          );
        }
      })
      .catch((error: unknown) => {
        console.warn(
          "[Desktop] Saved machines were not imported into the local command node yet:",
          error instanceof Error ? error.name : "unknown",
        );
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
