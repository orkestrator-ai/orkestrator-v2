import { ipcRenderer } from "electron";
import { applyToolchainProgress } from "./toolchain-bootstrap-progress.js";
import type { ToolchainProgress } from "./toolchain-manager.js";

let latestProgress: ToolchainProgress | null = null;

function applyProgress(progress: ToolchainProgress): void {
  latestProgress = progress;
  applyToolchainProgress(progress);
}

ipcRenderer.on("orkestrator:toolchain-progress", (_event, progress: ToolchainProgress) => {
  applyProgress(progress);
});

window.addEventListener("DOMContentLoaded", () => {
  if (latestProgress) applyProgress(latestProgress);
});
