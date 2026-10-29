import { app, BrowserWindow, Menu } from "electron";
import { createApplicationMenuTemplate } from "../../apps/desktop/electron/application-menu";

declare global {
  var applicationMenuEvents: string[];
}

globalThis.applicationMenuEvents = [];
const record = (event: string) => globalThis.applicationMenuEvents.push(event);

app.setName("Orkestrator menu qualification");
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 800, height: 600, autoHideMenuBar: false });
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
      }),
    ),
  );
  // Deliberately keep Electron's default About options, as production does.
  await window.loadURL(
    "data:text/html,<title>Orkestrator menu qualification</title><input autofocus aria-label='Typing target'>",
  );
  window.focus();
});
