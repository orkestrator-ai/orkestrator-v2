import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OrkestratorBackend } from "./backend/index.js";
import { APP_SLUG, PRODUCT_NAME } from "./backend/constants.js";
import { fixPath } from "./backend/fix-path.js";
import { OrkestratorGateway, type GatewayStartInfo } from "./gateway.js";
import { registerMainIpc } from "./ipc.js";
import { resolveRuntimeRoots } from "./paths.js";
import { createMainWindow } from "./window.js";
import type { AppConfig } from "./backend/models.js";
import type { WebClientStatus } from "../src/types/webClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.ELECTRON_DEV === "1";

// Restore a usable PATH so spawned CLIs (docker, git, gh, …) resolve when the
// app is launched as a packaged GUI app rather than from a terminal.
fixPath();

app.setName(PRODUCT_NAME);
app.setPath("userData", path.join(app.getPath("appData"), APP_SLUG));

let mainWindow: BrowserWindow | null = null;
let backend: OrkestratorBackend | null = null;
let gateway: OrkestratorGateway | null = null;
let gatewayStartInfo: GatewayStartInfo | null = null;
let gatewayEnabled = true;
let gatewayError: string | null = null;
let gatewayTransition: Promise<WebClientStatus> = Promise.resolve({
  enabled: gatewayEnabled,
  running: false,
  url: null,
  error: null,
});

function getWebClientStatus(): WebClientStatus {
  return {
    enabled: gatewayEnabled,
    running: gatewayStartInfo !== null,
    url: gatewayStartInfo?.url ?? null,
    error: gatewayError,
  };
}

async function applyWebClientEnabled(enabled: boolean): Promise<WebClientStatus> {
  gatewayEnabled = enabled;
  gatewayError = null;

  if (!gateway) {
    gatewayError = "The web client is not available because the gateway is not initialized.";
    return getWebClientStatus();
  }

  if (!enabled) {
    try {
      await gateway.stop();
    } catch (error) {
      gatewayError = error instanceof Error ? error.message : String(error);
      console.error("[RemoteGateway] Failed to stop cleanly:", error);
    }
    gatewayStartInfo = null;
    return getWebClientStatus();
  }

  if (gatewayStartInfo) return getWebClientStatus();

  try {
    gatewayStartInfo = await gateway.start();
    if (!gatewayStartInfo) {
      gatewayError = process.env.ORKESTRATOR_GATEWAY_DISABLED === "1"
        ? "The web client is disabled by ORKESTRATOR_GATEWAY_DISABLED."
        : "No Tailscale connection was found. Connect Tailscale, then save again to retry.";
    }
  } catch (error) {
    gatewayStartInfo = null;
    gatewayError = error instanceof Error ? error.message : String(error);
    console.error("[RemoteGateway] Failed to start:", error);
  }
  return getWebClientStatus();
}

function setWebClientEnabled(enabled: boolean): Promise<WebClientStatus> {
  gatewayTransition = gatewayTransition
    .catch(() => getWebClientStatus())
    .then(() => applyWebClientEnabled(enabled));
  return gatewayTransition;
}

function emitToRenderers(event: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("orkestrator:event", event, payload);
  }
  gateway?.emit(event, payload);
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
  mainWindow = await createMainWindow({
    BrowserWindowCtor: BrowserWindow,
    menu: Menu,
    dirname: __dirname,
    isDev,
    appPath: app.getAppPath(),
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
  });
}

function registerIpc(): void {
  registerMainIpc({
    getBackend: () => backend,
    getMainWindow: () => mainWindow,
    ipc: ipcMain,
    clipboardApi: clipboard,
    dialogApi: dialog,
    appApi: app,
    nativeImageApi: nativeImage,
    getWebClientStatus,
    setWebClientEnabled,
  });
}

app.whenReady().then(async () => {
  const { appRoot, resourceRoot } = resolveRuntimeRoots({
    isDev,
    dirname: __dirname,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });
  backend = new OrkestratorBackend({
    dataDir: app.getPath("userData"),
    appRoot,
    resourceRoot,
    emit: emitToRenderers,
  });
  await backend.init();

  gateway = new OrkestratorGateway({
    backend,
    dataDir: app.getPath("userData"),
    rendererRoot: path.join(appRoot, "dist"),
    rendererDevServerUrl: isDev ? process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:1420" : undefined,
  });
  const config = await backend.invoke<AppConfig>("get_config");
  await setWebClientEnabled(config.global.webClientEnabled ?? true);

  createMenu();
  registerIpc();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void gateway?.stop();
});
