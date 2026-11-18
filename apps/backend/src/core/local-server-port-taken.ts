import type { Readable } from "node:stream";

/**
 * A local server lost its port between allocation and bind.
 *
 * `allocateLocalPort()` binds port 0, reads the port and closes the listener
 * before the server is spawned on it, so another process on the host can take
 * the port in that gap. The server then either fails to bind ("Is port N in
 * use?") or, worse, the health probe reaches the other process's server and
 * reports ours healthy. Both are retried on a fresh port by
 * `startLocalServerUnlocked`; anything else is a real startup failure.
 */
export class LocalServerPortTakenError extends Error {
  constructor(
    readonly port: number,
    reason: "bind-failed" | "foreign-server",
  ) {
    super(
      reason === "bind-failed"
        ? `Port ${port} was taken before the server could bind it`
        : `Port ${port} is answered by a different server`,
    );
    this.name = "LocalServerPortTakenError";
  }
}

/** How many starts one request may make before a lost port is a failure. */
export const LOCAL_SERVER_PORT_ATTEMPTS = 3;

/** Bun's bind failure (`Is port N in use?`) and Node's (`EADDRINUSE`). */
const PORT_IN_USE_PATTERN = /Is port \d+ in use\?|EADDRINUSE/;
/** Long enough to hold the pattern across a chunk boundary. */
const TAIL_CHARS = 64;
/** How long an exited child's output may take to drain before it is judged. */
const OUTPUT_DRAIN_MS = 250;

/**
 * Watch a child's stdout and stderr for a bind failure. The text is matched
 * and discarded; nothing is retained beyond a short tail per stream.
 */
export function watchForPortInUse(
  streams: ReadonlyArray<Readable | null | undefined>,
  onSeen: () => void,
): {
  readonly seen: () => boolean;
  /** Resolves once every stream has ended, or after a short bound. */
  readonly drained: () => Promise<void>;
  readonly stop: () => void;
} {
  let seen = false;
  const detachers: Array<() => void> = [];
  for (const stream of streams) {
    if (!stream) continue;
    let tail = "";
    const onData = (chunk: Buffer | string) => {
      if (seen) return;
      const text = tail + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      if (PORT_IN_USE_PATTERN.test(text)) {
        seen = true;
        onSeen();
        return;
      }
      tail = text.slice(-TAIL_CHARS);
    };
    stream.on("data", onData);
    detachers.push(() => stream.off("data", onData));
  }
  return {
    seen: () => seen,
    drained: () => drainStreams(streams),
    stop: () => {
      for (const detach of detachers.splice(0)) detach();
    },
  };
}

function drainStreams(streams: ReadonlyArray<Readable | null | undefined>): Promise<void> {
  const open = streams.filter(
    (stream): stream is Readable => Boolean(stream) && !stream!.readableEnded && !stream!.destroyed,
  );
  if (open.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let remaining = open.length;
    const listeners: Array<() => void> = [];
    const finish = () => {
      clearTimeout(timer);
      for (const remove of listeners.splice(0)) remove();
      resolve();
    };
    // A grandchild that inherited the pipe can hold it open; the bound keeps
    // an exited child from waiting on it.
    const timer = setTimeout(finish, OUTPUT_DRAIN_MS);
    for (const stream of open) {
      const onEnd = () => {
        remaining -= 1;
        if (remaining === 0) finish();
      };
      stream.once("end", onEnd);
      stream.once("close", onEnd);
      listeners.push(() => {
        stream.off("end", onEnd);
        stream.off("close", onEnd);
      });
    }
  });
}

/**
 * Whether the server on `port` refuses this start's own token: `true` only on
 * an explicit 401 from `/global/auth-check`, which every bridge serves behind
 * its token. Any other answer, including a 404 from a bridge without the
 * route and a probe that fails outright, is not evidence of another server.
 */
export async function refusesOwnToken(
  port: number,
  headers: Record<string, string>,
  timeoutMs = 2_000,
): Promise<boolean> {
  const http = await import("node:http");
  return new Promise((resolve) => {
    let settled = false;
    const complete = (refused: boolean) => {
      if (settled) return;
      settled = true;
      resolve(refused);
    };
    const request = http.get(
      { host: "127.0.0.1", port, path: "/global/auth-check", timeout: timeoutMs, headers },
      (response) => {
        response.resume();
        complete(response.statusCode === 401);
      },
    );
    request.on("timeout", () => {
      request.destroy();
      complete(false);
    });
    request.on("error", () => complete(false));
  });
}
