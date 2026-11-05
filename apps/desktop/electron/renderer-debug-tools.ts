/**
 * Which renderers have debug logging on, so the Help menu offers Open Developer
 * Tools only while one does (docs/architecture/logging.md, "The renderer").
 *
 * A renderer reports its `orkestrator:debug` preference once it starts, and
 * again on every reload, because the preference is read once per load. Off is
 * reported too, so turning it off and reloading takes the item away. A renderer
 * that goes away is forgotten.
 *
 * DevTools is opt-in for a reason: secrets the renderer holds in memory are
 * visible there. The menu item is the only way this opens it; the artifact host
 * and browser previews keep their own rules and are never a target here.
 */
export interface DebugRenderer {
  readonly id: number;
  isDestroyed(): boolean;
  openDevTools(options?: { mode: "detach" | "right" | "bottom" | "undocked" }): void;
  once(event: "destroyed", listener: () => void): unknown;
}

export class RendererDebugTools {
  private readonly enabled = new Map<number, DebugRenderer>();
  private readonly watched = new Set<number>();

  /** @param changed Rebuilds the menu when whether any renderer has it on changes. */
  constructor(private readonly changed: () => void) {}

  report(renderer: DebugRenderer, enabled: boolean): void {
    const before = this.anyEnabled();
    if (enabled && !renderer.isDestroyed()) this.enabled.set(renderer.id, renderer);
    else this.enabled.delete(renderer.id);
    if (!this.watched.has(renderer.id)) {
      this.watched.add(renderer.id);
      renderer.once("destroyed", () => {
        this.watched.delete(renderer.id);
        const had = this.anyEnabled();
        this.enabled.delete(renderer.id);
        if (had !== this.anyEnabled()) this.changed();
      });
    }
    if (before !== this.anyEnabled()) this.changed();
  }

  /** The trusted IPC adapter resolves the live webContents, never a renderer-supplied id. */
  reportSender(
    event: { sender?: { id: number } },
    enabled: boolean,
    lookup: (id: number) => DebugRenderer | undefined,
  ): void {
    const sender = event.sender ? lookup(event.sender.id) : undefined;
    if (sender) this.report(sender, enabled);
  }

  anyEnabled(): boolean {
    return this.enabled.size > 0;
  }

  /**
   * Opens DevTools for the first candidate (the focused renderer, then its
   * window's own) that has debug logging on. A renderer that never turned it on
   * is not opened, even when it is focused.
   */
  open(candidates: ReadonlyArray<{ id: number } | null | undefined>): boolean {
    for (const candidate of candidates) {
      const renderer = candidate ? this.enabled.get(candidate.id) : undefined;
      if (renderer && !renderer.isDestroyed()) {
        renderer.openDevTools({ mode: "detach" });
        return true;
      }
    }
    return false;
  }
}
