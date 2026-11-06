import { describe, expect, test } from "bun:test";
import {
  encodeData,
  encodeFrame,
  FRAME_CLOSE,
  FRAME_DATA,
  FRAME_OPEN,
  createHostRelay,
  createContainerRelay,
  FrameDecoder,
  MAX_FRAME_PAYLOAD,
  SocketWriter,
} from "./container-agent-tools-relay";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe("container agent-tools relay framing", () => {
  test("frames survive a stream split at every byte", () => {
    const stream = new Uint8Array([
      ...encodeFrame(FRAME_OPEN, 7),
      ...encodeFrame(FRAME_DATA, 7, bytes("POST /mcp")),
      ...encodeFrame(FRAME_CLOSE, 7),
    ]);
    for (let split = 0; split <= stream.byteLength; split += 1) {
      const decoder = new FrameDecoder();
      const frames = [
        ...decoder.push(stream.subarray(0, split)),
        ...decoder.push(stream.subarray(split)),
      ];
      expect(frames.map((frame) => [frame.type, frame.id, text(frame.payload)])).toEqual([
        [FRAME_OPEN, 7, ""],
        [FRAME_DATA, 7, "POST /mcp"],
        [FRAME_CLOSE, 7, ""],
      ]);
    }
  });

  test("large writes are split into bounded frames and rejoin in order", () => {
    const data = new Uint8Array(MAX_FRAME_PAYLOAD * 2 + 5).map((_, index) => index % 251);
    const frames = encodeData(3, data);
    expect(frames).toHaveLength(3);
    const decoder = new FrameDecoder();
    const payloads = frames.flatMap((frame) => decoder.push(frame)).map((frame) => frame.payload);
    expect(Buffer.concat(payloads).equals(Buffer.from(data))).toBe(true);
  });

  test("an oversized frame is refused rather than buffered", () => {
    expect(() => encodeFrame(FRAME_DATA, 1, new Uint8Array(MAX_FRAME_PAYLOAD + 1))).toThrow();
    const header = encodeFrame(FRAME_DATA, 1);
    new DataView(header.buffer).setUint32(5, MAX_FRAME_PAYLOAD + 1);
    expect(() => new FrameDecoder().push(header)).toThrow("frame payload too large");
  });

  test("a short socket write keeps the rest until drain, and end waits for it", () => {
    const written: string[] = [];
    let capacity = 3;
    let ended = false;
    const writer = new SocketWriter({
      write(data) {
        const accepted = Math.min(capacity, data.byteLength);
        written.push(text(data.subarray(0, accepted)));
        capacity -= accepted;
        return accepted;
      },
      end() {
        ended = true;
      },
    });
    writer.write(bytes("hello"));
    writer.write(bytes(" world"));
    writer.end();
    expect(written.join("")).toBe("hel");
    expect(ended).toBe(false);
    capacity = 100;
    writer.drain();
    expect(written.join("")).toBe("hello world");
    expect(ended).toBe(true);
  });
});

describe("relay connection lifecycle", () => {
  const frame = (type: number, id = 1, payload = new Uint8Array(0)) => ({ type, id, payload });
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  test("a failed host connect sends one close and tolerates queued data", async () => {
    const sent: Uint8Array[] = [];
    const receive = createHostRelay({ write: (data) => sent.push(data) }, async () => {
      throw new Error("fixture connection refused");
    });
    receive(frame(FRAME_OPEN));
    receive(frame(FRAME_DATA, 1, bytes("queued")));
    await flush();
    expect(new FrameDecoder().push(Buffer.concat(sent))).toEqual([frame(FRAME_CLOSE)]);
  });

  test("host queues data in order until connect and never echoes a peer close", async () => {
    const sent: Uint8Array[] = [];
    const writes: string[] = [];
    let ended = false;
    type Handlers = Parameters<Parameters<typeof createHostRelay>[1]>[0];
    let handlers!: Handlers;
    let resolve!: (socket: { write(data: Uint8Array): number; end(): void }) => void;
    const receive = createHostRelay({ write: (data) => sent.push(data) }, (callbacks) => {
      handlers = callbacks;
      return new Promise((done) => {
        resolve = done;
      });
    });
    receive(frame(FRAME_OPEN));
    receive(frame(FRAME_DATA, 1, bytes("one")));
    receive(frame(FRAME_DATA, 1, bytes("two")));
    receive(frame(FRAME_CLOSE));
    expect(writes).toEqual([]);
    resolve({
      write(data) {
        writes.push(text(data));
        return data.byteLength;
      },
      end() {
        ended = true;
        handlers.close();
      },
    });
    await flush();
    expect(writes).toEqual(["one", "two"]);
    expect(ended).toBe(true);
    expect(sent).toEqual([]);
  });

  test("host sends a local close only once", async () => {
    const sent: Uint8Array[] = [];
    let close!: () => void;
    const receive = createHostRelay({ write: (data) => sent.push(data) }, async (handlers) => {
      close = handlers.close;
      return { write: (data) => data.byteLength, end() {} };
    });
    receive(frame(FRAME_OPEN));
    await flush();
    close();
    close();
    expect(new FrameDecoder().push(Buffer.concat(sent))).toEqual([frame(FRAME_CLOSE)]);
  });

  for (const peerClose of [false, true]) {
    test(`container ${peerClose ? "does not echo peer" : "sends local"} close`, () => {
      const sent: Uint8Array[] = [];
      const writes: string[] = [];
      let ended = false;
      const relay = createContainerRelay({ write: (data) => sent.push(data) });
      const socket = {
        data: undefined,
        write(data: Uint8Array) {
          writes.push(text(data));
          return data.byteLength;
        },
        end() {
          ended = true;
        },
      } as unknown as Bun.Socket<{ id: number; writer: SocketWriter }>;
      relay.socket.open!(socket);
      relay.socket.data!(socket, Buffer.from("out"));
      relay.receive(frame(FRAME_DATA, 1, bytes("in")));
      expect(writes).toEqual(["in"]);
      if (peerClose) relay.receive(frame(FRAME_CLOSE));
      relay.socket.close!(socket, undefined);
      relay.socket.close!(socket, undefined);
      expect(ended).toBe(peerClose);
      expect(new FrameDecoder().push(Buffer.concat(sent))).toEqual([
        frame(FRAME_OPEN),
        frame(FRAME_DATA, 1, bytes("out")),
        ...(peerClose ? [] : [frame(FRAME_CLOSE)]),
      ]);
    });
  }
});
