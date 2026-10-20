import type { ArtifactHostApi } from "@orkestrator/protocol/artifact-host-ipc";

/**
 * The desktop live-artifact host, when this renderer runs in Electron with a
 * preload that provides it. Browser mode returns null and falls back to an
 * opaque-origin sandboxed iframe on the dedicated content origin.
 */
export function getArtifactHostApi(): ArtifactHostApi | null {
  return window.orkestrator?.artifactHost ?? null;
}
