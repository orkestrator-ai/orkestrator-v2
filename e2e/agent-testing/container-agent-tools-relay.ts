/**
 * QA relay that carries a fixture container's agent-tools traffic to the
 * profile's backend over `docker exec` stdio, for Linux hosts whose input
 * firewall drops TCP from Docker's ranges to the profile's agent tools port
 * (todo 7080). No host firewall or network change: the host half connects to
 * the backend on loopback, which the agent-tools peer filter admits, and the
 * container half listens inside the container on `--listen` (default
 * `127.0.0.1`). The backend rewrites a changed `host.docker.internal` entry at
 * every bridge start, so the caller instead redirects the alias's address to
 * the listener inside the fixture's own network namespace, from its egress
 * gateway (todo 0190 task 3, recorded in todo 7360):
 *
 *   iptables -t nat -I OUTPUT 1 -d <alias address> -p tcp --dport <port> \
 *     -j DNAT --to-destination <container address>:<port>
 *
 *   bun container-agent-tools-relay.ts host --container <id> --port <agent tools port> \
 *     [--listen <container address>]
 *
 * The host half copies this file into the container, runs the container half
 * there (`docker exec -i … bun <copy> container --port <port>`) and
 * multiplexes every accepted connection over that one stdio pair. No imports
 * beyond Bun and node built-ins, so the same file runs in the image. It logs
 * nothing about the bytes it carries.
 *
 * Frame: 1 byte type, 4 bytes connection id, 4 bytes length, then payload.
 */

export const FRAME_OPEN = 1;
export const FRAME_DATA = 2;
export const FRAME_CLOSE = 3;
const HEADER_BYTES = 9;
/** Bounds one frame; larger writes are split. */
export const MAX_FRAME_PAYLOAD = 64 * 1024;

export function encodeFrame(type: number, id: number, payload?: Uint8Array): Uint8Array {
  const body = payload ?? new Uint8Array(0);
  if (body.byteLength > MAX_FRAME_PAYLOAD) throw new Error("frame payload too large");
  const frame = new Uint8Array(HEADER_BYTES + body.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, type);
  view.setUint32(1, id);
  view.setUint32(5, body.byteLength);
  frame.set(body, HEADER_BYTES);
  return frame;
}

/** Splits data into frames no larger than {@link MAX_FRAME_PAYLOAD}. */
export function encodeData(id: number, data: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < data.byteLength; offset += MAX_FRAME_PAYLOAD) {
    frames.push(encodeFrame(FRAME_DATA, id, data.subarray(offset, offset + MAX_FRAME_PAYLOAD)));
  }
  return frames;
}

export type Frame = { type: number; id: number; payload: Uint8Array };

/** Incremental frame decoder for a byte stream that arrives in arbitrary chunks. */
export class FrameDecoder {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const joined = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.byteLength);
    const frames: Frame[] = [];
    let offset = 0;
    while (joined.byteLength - offset >= HEADER_BYTES) {
      const view = new DataView(joined.buffer, joined.byteOffset + offset);
      const length = view.getUint32(5);
      if (length > MAX_FRAME_PAYLOAD) throw new Error("frame payload too large");
      if (joined.byteLength - offset < HEADER_BYTES + length) break;
      frames.push({
        type: view.getUint8(0),
        id: view.getUint32(1),
        payload: joined.slice(offset + HEADER_BYTES, offset + HEADER_BYTES + length),
      });
      offset += HEADER_BYTES + length;
    }
    this.buffer = joined.slice(offset);
    return frames;
  }
}

type Writable = { write(data: Uint8Array): unknown };
type RelaySocket = { write(data: Uint8Array): number; end(): void };

/**
 * Writes to a Bun socket without losing the part a short write leaves over:
 * the rest is queued and flushed from the socket's `drain` handler.
 */
export class SocketWriter {
  private pending: Uint8Array[] = [];
  private ending = false;

  constructor(private readonly socket: RelaySocket) {}

  write(data: Uint8Array): void {
    if (this.pending.length > 0) {
      this.pending.push(data);
      return;
    }
    const written = this.socket.write(data);
    if (written < data.byteLength) this.pending.push(data.subarray(Math.max(0, written)));
  }

  drain(): void {
    while (this.pending.length > 0) {
      const next = this.pending[0]!;
      const written = this.socket.write(next);
      if (written < next.byteLength) {
        this.pending[0] = next.subarray(Math.max(0, written));
        return;
      }
      this.pending.shift();
    }
    if (this.ending) this.socket.end();
  }

  end(): void {
    this.ending = true;
    if (this.pending.length === 0) this.socket.end();
  }
}

/** Container half: accepts on loopback and forwards every connection to stdout. */
function runContainerHalf(port: number, listen: string): void {
  const out: Writable = { write: (data) => process.stdout.write(data) };
  const relay = createContainerRelay(out);
  const decoder = new FrameDecoder();
  process.stdin.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(new Uint8Array(chunk))) relay.receive(frame);
  });
  process.stdin.on("end", () => process.exit(0));
  Bun.listen({ hostname: listen, port, socket: relay.socket });
}

/** Container socket callbacks and inbound frames, without owning process IO. */
export function createContainerRelay(out: Writable) {
  const sockets = new Map<number, SocketWriter>();
  let nextId = 1;
  const receive = (frame: Frame) => {
    const socket = sockets.get(frame.id);
    if (frame.type === FRAME_DATA) socket?.write(frame.payload);
    if (frame.type === FRAME_CLOSE) {
      sockets.delete(frame.id);
      socket?.end();
    }
  };
  const socket: Bun.SocketHandler<{ id: number; writer: SocketWriter }> = {
    open(socket) {
      socket.data = { id: nextId++, writer: new SocketWriter(socket) };
      sockets.set(socket.data.id, socket.data.writer);
      out.write(encodeFrame(FRAME_OPEN, socket.data.id));
    },
    data(socket, data) {
      for (const frame of encodeData(socket.data.id, new Uint8Array(data))) out.write(frame);
    },
    drain(socket) {
      socket.data.writer.drain();
    },
    close(socket) {
      if (sockets.delete(socket.data.id)) out.write(encodeFrame(FRAME_CLOSE, socket.data.id));
    },
  };
  return { receive, socket };
}

type HostHandlers = {
  data(socket: RelaySocket, data: Uint8Array): void;
  drain(): void;
  close(): void;
  error(): void;
};

/** Frame handling shared by the host runner and deterministic lifecycle tests. */
export function createHostRelay(
  toContainer: Writable,
  connect: (handlers: HostHandlers) => Promise<RelaySocket>,
): (frame: Frame) => void {
  const sockets = new Map<number, Promise<SocketWriter | null>>();
  return (frame) => {
    if (frame.type === FRAME_OPEN) {
      const id = frame.id;
      let writer: SocketWriter | undefined;
      sockets.set(
        id,
        connect({
          data(_socket, data) {
            for (const out of encodeData(id, new Uint8Array(data))) toContainer.write(out);
          },
          drain() {
            writer?.drain();
          },
          close() {
            if (sockets.delete(id)) toContainer.write(encodeFrame(FRAME_CLOSE, id));
          },
          error() {},
        })
          .then((socket) => (writer = new SocketWriter(socket)))
          .catch(() => {
            sockets.delete(id);
            toContainer.write(encodeFrame(FRAME_CLOSE, id));
            return null;
          }),
      );
    } else if (frame.type === FRAME_DATA) {
      const payload = frame.payload;
      void sockets.get(frame.id)?.then((socket) => socket?.write(payload));
    } else if (frame.type === FRAME_CLOSE) {
      const pending = sockets.get(frame.id);
      sockets.delete(frame.id);
      void pending?.then((socket) => socket?.end());
    }
  };
}

/** Host half: runs the container half and dials the backend on loopback per connection. */
async function runHostHalf(container: string, port: number, listen: string): Promise<void> {
  const copy = "/tmp/orkestrator-qa-agent-tools-relay.ts";
  const install = Bun.spawn(
    ["docker", "exec", "-i", "--user", "node", container, "sh", "-c", `cat > ${copy}`],
    { stdin: Bun.file(import.meta.path), stdout: "ignore", stderr: "inherit" },
  );
  if ((await install.exited) !== 0) throw new Error("could not copy the relay into the container");
  const child = Bun.spawn(
    [
      "docker",
      "exec",
      "-i",
      "--user",
      "node",
      container,
      "bun",
      copy,
      "container",
      "--port",
      String(port),
      "--listen",
      listen,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  const toContainer: Writable = {
    write: (data) => {
      child.stdin.write(data);
      child.stdin.flush();
    },
  };
  const receive = createHostRelay(toContainer, (socket) =>
    Bun.connect({ hostname: "127.0.0.1", port, socket }),
  );
  const decoder = new FrameDecoder();
  const shutdown = () => {
    child.kill();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  for await (const chunk of child.stdout) {
    for (const frame of decoder.push(chunk)) receive(frame);
  }
  process.exit((await child.exited) ?? 1);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
  const mode = process.argv[2];
  const port = Number(argument("--port"));
  if (!Number.isInteger(port) || port <= 0) throw new Error("--port is required");
  const listen = argument("--listen") ?? "127.0.0.1";
  if (mode === "container") {
    runContainerHalf(port, listen);
  } else if (mode === "host") {
    const container = argument("--container");
    if (!container) throw new Error("--container is required");
    await runHostHalf(container, port, listen);
  } else {
    throw new Error("usage: container-agent-tools-relay.ts host|container --port <n>");
  }
}
