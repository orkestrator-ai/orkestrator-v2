import { contextBridge, ipcRenderer } from "electron";
import { createOrkestratorElectronApi, type OrkestratorElectronApi } from "./preload-api.js";

contextBridge.exposeInMainWorld("orkestrator", createOrkestratorElectronApi(ipcRenderer));

export type { OrkestratorElectronApi };
