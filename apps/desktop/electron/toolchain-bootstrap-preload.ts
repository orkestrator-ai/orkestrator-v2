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
  const continueButton = document.getElementById("continue");
  const error = document.getElementById("error");
  continueButton?.addEventListener("click", () => {
    const selected = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'),
      (input) => input.value,
    );
    if (selected.length === 0) {
      if (error) error.textContent = "Select at least one agent system.";
      return;
    }
    ipcRenderer.send("orkestrator:agent-platform-selection", selected);
  });
});
