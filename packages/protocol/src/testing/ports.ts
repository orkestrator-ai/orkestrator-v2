/**
 * Port helpers for tests on a shared host.
 *
 * "Find a free port, release it, then bind it" races every other process on
 * the machine: production Orkestrator, other worktrees' suites and this
 * suite's own parallel workers all allocate ephemeral ports. Two ways out:
 *
 * - When the code under test can take an already-bound server, or binds port 0
 *   itself and reports what it got, nothing needs releasing: use
 *   `listenEphemeral` (or `Bun.serve({ port: 0 })`) and keep the server bound
 *   for the whole test. This is also how to hold a port taken on purpose.
 * - When the code under test must be given a fixed port number to bind later
 *   (a configured listener, a child process's flag), the gap cannot be closed.
 *   Pick the port inside `start` and wrap the whole start in
 *   `retryOnAddressInUse`, so a port lost to another process costs a retry
 *   with a fresh port instead of a failed test.
 */
import { createServer, type Server } from "node:net";

const ADDRESS_IN_USE_MESSAGES = [
  /\bEADDRINUSE\b/,
  /address already in use/i,
  // Bun.serve: "Failed to start server. Is port 4321 in use?"
  /\bIs port \d+ in use\?/i,
];

/**
 * Whether `error` reports a port already taken: `code === "EADDRINUSE"` (Node
 * `net`/`http`, `Bun.serve`, `Bun.listen`) or one of the message forms Bun and
 * Node use when a wrapper has dropped the code.
 */
export function isAddressInUseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "EADDRINUSE") return true;
  if (typeof message !== "string") return false;
  return ADDRESS_IN_USE_MESSAGES.some((pattern) => pattern.test(message));
}

export type RetryOnAddressInUseOptions = {
  /** Total calls to `start`, including the first. Default 5. */
  attempts?: number;
};

/**
 * Calls `start` until it resolves, retrying only when it rejects because a
 * port was already in use. Any other rejection is rethrown at once, and the
 * last EADDRINUSE is rethrown once `attempts` calls have failed.
 *
 * `start` must choose its port afresh on every call (it receives the 1-based
 * attempt number) and must release anything it bound before rejecting;
 * retrying the same lost port only fails again.
 */
export async function retryOnAddressInUse<T>(
  start: (attempt: number) => Promise<T>,
  { attempts = 5 }: RetryOnAddressInUseOptions = {},
): Promise<T> {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError(`retryOnAddressInUse needs at least one attempt, got ${attempts}`);
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await start(attempt);
    } catch (error) {
      if (!isAddressInUseError(error) || attempt >= attempts) throw error;
    }
  }
}

export type EphemeralListener<S extends Server> = {
  server: S;
  port: number;
  /** Stops listening; resolves once the server has closed. */
  close: () => Promise<void>;
};

/**
 * Binds `server` (a new `net` server by default; an `http` server works too)
 * to port 0 on `host` and resolves with the port the OS chose. The server stays
 * bound until `close` is called, so no other process can take the port.
 */
export async function listenEphemeral<S extends Server = Server>(
  server: S = createServer() as S,
  host = "127.0.0.1",
): Promise<EphemeralListener<S>> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null || !address.port) {
    server.close();
    throw new Error("listenEphemeral: the server reported no bound port");
  }
  return {
    server,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
