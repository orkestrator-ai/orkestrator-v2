import { describe, expect, test } from "bun:test";
import {
  encodeData,
  encodeFrame,
  FRAME_CLOSE,
  FRAME_DATA,
  FRAME_OPEN,
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
