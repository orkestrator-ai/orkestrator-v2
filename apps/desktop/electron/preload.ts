import { contextBridge, ipcRenderer } from "electron";
import type { ConnectionList } from "@orkestrator/protocol/connections";
import { createOrkestratorElectronApi, type OrkestratorElectronApi } from "./preload-api.js";

contextBridge.exposeInMainWorld("orkestrator", createOrkestratorElectronApi(ipcRenderer));

const connectionList = ipcRenderer.sendSync("orkestrator:connections:list-sync") as ConnectionList;
const activeConnection = connectionList.connections.find((connection) => connection.active);
if (activeConnection?.kind === "remote" && activeConnection.address) {
  contextBridge.exposeInMainWorld("orkestratorGateway", {
    enabled: true,
    baseUrl: activeConnection.address,
  });
}

export type { OrkestratorElectronApi };
