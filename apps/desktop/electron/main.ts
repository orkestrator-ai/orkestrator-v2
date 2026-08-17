import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, safeStorage, session, shell, WebContentsView } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BackendProcess, type BackendHttpClient } from "./backend-process.js";
import { createBackendWebClientControls, registerBackendShutdown } from "./backend-lifecycle.js";
import { PRODUCT_NAME, userDataDirectoryName } from "./app-constants.js";
import { registerMainIpc } from "./ipc.js";
import { resolveRuntimeRoots } from "./paths.js";
import { createMainWindow } from "./window.js";
import { ConnectionManager } from "./connection-manager.js";
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
  registerBrowserPreviewWindowCleanup,
} from "./browser-preview-startup.js";
import { createBrowserPreviewMainAdapters } from "./browser-preview-main-adapters.js";
import { claimSingleInstanceLock, registerSecondInstanceFocus } from "./single-instance.js";
import { createApplicationMenuTemplate } from "./application-menu.js";
import { runtimeProfileFromEnvironment } from "./runtime-profile.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.ELECTRON_DEV === "1";
const runtimeProfile = runtimeProfileFromEnvironment();
const runtimeFlavor = runtimeProfile?.flavor ?? (isDev ? "development" : "production");
const productName = runtimeProfile?.electronTitle ?? PRODUCT_NAME;

app.setName(productName);
app.setPath(
  "userData",
  runtimeProfile?.dataDir ?? path.join(app.getPath("appData"), userDataDirectoryName(isDev)),
);

// Must follow the `userData` override above: the lock is scoped to that path.
const isPrimaryInstance = claimSingleInstanceLock(app);

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
  const template = createApplicationMenuTemplate({
    productName,
    closeTab: () => emitToRenderers("menu-close-tab", undefined),
    zoom: (direction) => emitToRenderers("menu-zoom", direction),
  });
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
    title: productName,
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
  // An agent-test profile takes its selection from the launcher rather than the
  // durable per-installation choice, so an isolated run never inherits or
  // rewrites the user's. It must still be a real selection: Cursor and Grok
  // resolve only through the managed toolchain, so provisioning nothing leaves
  // them permanently unlaunchable in exactly the profiles meant to test them.
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
    worktreeDir: runtimeProfile?.worktreeDir,
    dockerImage: runtimeProfile?.dockerImage,
    strictDockerOwner: runtimeFlavor === "agent-test",
    strictGatewayPort: runtimeFlavor === "agent-test",
    credentialSources: runtimeProfile?.credentialSources,
    onEvent: (event, payload) => {
      if (connectionManager) connectionManager.handleLocalEvent(event, payload);
      else emitToRenderers(event, payload);
    },
    onUnexpectedExit: (error) => {
      dialog.showErrorBox(
        `${productName} backend stopped`,
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

  const browserPreviewMainAdapters = createBrowserPreviewMainAdapters({
    emitToRenderers,
    openExternal: (url) => shell.openExternal(url),
    writeClipboardText: (text) => clipboard.writeText(text),
    logError: (message, error) => console.error(message, error),
  });
  const browserPreviewRuntime = initializeBrowserPreviews({
    fromPartition: (partition) => session.fromPartition(partition),
    WebContentsViewCtor: WebContentsView,
    menu: Menu,
    getWindow: () => mainWindow,
    ...browserPreviewMainAdapters,
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

  if (runtimeProfile) {
    const info = backendProcess.getInfo();
    process.stdout.write(`${JSON.stringify({
      type: "orkestrator-electron-ready",
      profile: runtimeProfile.id,
      electronPid: process.pid,
      backendPid: backendProcess.getPid(),
      authFile: info?.authFile,
      browserUrl: info?.browserUrl,
    })}\n`);
  }

  registerBrowserPreviewWindowActivation({
    onActivate: (listener) => app.on("activate", listener),
    getWindowCount: () => BrowserWindow.getAllWindows().length,
    createWindow,
    onCreateError: (error) => console.error("[Desktop] Failed to recreate the main window:", error),
  });
}

if (isPrimaryInstance) {
  registerSecondInstanceFocus(app, () => mainWindow);

  void app.whenReady().then(startApplication).catch((error: unknown) => {
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || runtimeFlavor === "agent-test") app.quit();
});

registerBackendShutdown(app, backendProcess);
