import { contextBridge, ipcRenderer } from "electron";
import {
  createOrkestratorElectronApi,
  exposeActiveConnectionGateway,
  type OrkestratorElectronApi,
} from "./preload-api.js";

contextBridge.exposeInMainWorld("orkestrator", createOrkestratorElectronApi(ipcRenderer));

exposeActiveConnectionGateway(contextBridge, ipcRenderer);

export type { OrkestratorElectronApi };
