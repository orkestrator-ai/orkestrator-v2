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
