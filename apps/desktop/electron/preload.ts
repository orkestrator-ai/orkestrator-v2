import { contextBridge, ipcRenderer } from "electron";
import {
  exposeActiveConnectionGateway,
  exposeDesktopApi,
  type OrkestratorElectronApi,
} from "./preload-api.js";
import { applyDesktopTitleBarInset } from "./title-bar-inset.js";

exposeDesktopApi(contextBridge, ipcRenderer);

exposeActiveConnectionGateway(contextBridge, ipcRenderer);

function applyHostTitleBarInset(platform: NodeJS.Platform = process.platform): void {
  const apply = () => applyDesktopTitleBarInset(document.documentElement, platform);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  } else {
    apply();
  }
}

applyHostTitleBarInset();

export type { OrkestratorElectronApi };
