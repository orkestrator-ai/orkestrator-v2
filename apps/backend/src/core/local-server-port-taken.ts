import type { Readable } from "node:stream";
import { isHealthyHttpResponse } from "./commands-server-health.js";

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
 * Match binding diagnostics and the exact listening line on the child's own
 * output. Keep only short partial lines and tails between chunks.
 */
export function watchLocalServerOutput(
  streams: ReadonlyArray<Readable | null | undefined>,
  onSeen: () => void,
  readyLine?: string,
): {
  readonly seen: () => boolean;
  readonly ready: () => boolean;
  /** Resolves once every stream has ended, or after a short bound. */
  readonly drained: () => Promise<void>;
  readonly stop: () => void;
} {
  let seen = false;
  let ready = false;
  const detachers: Array<() => void> = [];
  for (const stream of streams) {
    if (!stream) continue;
    let tail = "";
    let line = "";
    let truncatedLine = false;
    const onData = (chunk: Buffer | string) => {
      if (seen) return;
      const output = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const text = tail + output;
      if (PORT_IN_USE_PATTERN.test(text)) {
        seen = true;
        onSeen();
        return;
      }
      tail = text.slice(-TAIL_CHARS);
      if (!readyLine || ready) return;
      const lines = (line + output).split("\n");
      line = lines.pop() ?? "";
      for (const [index, completed] of lines.entries()) {
        if ((index > 0 || !truncatedLine) && completed.trimEnd() === readyLine) {
          ready = true;
          return;
        }
      }
      if (lines.length) truncatedLine = false;
      if (line.length > TAIL_CHARS * 2) {
        line = "";
        truncatedLine = true;
      }
    };
    stream.on("data", onData);
    detachers.push(() => stream.off("data", onData));
  }
  return {
    seen: () => seen,
    ready: () => ready,
    drained: () => drainStreams(streams),
    stop: () => {
      for (const detach of detachers.splice(0)) detach();
    },
  };
}

function drainStreams(streams: ReadonlyArray<Readable | null | undefined>): Promise<void> {
  const open = streams.filter(
    (stream): stream is Readable => stream != null && !stream.readableEnded && !stream.destroyed,
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
      const remove = () => {
        stream.off("end", onEnd);
        stream.off("close", onEnd);
      };
      const onEnd = () => {
        remove();
        remaining -= 1;
        if (remaining === 0) finish();
      };
      stream.once("end", onEnd);
      stream.once("close", onEnd);
      listeners.push(remove);
    }
  });
}

/** A missing legacy route is distinct from both successful auth and a failed probe. */
export async function probeLocalBridgeAuth(
  port: number,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<"accepted" | "refused" | "unsupported" | "unavailable"> {
  const http = await import("node:http");
  return new Promise((resolve) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/global/auth-check", timeout: 2_000, headers, signal },
      (response) => {
        response.resume();
        const status = response.statusCode;
        if (status === 401) resolve("refused");
        else if (status === 404 || status === 405) resolve("unsupported");
        else if (isHealthyHttpResponse(status, response.headers["content-type"]))
          resolve("accepted");
        else resolve("unavailable");
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve("unavailable");
    });
    request.once("error", () => resolve("unavailable"));
  });
}
