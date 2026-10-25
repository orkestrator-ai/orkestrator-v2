/** What a window's preview transport needs from one connection's backend client. */
export type PreviewConnectionClient = {
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  previewTunnelUrl?: () => string;
};

/**
 * The backend of the connection a window's preview transport was created for,
 * never the window's current binding. A connection switch or a window close
 * moves or releases the window first and tears the old transport down after,
 * so its attachment releases must still reach the backend that issued them.
 *
 * `resolve` returns the connection's current client while some window holds
 * the connection (a token update replaces it). Once none does, the last client
 * seen keeps serving this transport's teardown.
 */
export function connectionPreviewBackend(resolve: () => PreviewConnectionClient | null): {
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  tunnelUrl(): string | null;
} {
  let last: PreviewConnectionClient | null = null;
  const client = () => {
    last = resolve() ?? last;
    return last;
  };
  return {
    invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
      const current = client();
      if (!current) return Promise.reject(new Error("The preview connection is not available."));
      return current.invoke<T>(command, args);
    },
    tunnelUrl() {
      return client()?.previewTunnelUrl?.() ?? null;
    },
  };
}

/** The part of a window's context that owns its previews. */
export type WindowPreviewRuntime<Manager, Transport> = {
  previewConnectionId: string;
  browserPreviewManager: Manager;
  previewTransport: Transport;
};

/**
 * A window's previews belong to the connection they were opened on. Once
 * anything moves the window to another connection (use, connect or forget),
 * they end, releasing on their own backend, and new ones use the new
 * connection's backend and partitions. Returns whether anything changed.
 */
export function rebindWindowPreviews<
  Manager extends { destroyAll(): void },
  Transport extends { disposeAll(): Promise<void> },
>(
  context: WindowPreviewRuntime<Manager, Transport>,
  connectionId: string,
  create: (connectionId: string) => { manager: Manager; previewTransport: Transport },
  logger: Pick<Console, "warn"> = console,
  force = false,
): boolean {
  if (!force && connectionId === context.previewConnectionId) return false;
  const next = create(connectionId);
  context.browserPreviewManager.destroyAll();
  void context.previewTransport.disposeAll().catch((error: unknown) => {
    logger.warn("[Previews] Failed to close preview transport:", error);
  });
  context.browserPreviewManager = next.manager;
  context.previewTransport = next.previewTransport;
  context.previewConnectionId = connectionId;
  return true;
}
