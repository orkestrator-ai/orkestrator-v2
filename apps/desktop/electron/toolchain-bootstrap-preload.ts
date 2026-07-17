import { ipcRenderer } from "electron";
import type { ToolchainProgress } from "./toolchain-manager.js";

let latestProgress: ToolchainProgress | null = null;

function applyProgress(progress: ToolchainProgress): void {
  latestProgress = progress;
  const message = document.getElementById("message");
  const detail = document.getElementById("detail");
  const progressBar = document.getElementById("progress");
  if (!message || !detail || !progressBar) return;

  message.textContent = progress.message;
  const currentFraction = progress.bytesTotal && progress.bytesReceived !== undefined
    ? Math.min(1, progress.bytesReceived / progress.bytesTotal)
    : 0;
  const overallFraction = progress.totalTools > 0
    ? Math.min(1, (progress.completedTools + currentFraction) / progress.totalTools)
    : 0;
  progressBar.style.width = `${Math.round(overallFraction * 100)}%`;
  detail.textContent = progress.bytesTotal && progress.bytesReceived !== undefined
    ? `${Math.round(progress.bytesReceived / 1_048_576)} of ${Math.round(progress.bytesTotal / 1_048_576)} MB`
    : `${progress.completedTools} of ${progress.totalTools} tools ready`;
}

ipcRenderer.on("orkestrator:toolchain-progress", (_event, progress: ToolchainProgress) => {
  applyProgress(progress);
});

window.addEventListener("DOMContentLoaded", () => {
  if (latestProgress) applyProgress(latestProgress);
});
