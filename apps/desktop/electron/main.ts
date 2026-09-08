import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  safeStorage,
  session,
  shell,
  WebContentsView,
} from "electron";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BackendProcess, type BackendHttpClient } from "./backend-process.js";
import { registerBackendShutdown } from "./backend-lifecycle.js";
import {
  LINUX_DESKTOP_ENTRY_FILENAME,
  PRODUCT_NAME,
  userDataDirectoryName,
} from "./app-constants.js";
import { registerMainIpc } from "./ipc.js";
import { resolveRuntimeRoots } from "./paths.js";
import { createMainWindow } from "./window.js";
import { ConnectionManager, DEFAULT_CONNECTION_SCOPE } from "./connection-manager.js";
import { installRemoteGatewayRequestAuth } from "./remote-gateway-request-auth.js";
import { ensurePinnedToolchains } from "./toolchain-manager.js";
import { pinnedArtifactsForPlatforms } from "./toolchain-manifest.js";
import {
  chooseAgentPlatforms,
  createToolchainBootstrapWindow,
  reportToolchainProgress,
} from "./toolchain-bootstrap-window.js";
import { createToolchainProgressController, preparePinnedToolchains } from "./toolchain-startup.js";
import {
  applyAgentTestPlatformSelection,
  loadAgentPlatformSelection,
  saveAgentPlatformSelection,
} from "./agent-platform-selection.js";
import type { BrowserPreviewManager } from "./browser-preview-manager.js";
import {
  createBrowserPreviewAddressFocusHandler,
  initializeBrowserPreviews,
  registerBrowserPreviewWindowActivation,
} from "./browser-preview-startup.js";
import { createBrowserPreviewMainAdapters } from "./browser-preview-main-adapters.js";
import { claimSingleInstanceLock, registerSecondInstanceFocus } from "./single-instance.js";
import { registerWindowAllClosedQuit } from "./quit-policy.js";
import { createApplicationMenuTemplate } from "./application-menu.js";
import { runtimeProfileFromEnvironment } from "./runtime-profile.js";
import {
  installProductionApplicationLogging,
  registerApplicationLoggingShutdown,
} from "./application-logging.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.ELECTRON_DEV === "1";
const runtimeProfile = runtimeProfileFromEnvironment();
const runtimeFlavor = runtimeProfile?.flavor ?? (isDev ? "development" : "production");
const productName = runtimeProfile?.electronTitle ?? PRODUCT_NAME;

app.setName(productName);
if (process.platform === "linux") app.setDesktopName(LINUX_DESKTOP_ENTRY_FILENAME);
app.setPath(
  "userData",
  runtimeProfile?.dataDir ?? path.join(app.getPath("appData"), userDataDirectoryName(isDev)),
);
const applicationLogging =
  runtimeFlavor === "production"
    ? installProductionApplicationLogging({ dataDir: app.getPath("userData") })
    : null;

// Must follow the `userData` override above: the lock is scoped to that path.
const isPrimaryInstance = claimSingleInstanceLock(app);

let backend: BackendHttpClient | null = null;
let connectionManager: ConnectionManager | null = null;
type DesktopWindowContext = {
  window: BrowserWindow;
  scope: string;
  slot: number;
  browserPreviewManager: BrowserPreviewManager;
};
const windowContexts = new Map<number, DesktopWindowContext>();
const usedWindowSlots = new Set<number>();
const MAX_DESKTOP_WINDOWS = 32;
let lastFocusedWindowId: number | null = null;
let pendingNewWindowRequests = 0;
const backendProcess = new BackendProcess();
// Closing a main window may quit; the windowless moments before the first one,
// between programmatic first-run setup handoffs, must not.
const windowAllClosedQuit = registerWindowAllClosedQuit({
  app,
  platform: process.platform,
  alwaysQuit: runtimeFlavor === "agent-test",
});
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
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const focused = focusedWindow ? windowContexts.get(focusedWindow.webContents.id) : null;
  if (focused) return focused;
  return lastFocusedWindowId === null ? null : (windowContexts.get(lastFocusedWindowId) ?? null);
}

function contextForEvent(event?: { sender?: { id: number } }): DesktopWindowContext {
  const context = event?.sender ? windowContexts.get(event.sender.id) : null;
  if (!context) throw new Error("The requesting window is no longer available");
  return context;
}

function emitToConnection(connectionId: string, event: string, payload: unknown): void {
  if (!connectionManager) return;
  for (const context of windowContexts.values()) {
    if (connectionManager.getConnectionId(context.scope) === connectionId) {
      emitToWindow(context.window, event, payload);
    }
  }
}

function emitToFocusedWindow(event: string, payload: unknown): void {
  const context = focusedContext();
  if (context) emitToWindow(context.window, event, payload);
}

function setConnectionTitle(window: BrowserWindow, scope: string): void {
  const list = connectionManager?.getList(scope);
  const active = list?.connections.find((connection) => connection.active);
  window.setTitle(`${productName} — ${active?.name ?? "Local"}`);
}

function allocateWindowSlot(): number {
  for (let slot = 1; slot <= MAX_DESKTOP_WINDOWS; slot += 1) {
    if (usedWindowSlots.has(slot)) continue;
    usedWindowSlots.add(slot);
    return slot;
  }
  throw new Error(`Orkestrator supports up to ${MAX_DESKTOP_WINDOWS} open windows.`);
}

function createMenu(): void {
  const template = createApplicationMenuTemplate({
    productName,
    newWindow: () => {
      void createWindow().catch((error) =>
        console.error("[Desktop] Failed to create a new window:", error),
      );
    },
    closeTab: () => emitToFocusedWindow("menu-close-tab", undefined),
    zoom: (direction) => emitToFocusedWindow("menu-zoom", direction),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(connectionId?: string): Promise<void> {
  if (!connectionManager) throw new Error("Connections are not initialized");
  const currentContext = focusedContext();
  const inheritedConnectionId =
    connectionId ??
    (currentContext
      ? connectionManager.getConnectionId(currentContext.scope)
      : connectionManager.getList().activeConnectionId);
  const scope = randomUUID();
  const slot = allocateWindowSlot();
  let connectionList: ReturnType<ConnectionManager["getList"]>;
  try {
    connectionList = await connectionManager.bind(scope, inheritedConnectionId);
  } catch (error) {
    usedWindowSlots.delete(slot);
    throw error;
  }
  const activeConnection = connectionList.connections.find((connection) => connection.active);
  let registered = false;
  const allocation: { window: BrowserWindow | null } = { window: null };
  try {
    await createMainWindow({
      BrowserWindowCtor: BrowserWindow,
      menu: Menu,
      writeClipboardText: (text) => clipboard.writeText(text),
      dirname: __dirname,
      isDev,
      appPath: app.getAppPath(),
      rendererRoot: isDev ? undefined : path.join(process.resourcesPath, "web"),
      devServerUrl: process.env.VITE_DEV_SERVER_URL,
      title: `${productName} — ${activeConnection?.name ?? "Local"}`,
      partition: `persist:orkestrator-renderer-${slot}`,
      beforeLoad: (createdWindow) => {
        allocation.window = createdWindow;
        const emitToOwner = (event: string, payload: unknown) =>
          emitToWindow(createdWindow, event, payload);
        installRemoteGatewayRequestAuth(
          createdWindow.webContents.session.webRequest,
          (url) => connectionManager?.getRendererRequestAuthorization(url, scope) ?? null,
        );
        const browserPreviewMainAdapters = createBrowserPreviewMainAdapters({
          emitToRenderers: emitToOwner,
          openExternal: (url) => shell.openExternal(url),
          writeClipboardText: (text) => clipboard.writeText(text),
          logError: (message, error) => console.error(message, error),
        });
        const browserPreviewRuntime = initializeBrowserPreviews({
          fromPartition: (partition) => session.fromPartition(partition),
          partition: `persist:orkestrator-browser-previews-${slot}`,
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
        });
        const webContentsId = createdWindow.webContents.id;
        windowContexts.set(webContentsId, {
          window: createdWindow,
          scope,
          slot,
          browserPreviewManager: browserPreviewRuntime.manager,
        });
        lastFocusedWindowId = webContentsId;
        registered = true;
        createdWindow.on("page-title-updated", (event) => {
          event.preventDefault();
          setConnectionTitle(createdWindow, scope);
        });
        createdWindow.webContents.on("did-finish-load", () => {
          // A new window can join an already-open pooled event stream and
          // therefore miss its transport-level connected frame. Force the
          // same authoritative reconciliation after every document load.
          emitToOwner("native-event-stream-connected", undefined);
        });
        createdWindow.on("focus", () => {
          lastFocusedWindowId = webContentsId;
        });
        createdWindow.once("closed", () => {
          browserPreviewRuntime.manager.destroyAll();
          windowContexts.delete(webContentsId);
          connectionManager?.release(scope);
          usedWindowSlots.delete(slot);
          if (lastFocusedWindowId === webContentsId) {
            lastFocusedWindowId = windowContexts.keys().next().value ?? null;
          }
        });
      },
    });
    windowAllClosedQuit.markMainWindowCreated();
  } catch (error) {
    if (registered) allocation.window?.destroy();
    else {
      connectionManager.release(scope);
      usedWindowSlots.delete(slot);
    }
    throw error;
  }
}

function registerIpc(): void {
  const manager = () => {
    if (!connectionManager) throw new Error("Connections are not initialized");
    return connectionManager;
  };
  const scopeForEvent = (event?: { sender?: { id: number } }) => contextForEvent(event).scope;
  const updateWindowTitle = (event: { sender?: { id: number } } | undefined) => {
    const context = contextForEvent(event);
    setConnectionTitle(context.window, context.scope);
  };
  const publishConnectionLists = () => {
    for (const context of windowContexts.values()) {
      emitToWindow(context.window, "desktop-connections-changed", manager().getList(context.scope));
    }
  };
  registerMainIpc({
    getBackend: (event) => {
      const scope = scopeForEvent(event);
      return { invoke: (command, args) => manager().invoke(command, args, scope) };
    },
    getMainWindow: (event) => contextForEvent(event).window,
    ipc: ipcMain,
    clipboardApi: clipboard,
    dialogApi: dialog,
    appApi: app,
    nativeImageApi: nativeImage,
    listConnections: (event) => manager().getList(scopeForEvent(event)),
    probeConnection: (connectionId) => {
      return manager().probe(connectionId);
    },
    connectToRemote: async (input, event) => {
      const list = await manager().connect(input, scopeForEvent(event));
      updateWindowTitle(event);
      publishConnectionLists();
      return list;
    },
    updateConnectionToken: async (connectionId, token, event) => {
      const list = await manager().updateToken(connectionId, token, scopeForEvent(event));
      publishConnectionLists();
      return list;
    },
    useConnection: async (connectionId, event) => {
      const list = await manager().use(connectionId, scopeForEvent(event));
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
    getBrowserPreviews: (event) => contextForEvent(event).browserPreviewManager,
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
  const toolchainBinDir = await preparePinnedToolchains({
    dataDir,
    ensure: ensurePinnedToolchains,
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
  });
  if (!toolchainBinDir) return;
  backend = await backendProcess.start({
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
    runtimeFlavor,
    runtimeProfileId: runtimeProfile?.id,
    worktreeDir: runtimeProfile?.worktreeDir,
    dockerImage: runtimeProfile?.dockerImage,
    strictDockerOwner: runtimeFlavor === "agent-test",
    strictGatewayPort: runtimeFlavor === "agent-test",
    credentialSources: runtimeProfile?.credentialSources,
    onEvent: (event, payload) => {
      if (connectionManager) connectionManager.handleLocalEvent(event, payload);
    },
    onUnexpectedExit: (error) => {
      connectionManager?.markLocalBackendUnavailable();
      emitToConnection("local", "local-backend-unavailable", { message: error.message });
      dialog.showErrorBox(
        `${productName} backend stopped`,
        `${error.message}\n\nLocal work is unavailable. Remote windows remain connected; restart the application to recover Local.`,
      );
    },
  });
  connectionManager = new ConnectionManager({
    localBackend: backend,
    secureStorage: safeStorage,
    onEvent: () => undefined,
    onConnectionEvent: emitToConnection,
  });
  await connectionManager.initialize();
  await backend.invoke("get_config");

  createMenu();
  registerIpc();
  await createWindow();
  connectionManager.release(DEFAULT_CONNECTION_SCOPE);
  while (pendingNewWindowRequests > 0) {
    pendingNewWindowRequests -= 1;
    await createWindow();
  }
  await toolchainProgress.close();

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

  registerBrowserPreviewWindowActivation({
    onActivate: (listener) => app.on("activate", listener),
    getWindowCount: () => BrowserWindow.getAllWindows().length,
    createWindow,
    onCreateError: (error) => console.error("[Desktop] Failed to recreate the main window:", error),
  });
}

if (isPrimaryInstance) {
  registerSecondInstanceFocus(
    app,
    () => focusedContext()?.window ?? null,
    () => {
      if (!connectionManager) {
        pendingNewWindowRequests += 1;
        return;
      }
      void createWindow().catch((error) =>
        console.error("[Desktop] Failed to create a window for a second launch:", error),
      );
    },
  );

  void app
    .whenReady()
    .then(startApplication)
    .catch((error: unknown) => {
      console.error("[Desktop] Startup failed:", error);
      dialog.showErrorBox(
        `${productName} failed to start`,
        error instanceof Error ? error.message : String(error),
      );
      app.quit();
    });
} else {
  console.error(
    `[Desktop] Another ${productName} instance is already using ${app.getPath("userData")}. Quit it and try again.`,
  );
}

registerBackendShutdown(app, backendProcess);
registerApplicationLoggingShutdown(app, applicationLogging);
