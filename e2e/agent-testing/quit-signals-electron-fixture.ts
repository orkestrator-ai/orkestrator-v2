import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { configureLogger } from "@orkestrator/protocol/logger";
import { installEssentialLog } from "@orkestrator/protocol/node/essential-log";
import { BackendProcess } from "../../apps/desktop/electron/backend-process";
import { registerDesktopShutdown } from "../../apps/desktop/electron/desktop-shutdown";

const scratch = process.cwd();
const dataDir = path.join(scratch, "profile");
app.setPath("userData", dataDir);
const backend = new BackendProcess();
const essentialLog = installEssentialLog({ dataDir, owner: "desktop" });

configureLogger({
  sink: ({ record }) => {
    if (record?.event === "quit.signal-repeated")
      writeFileSync(path.join(scratch, "signal-repeated"), "");
  },
});
registerDesktopShutdown({
  app,
  backend,
  essentialLog,
  applicationLogging: {
    stop() {
      writeFileSync(path.join(scratch, "application-flush"), "");
      return new Promise(() => {});
    },
  },
  relaunchImage: () => {},
});

void app.whenReady().then(async () => {
  await backend.start({
    isDev: true,
    appRoot: scratch,
    resourceRoot: scratch,
    dataDir,
    onEvent: () => {},
  });
  await essentialLog.flush();
  const window = new BrowserWindow({ webPreferences: { sandbox: true } });
  window.webContents.on("will-prevent-unload", (event) => {
    writeFileSync(
      path.join(scratch, event.defaultPrevented ? "veto-overridden" : "veto-honoured"),
      "",
    );
  });
  await window.loadURL(
    "data:text/html," +
      encodeURIComponent(`<button>Enable unload veto</button><script>
      document.querySelector("button").onclick = () => {
        window.addEventListener("beforeunload", event => event.preventDefault());
        document.querySelector("button").textContent = "Veto enabled";
      };
    </script>`),
  );
});
