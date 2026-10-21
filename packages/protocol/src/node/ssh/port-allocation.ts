import net from "node:net";

/**
 * Bounded attempts to win the probe/release/bind race (SH-05): another process
 * can take the port between our release and ssh's bind, so the supervisor
 * retries with a fresh port when ssh reports a bind failure. `-L 0` is not
 * used because its allocation is not portable across OpenSSH builds.
 */
export const MAX_PORT_ALLOCATION_ATTEMPTS = 3;

/** Pick an ephemeral loopback port by binding 127.0.0.1:0 and releasing it. */
export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("No port allocated."))));
    });
  });
}

/**
 * - `refused`: nothing accepts on the port yet.
 * - `open`: a connection was accepted and stayed open through the settle window.
 * - `closed`: a connection was accepted and then closed by the far side (for an
 *   SSH forward: the remote end refused or denied the channel).
 */
export type ForwardProbeResult = "refused" | "open" | "closed";

export function probeLoopbackForward(
  port: number,
  options: { settleMs?: number; connectTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ForwardProbeResult> {
  const settleMs = options.settleMs ?? 400;
  const connectTimeoutMs = options.connectTimeoutMs ?? 1_000;
  return new Promise((resolve) => {
    let settled = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (result: ForwardProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (settleTimer) clearTimeout(settleTimer);
      options.signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(result);
    };
    const onAbort = () => finish("refused");
    const connectTimer = setTimeout(() => finish("refused"), connectTimeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      clearTimeout(connectTimer);
      settleTimer = setTimeout(() => finish("open"), settleMs);
    });
    socket.on("data", () => undefined);
    socket.once("error", () => finish(settleTimer ? "closed" : "refused"));
    socket.once("close", () => finish(settleTimer ? "closed" : "refused"));
  });
}
