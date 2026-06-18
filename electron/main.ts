import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OrkestratorBackend } from "./backend/index.js";
import { APP_SLUG, PRODUCT_NAME } from "./backend/constants.js";
import { registerMainIpc } from "./ipc.js";
import { resolveRendererIndexPath, resolveRuntimeRoots } from "./paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = process.env.ELECTRON_DEV === "1";

app.setName(PRODUCT_NAME);
app.setPath("userData", path.join(app.getPath("appData"), APP_SLUG));

let mainWindow: BrowserWindow | null = null;
let backend: OrkestratorBackend | null = null;

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
  mainWindow = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:1420");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(resolveRendererIndexPath(app.getAppPath()));
  }
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
