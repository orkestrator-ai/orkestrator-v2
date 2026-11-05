import { app, BrowserWindow, Menu } from "electron";
import { createApplicationMenuTemplate } from "../../apps/desktop/electron/application-menu";
import { RendererDebugTools } from "../../apps/desktop/electron/renderer-debug-tools";

declare global {
  var applicationMenuEvents: string[];
  /** What a renderer's report does in main.ts: it rebuilds the menu when it changes. */
  var reportRendererDebug: (enabled: boolean) => void;
}

globalThis.applicationMenuEvents = [];
const record = (event: string) => globalThis.applicationMenuEvents.push(event);

app.setName("Orkestrator menu qualification");
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 800, height: 600, autoHideMenuBar: false });
  const debugTools = new RendererDebugTools(() => installMenu());
  function installMenu(): void {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        createApplicationMenuTemplate({
          platform: process.platform,
          productName: app.name,
          windows: [{ id: window.id, title: "Menu fixture", focused: true }],
          newWindow: () => record("new-window"),
          closeTab: () => record("close-tab"),
          selectWindow: (id) => record(`window:${id}`),
          zoom: (direction) => record(`zoom:${direction}`),
          showKeyboardShortcuts: (request) => record(`shortcuts:${request}`),
          openSettings: () => record("settings"),
          checkForUpdates: () => record("updates"),
          openDeveloperTools: debugTools.anyEnabled()
            ? () => void debugTools.open([window.webContents])
            : undefined,
        }),
      ),
    );
  }
  installMenu();
  globalThis.reportRendererDebug = (enabled) => debugTools.report(window.webContents, enabled);
  // Deliberately keep Electron's default About options, as production does.
  await window.loadURL(
    "data:text/html,<title>Orkestrator menu qualification</title><input autofocus aria-label='Typing target'>",
  );
  window.focus();
});
