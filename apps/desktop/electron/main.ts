import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, safeStorage, session, WebContentsView } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BackendProcess, type BackendHttpClient } from "./backend-process.js";
import { createBackendWebClientControls, registerBackendShutdown } from "./backend-lifecycle.js";
import { APP_SLUG, PRODUCT_NAME } from "./app-constants.js";
import { registerMainIpc } from "./ipc.js";
import { resolveRuntimeRoots } from "./paths.js";
import { createMainWindow } from "./window.js";
import { ConnectionManager } from "./connection-manager.js";
import { installRemoteGatewayRequestAuth } from "./remote-gateway-request-auth.js";
import { ensurePinnedToolchains } from "./toolchain-manager.js";
import { createToolchainBootstrapWindow, reportToolchainProgress } from "./toolchain-bootstrap-window.js";
import { createToolchainProgressController, preparePinnedToolchains } from "./toolchain-startup.js";
import type { BrowserPreviewManager } from "./browser-preview-manager.js";
import {
  createBrowserPreviewAddressFocusHandler,
  initializeBrowserPreviews,
  registerBrowserPreviewWindowActivation,
  registerBrowserPreviewWindowCleanup,
} from "./browser-preview-startup.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.ELECTRON_DEV === "1";

app.setName(PRODUCT_NAME);
app.setPath("userData", path.join(app.getPath("appData"), APP_SLUG));

let mainWindow: BrowserWindow | null = null;
let backend: BackendHttpClient | null = null;
let connectionManager: ConnectionManager | null = null;
let browserPreviewManager: BrowserPreviewManager | null = null;
const backendProcess = new BackendProcess();
const toolchainProgress = createToolchainProgressController({
  createWindow: () => createToolchainBootstrapWindow({
    BrowserWindowCtor: BrowserWindow,
    dirname: __dirname,
  }),
  reportProgress: (window, progress) => reportToolchainProgress(window as BrowserWindow, progress),
  logError: (error) => console.error("[Toolchains] Failed to show bootstrap progress:", error),
});

function emitToRenderers(event: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("orkestrator:event", event, payload);
  }
}

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: PRODUCT_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => emitToRenderers("menu-zoom", "in") },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => emitToRenderers("menu-zoom", "out") },
        { type: "separator" },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => emitToRenderers("menu-zoom", "reset") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(): Promise<void> {
  const createdWindow = await createMainWindow({
    BrowserWindowCtor: BrowserWindow,
    menu: Menu,
    dirname: __dirname,
    isDev,
    appPath: app.getAppPath(),
    rendererRoot: isDev ? undefined : path.join(process.resourcesPath, "web"),
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
  });
  mainWindow = createdWindow;
  registerBrowserPreviewWindowCleanup({
    window: createdWindow,
    getManager: () => browserPreviewManager,
    getCurrentWindow: () => mainWindow,
    clearCurrentWindow: () => {
      mainWindow = null;
    },
  });
}

function registerIpc(): void {
  const webClientControls = createBackendWebClientControls(() => connectionManager);
  registerMainIpc({
    getBackend: () => connectionManager,
    getMainWindow: () => mainWindow,
    ipc: ipcMain,
    clipboardApi: clipboard,
    dialogApi: dialog,
    appApi: app,
    nativeImageApi: nativeImage,
    listConnections: () => {
      if (!connectionManager) throw new Error("Connections are not initialized");
      return connectionManager.getList();
    },
    connectToRemote: (input) => {
      if (!connectionManager) throw new Error("Connections are not initialized");
      return connectionManager.connect(input);
    },
    useConnection: (connectionId) => {
      if (!connectionManager) throw new Error("Connections are not initialized");
      return connectionManager.use(connectionId);
    },
    forgetConnection: (connectionId) => {
      if (!connectionManager) throw new Error("Connections are not initialized");
      return connectionManager.forget(connectionId);
    },
    browserPreviews: browserPreviewManager ?? undefined,
    trustedRendererUrl: isDev
      ? process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:1420"
      : pathToFileURL(path.join(process.resourcesPath, "web", "index.html")).href,
    ...webClientControls,
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
  const toolchainBinDir = await preparePinnedToolchains({
    dataDir,
    ensure: ensurePinnedToolchains,
    fetchImpl: (input, init) => net.fetch(input, init),
    onProgress: (progress) => toolchainProgress.report(progress),
    showMessageBox: (options) => dialog.showMessageBox(options),
    quit: () => app.quit(),
    logError: (error) => console.error("[Toolchains] Failed to prepare pinned tools:", error),
  });
  if (!toolchainBinDir) return;
  backend = await backendProcess.start({
    isDev,
    dataDir,
    appRoot,
    resourceRoot,
    toolchainBinDir,
    rendererDevServerUrl: isDev ? process.env.VITE_DEV_SERVER_URL : undefined,
    desktopWebClient: true,
    onEvent: (event, payload) => {
      if (connectionManager) connectionManager.handleLocalEvent(event, payload);
      else emitToRenderers(event, payload);
    },
    onUnexpectedExit: (error) => {
      dialog.showErrorBox(
        `${PRODUCT_NAME} backend stopped`,
        `${error.message}\n\nThe application will close. Restart it to recover.`,
      );
      app.quit();
    },
  });
  connectionManager = new ConnectionManager({
    localBackend: backend,
    secureStorage: safeStorage,
    onEvent: emitToRenderers,
  });
  await connectionManager.initialize();
  await backend.invoke("get_config");

  const browserPreviewRuntime = initializeBrowserPreviews({
    fromPartition: (partition) => session.fromPartition(partition),
    WebContentsViewCtor: WebContentsView,
    menu: Menu,
    getWindow: () => mainWindow,
    emitState: (state) => emitToRenderers("browser-preview-state", state),
    focusAddressBar: createBrowserPreviewAddressFocusHandler({
      getWindow: () => mainWindow,
      emitFocus: (tabId) =>
        emitToRenderers("browser-preview-focus-address", tabId),
    }),
    getAuthorization: (url) => connectionManager?.getRendererRequestAuthorization(url) ?? null,
  });
  browserPreviewManager = browserPreviewRuntime.manager;

  createMenu();
  installRemoteGatewayRequestAuth(
    session.defaultSession.webRequest,
    (url) => connectionManager?.getRendererRequestAuthorization(url) ?? null,
  );
  registerIpc();
  await createWindow();
  await toolchainProgress.close();

  registerBrowserPreviewWindowActivation({
    onActivate: (listener) => app.on("activate", listener),
    getWindowCount: () => BrowserWindow.getAllWindows().length,
    createWindow,
    onCreateError: (error) => console.error("[Desktop] Failed to recreate the main window:", error),
  });
}

void app.whenReady().then(startApplication).catch((error: unknown) => {
  console.error("[Desktop] Startup failed:", error);
  dialog.showErrorBox(
    `${PRODUCT_NAME} failed to start`,
    error instanceof Error ? error.message : String(error),
  );
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

registerBackendShutdown(app, backendProcess);
