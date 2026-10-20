/**
 * Desktop IPC contract for the live interactive-artifact host.
 *
 * On desktop, executable artifact documents never run inside the
 * application renderer (which keeps `sandbox: false` for its ESM preload).
 * The main process owns one sandboxed `WebContentsView` per application
 * window, on a fresh nonpersistent session with request interception, and
 * the renderer only positions it and relays the four presentation messages.
 */
import type { ArtifactThemeMessage } from "./artifact-frame-channel.js";

export const ARTIFACT_HOST_CHANNELS = {
  open: "orkestrator:artifact-host:open",
  setBounds: "orkestrator:artifact-host:set-bounds",
  setVisible: "orkestrator:artifact-host:set-visible",
  postTheme: "orkestrator:artifact-host:post-theme",
  close: "orkestrator:artifact-host:close",
  event: "orkestrator:artifact-host:event",
} as const;

export interface ArtifactHostBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ArtifactHostOpenInput {
  /** Renderer-chosen id for this live session (one per window at a time). */
  hostId: string;
  /** Exact capability URL on the dedicated content origin. */
  contentUrl: string;
  artifactId: string;
  revision: number;
  generation: string;
  readinessNonce: string;
  bounds: ArtifactHostBounds;
  visible: boolean;
}

export type ArtifactHostEvent =
  | { hostId: string; type: "ready" }
  | { hostId: string; type: "size"; height: number; width?: number }
  | { hostId: string; type: "link-request"; href: string; hostname: string; label: string }
  | { hostId: string; type: "navigation-blocked"; reason: string }
  | { hostId: string; type: "crashed"; reason: string }
  | { hostId: string; type: "unresponsive" }
  | {
      hostId: string;
      type: "closed";
      reason: "requested" | "replaced" | "window-closed" | "crashed";
    };

export interface ArtifactHostApi {
  open(input: ArtifactHostOpenInput): Promise<{ ok: true } | { ok: false; error: string }>;
  setBounds(hostId: string, bounds: ArtifactHostBounds): Promise<void>;
  setVisible(hostId: string, visible: boolean): Promise<void>;
  postTheme(hostId: string, theme: ArtifactThemeMessage): Promise<void>;
  close(hostId: string): Promise<void>;
  onEvent(listener: (event: ArtifactHostEvent) => void): () => void;
}
