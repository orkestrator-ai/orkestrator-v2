import type { ToolchainProgress } from "./toolchain-manager.js";

type ProgressElement = {
  textContent: string | null;
  style: { width: string };
};

type ProgressDocument = {
  getElementById(id: string): ProgressElement | null;
};

export function toolchainProgressFraction(progress: ToolchainProgress): number {
  if (progress.overallFraction !== undefined) {
    return Math.max(0, Math.min(1, progress.overallFraction));
  }
  const currentFraction = progress.bytesTotal && progress.bytesReceived !== undefined
    ? Math.min(1, progress.bytesReceived / progress.bytesTotal)
    : 0;
  return progress.totalTools > 0
    ? Math.max(0, Math.min(1, (progress.completedTools + currentFraction) / progress.totalTools))
    : 0;
}

export function applyToolchainProgress(
  progress: ToolchainProgress,
  progressDocument: ProgressDocument = document,
): boolean {
  const message = progressDocument.getElementById("message");
  const detail = progressDocument.getElementById("detail");
  const progressBar = progressDocument.getElementById("progress");
  if (!message || !detail || !progressBar) return false;

  message.textContent = progress.message;
  progressBar.style.width = `${Math.round(toolchainProgressFraction(progress) * 100)}%`;
  detail.textContent = progress.bytesTotal && progress.bytesReceived !== undefined
    ? `${Math.round(progress.bytesReceived / 1_048_576)} of ${Math.round(progress.bytesTotal / 1_048_576)} MB`
    : `${progress.completedTools} of ${progress.totalTools} tools ready`;
  return true;
}
