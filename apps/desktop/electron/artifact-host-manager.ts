import type { BrowserWindow, Session } from "electron";
import type { ArtifactThemeMessage } from "@orkestrator/protocol/artifact-frame-channel";
import type {
  ArtifactHostBounds,
  ArtifactHostEvent,
  ArtifactHostOpenInput,
} from "@orkestrator/protocol/artifact-host-ipc";
import {
  ArtifactHostSession,
  type ArtifactHostCloseReason,
  type ArtifactHostDiagnostics,
  type ArtifactHostSessionOptions,
} from "./artifact-host-session.js";
import type { ArtifactHostController } from "./artifact-host-ipc.js";

export interface ArtifactHostManagerOptions {
  getWindow: () => BrowserWindow | null;
  WebContentsViewCtor: ArtifactHostSessionOptions["WebContentsViewCtor"];
  fromPartition: (partition: string) => Session;
  /** Deliver an event to the owning window's renderer only. */
  emit: (event: ArtifactHostEvent) => void;
  /** Content-free counters for a host that ended with blocked or rejected traffic. */
  reportDiagnostics?: (diagnostics: ArtifactHostDiagnostics) => void;
  now?: () => number;
  randomId?: () => string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  readyTimeoutMs?: number;
}

export const ARTIFACT_HOST_UNAVAILABLE = "Interactive artifacts are unavailable in this window";

/**
 * At most one live interactive-artifact host per application window.
 * Opening another replaces the previous one (`closed: replaced`); every other
 * artifact in the window keeps its saved preview.
 */
export class ArtifactHostManager implements ArtifactHostController {
  private current: ArtifactHostSession | null = null;
  private disposed = false;

  constructor(private readonly options: ArtifactHostManagerOptions) {}

  get activeHostId(): string | null {
    return this.current?.isOpen ? this.current.hostId : null;
  }

  /** The live host, for tests and diagnostics. */
  activeHost(): ArtifactHostSession | null {
    return this.current?.isOpen ? this.current : null;
  }

  async open(input: ArtifactHostOpenInput): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.disposed) return { ok: false, error: ARTIFACT_HOST_UNAVAILABLE };
    const existing = this.current?.isOpen ? this.current : null;
    // Re-opening the same live document only repositions it: no reload, and a
    // renewed capability for a mounted document does not restart it.
    if (existing && existing.hostId === input.hostId && existing.matches(input)) {
      existing.setBounds(input.bounds);
      existing.setVisible(input.visible);
      return { ok: true };
    }
    // A different document under the same host id is a new session for that
    // id; reporting `closed` for the id the renderer just opened would end it.
    if (existing) existing.close("replaced", { silent: existing.hostId === input.hostId });
    const window = this.options.getWindow();
    if (!window || window.isDestroyed()) return { ok: false, error: ARTIFACT_HOST_UNAVAILABLE };
    let host: ArtifactHostSession | null = null;
    try {
      host = new ArtifactHostSession({
        input,
        window,
        WebContentsViewCtor: this.options.WebContentsViewCtor,
        fromPartition: this.options.fromPartition,
        hostZoomFactor: () => this.hostZoomFactor(),
        emit: (event) => this.options.emit(event),
        onTerminated: (terminated, diagnostics) => this.onTerminated(terminated, diagnostics),
        ...(this.options.now ? { now: this.options.now } : {}),
        ...(this.options.randomId ? { randomId: this.options.randomId } : {}),
        ...(this.options.readyTimeoutMs !== undefined
          ? { readyTimeoutMs: this.options.readyTimeoutMs }
          : {}),
        ...(this.options.heartbeatIntervalMs !== undefined
          ? { heartbeatIntervalMs: this.options.heartbeatIntervalMs }
          : {}),
        ...(this.options.heartbeatTimeoutMs !== undefined
          ? { heartbeatTimeoutMs: this.options.heartbeatTimeoutMs }
          : {}),
      });
      this.current = host;
      host.start();
    } catch (error) {
      if (host && this.current === host) this.current = null;
      // Content-free: never echo the capability URL back.
      const message = error instanceof Error ? error.message : "";
      return {
        ok: false,
        error: message.startsWith("This desktop build")
          ? message
          : "The interactive artifact host could not be created",
      };
    }
    return { ok: true };
  }

  setBounds(hostId: string, bounds: ArtifactHostBounds): void {
    this.hostFor(hostId)?.setBounds(bounds);
  }

  setVisible(hostId: string, visible: boolean): void {
    this.hostFor(hostId)?.setVisible(visible);
  }

  postTheme(hostId: string, theme: ArtifactThemeMessage): void {
    this.hostFor(hostId)?.postTheme(theme);
  }

  close(hostId: string): void {
    this.hostFor(hostId)?.close("requested");
  }

  /** The owning renderer reloaded or navigated: its live host has no owner. */
  closeAll(reason: ArtifactHostCloseReason = "window-closed"): void {
    const host = this.current;
    this.current = null;
    host?.close(reason);
  }

  /** The window closed: destroy the host and refuse further opens. */
  dispose(): void {
    this.disposed = true;
    this.closeAll("window-closed");
  }

  private hostFor(hostId: string): ArtifactHostSession | null {
    const host = this.current;
    return host && host.isOpen && host.hostId === hostId ? host : null;
  }

  private onTerminated(host: ArtifactHostSession, diagnostics: ArtifactHostDiagnostics): void {
    if (this.current === host) this.current = null;
    const counted =
      Object.keys(diagnostics.blocked).length > 0 || Object.keys(diagnostics.rejected).length > 0;
    if (counted) this.options.reportDiagnostics?.(diagnostics);
  }

  /** Same scaling rule as browser previews: renderer CSS pixels times page zoom. */
  private hostZoomFactor(): number {
    const window = this.options.getWindow();
    if (!window || window.isDestroyed()) return 1;
    const factor = window.webContents?.getZoomFactor?.();
    return typeof factor === "number" && Number.isFinite(factor) && factor > 0 ? factor : 1;
  }
}
