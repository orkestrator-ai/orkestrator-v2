import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, type OpenDialogOptions } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OrkestratorBackend } from "./backend/index.js";
import { APP_SLUG, PRODUCT_NAME } from "./backend/constants.js";

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
    await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle("orkestrator:invoke", async (_event, command: string, args?: Record<string, unknown>) => {
    if (!backend) throw new Error("Backend is not initialized");
    return backend.invoke(command, args ?? {});
  });

  ipcMain.handle("orkestrator:clipboard:read-text", () => clipboard.readText());
  ipcMain.handle("orkestrator:clipboard:write-text", (_event, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle("orkestrator:clipboard:read-image", () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const size = image.getSize();
    return {
      width: size.width,
      height: size.height,
      dataUrl: image.toDataURL(),
    };
  });
  ipcMain.handle("orkestrator:clipboard:write-image", (_event, dataUrl: string) => {
    clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
  });

  ipcMain.handle("orkestrator:dialog:open", async (_event, options?: { directory?: boolean; multiple?: boolean; title?: string; defaultPath?: string }) => {
    const properties: NonNullable<OpenDialogOptions["properties"]> = [
      options?.directory ? "openDirectory" : "openFile",
      ...(options?.multiple ? ["multiSelections" as const] : []),
    ];
    const dialogOptions: OpenDialogOptions = {
      title: options?.title,
      defaultPath: options?.defaultPath,
      properties,
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled) return null;
    return options?.multiple ? result.filePaths : result.filePaths[0] ?? null;
  });

  ipcMain.handle("orkestrator:process:exit", (_event, code?: number) => {
    app.exit(code ?? 0);
  });

  ipcMain.handle("orkestrator:window:start-dragging", () => undefined);
}

app.whenReady().then(async () => {
  const appRoot = isDev ? path.resolve(__dirname, "..") : app.getAppPath();
  const resourceRoot = isDev ? appRoot : process.resourcesPath;
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
