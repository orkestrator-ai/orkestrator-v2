/**
 * Bounded channel startup for `terminal-input-results-probe-page.ts`. Kept
 * free of DOM and renderer imports so its failure paths can be tested without
 * a browser.
 *
 * The renderer's terminal client retries a refused upgrade for ever, and a
 * refused subscription settles `ready()` without a channel, so neither ever
 * reports the channel ready. Without a deadline the probe would wait on that
 * route indefinitely, never reach the other routes or engines, and never
 * reach its cleanup.
 */

/** How long a page waits for its terminal channel before reporting the route failed. */
export const CHANNEL_STARTUP_TIMEOUT_MS = 15_000;

/** The client calls startup makes; the real client is a `TerminalWebSocketClient`. */
export type StartupClient = {
  ready(sessionId: string): Promise<void>;
  observeSnapshot(sessionId: string, snapshot: { generation: number; revision: number }): void;
  dispose(): void;
};

export type StartupStage = "socket" | "channel";

/** Content-free counters reported with a failed startup. */
export type StartupDiagnostics = {
  socketCloses: number;
  fallbackRequired: number;
};

export class ChannelStartupError extends Error {
  constructor(
    readonly stage: StartupStage,
    readonly timeoutMs: number,
    readonly diagnostics: StartupDiagnostics,
  ) {
    super(
      `Terminal channel startup failed at the ${stage} stage: not ready within ${timeoutMs} ms ` +
        `(socket closes ${diagnostics.socketCloses}, fallbacks ${diagnostics.fallbackRequired})`,
    );
    this.name = "ChannelStartupError";
  }
}

/**
 * Wait until `client` has a ready socket and `channelReady` has settled, or
 * fail after `timeoutMs`. On failure the client is disposed, so its retries
 * stop, and the error names the stage that did not finish.
 */
export async function startChannel(
  client: StartupClient,
  sessionId: string,
  channelReady: Promise<void>,
  options: { timeoutMs: number; diagnostics: () => StartupDiagnostics },
): Promise<void> {
  let stage: StartupStage = "socket";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), options.timeoutMs);
  });
  const work = (async () => {
    await client.ready(sessionId);
    stage = "channel";
    client.observeSnapshot(sessionId, { generation: 1, revision: 0 });
    await channelReady;
    return "ready" as const;
  })();
  try {
    const outcome = await Promise.race([work, expired]);
    if (outcome === "expired") {
      // The abandoned wait may still settle (a disposed client resolves its
      // ready promise); nothing reads it, but it must not reject unhandled.
      work.catch(() => undefined);
      throw new ChannelStartupError(stage, options.timeoutMs, options.diagnostics());
    }
  } catch (error) {
    client.dispose();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
