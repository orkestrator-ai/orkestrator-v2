import { rebindWindowPreviews } from "./preview-connection-backend.js";
import type { WorkspaceContext } from "./window-workspace-target.js";

/** Migrate all documents after a live binding changes its route or grant. */
export function refreshWorkspaceRealm<
  Manager extends { destroyAll(): void },
  Transport extends { disposeAll(): Promise<void> },
>(
  context: {
    target: WorkspaceContext["target"];
    contents: { isDestroyed(): boolean; reload(): void };
    previewConnectionId: string;
    browserPreviewManager: Manager;
    previewTransport: Transport;
  },
  target: WorkspaceContext["target"],
  createPreviews: (connectionId: string) => { manager: Manager; previewTransport: Transport },
): void {
  if (context.contents.isDestroyed()) return;
  context.target = target;
  // Native previews must be recreated too: existing documents still request
  // their old gateway origin. The renderer persists canonical loopback URLs
  // and resolves them against the current gateway when it mounts again.
  rebindWindowPreviews(context, context.previewConnectionId, createPreviews, console, true);
  context.contents.reload();
}

/** The main process resources owned by a realm, independent of its document. */
export interface RealmContext {
  contents: { id: number; isDestroyed(): boolean; isFocused(): boolean };
  realm: { parentWebContentsId: number; viewId: string } | null;
  browserPreviewManager: { destroyAll(): void };
  artifactHosts: { dispose(): void };
  previewTransport: { disposeAll(): Promise<void> };
}

export class RealmContexts<T extends RealmContext> {
  private readonly contexts = new Map<number, T>();

  constructor(
    private readonly cancelPrompts: (id: number) => void,
    private readonly reportDisposalError: (error: unknown) => void,
  ) {}

  get(id: number): T | undefined {
    return this.contexts.get(id);
  }

  values(): IterableIterator<T> {
    return this.contexts.values();
  }

  register(context: T): void {
    this.contexts.set(context.contents.id, context);
  }

  unregister(id: number): void {
    const context = this.contexts.get(id);
    this.contexts.delete(id);
    if (!context) return;
    context.browserPreviewManager.destroyAll();
    context.artifactHosts.dispose();
    // End this view's transports, leaving services on the node running.
    void context.previewTransport.disposeAll().catch(this.reportDisposalError);
    this.cancelPrompts(id);
  }

  focused(parentWebContentsId: number): T | undefined {
    return Array.from(this.contexts.values()).find(
      (context) =>
        context.realm?.parentWebContentsId === parentWebContentsId &&
        !context.contents.isDestroyed() &&
        context.contents.isFocused(),
    );
  }
}
