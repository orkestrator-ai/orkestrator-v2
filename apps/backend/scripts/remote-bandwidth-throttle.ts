import { connect, createServer, type Socket } from "node:net";

export interface Throttle {
  port: number;
  /** Queue, delayed write and destination writable buffer, across both directions. */
  bufferedBytes(): number;
  peakBufferedBytes(): number;
  close(): Promise<void>;
}

/** A bounded userspace link. Socket/kernel buffers add their own fixed bounds. */
export async function startThrottle(
  targetPort: number,
  rateKbps: number,
  latencyMs: number,
): Promise<Throttle> {
  const sockets = new Set<Socket>();
  const disposers = new Set<() => void>();
  const measurements = new Set<() => number>();
  let peak = 0;
  const bufferedBytes = () => [...measurements].reduce((sum, measure) => sum + measure(), 0);
  const sample = () => {
    peak = Math.max(peak, bufferedBytes());
  };
  const server = createServer((client) => {
    const upstream = connect(targetPort, "127.0.0.1");
    sockets.add(client);
    sockets.add(upstream);
    const cleanups: Array<() => void> = [];
    const forward = (source: Socket, target: Socket, bytesPerMs: number) => {
      const queue: Array<{ chunk: Buffer; availableAt: number }> = [];
      let queued = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let blocked = false;
      let nextSendAt = 0;
      const measure = () => queued + target.writableLength;
      measurements.add(measure);
      const pump = () => {
        if (timer || blocked || target.destroyed) return;
        const pending = queue[0];
        if (!pending) return;
        const { chunk, availableAt } = pending;
        const now = performance.now();
        const sendAt = Math.max(now, availableAt, nextSendAt);
        nextSendAt = sendAt + chunk.byteLength / bytesPerMs;
        // Keep the delayed chunk charged to the queue until write accepts it.
        timer = setTimeout(
          () => {
            timer = null;
            queue.shift();
            queued -= chunk.byteLength;
            blocked = !target.write(chunk);
            sample();
            if (blocked) source.pause();
            else pull();
            pump();
          },
          Math.max(0, sendAt - now),
        );
      };
      target.on("drain", () => {
        blocked = false;
        pull();
        pump();
      });
      // Read fixed slices in paused mode: a runtime may deliver a much larger
      // data chunk than the socket high-water mark in flowing mode.
      const pull = () => {
        while (!blocked && measure() < 64 * 1024 && source.readableLength > 0) {
          const chunk = source.read(Math.min(16 * 1024, source.readableLength)) as Buffer | null;
          if (!chunk) break;
          queue.push({ chunk, availableAt: performance.now() + latencyMs });
          queued += chunk.byteLength;
          sample();
        }
        pump();
      };
      source.on("readable", pull);
      cleanups.push(() => {
        if (timer) clearTimeout(timer);
        queue.length = 0;
        queued = 0;
        measurements.delete(measure);
      });
    };
    forward(client, upstream, Infinity);
    forward(upstream, client, rateKbps > 0 ? rateKbps / 8 : Infinity);
    const close = () => {
      for (const cleanup of cleanups) cleanup();
      disposers.delete(close);
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    disposers.add(close);
    client.on("close", close);
    upstream.on("close", close);
    client.on("error", close);
    upstream.on("error", close);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("Throttle did not bind");
  return {
    port: address.port,
    bufferedBytes,
    peakBufferedBytes: () => peak,
    close: async () => {
      for (const dispose of disposers) dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
