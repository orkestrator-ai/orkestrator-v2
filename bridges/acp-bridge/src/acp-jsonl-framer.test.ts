import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { JsonlLineFramer, type JsonlFrameFailure } from "./acp-jsonl-framer.js";

const LIMIT = 256;
/** `MAX_LINE_BYTES`, written out so a changed limit fails the probe test below. */
const REAL_LIMIT = 4 * 1024 * 1024;

type Outcome = { lines: string[]; failure?: JsonlFrameFailure };

function frameAll(chunks: readonly Buffer[]): Outcome {
  const framer = new JsonlLineFramer(LIMIT);
  const lines: string[] = [];
  for (const chunk of chunks) {
    const failure = framer.accept(chunk, (line) => lines.push(line));
    if (failure) return { lines, failure };
  }
  return { lines };
}

/** The loop this framer replaced, kept verbatim as the behaviour it must match. */
function frameAllAsBefore(chunks: readonly Buffer[]): Outcome {
  let buffer = Buffer.alloc(0);
  const lines: string[] = [];
  for (const chunk of chunks) {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > LIMIT) return { lines, failure: "oversized" };
      const line = buffer.subarray(0, newline).toString("utf8");
      buffer = buffer.subarray(newline + 1);
      lines.push(line);
    }
    if (buffer.length > LIMIT) return { lines, failure: "unterminated-oversized" };
  }
  return { lines };
}

function randomStream(random: () => number): Buffer {
  const pieces: string[] = [];
  const count = 1 + Math.floor(random() * 8);
  for (let index = 0; index < count; index += 1) {
    const length = Math.floor(random() * LIMIT * 1.2);
    // Multibyte text, so a chunk boundary lands inside a character.
    pieces.push("é🙂a".repeat(Math.ceil(length / 7)).slice(0, length));
    if (random() < 0.9) pieces.push("\n");
  }
  return Buffer.from(pieces.join(""));
}

function randomChunks(stream: Buffer, random: () => number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let at = 0; at < stream.length;) {
    const length = 1 + Math.floor(random() * 90);
    chunks.push(stream.subarray(at, at + length));
    at += length;
  }
  return chunks;
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("JsonlLineFramer", () => {
  test("gives the old loop's lines and verdict for any chunking", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const random = seeded(seed);
      const chunks = randomChunks(randomStream(random), random);
      expect(frameAll(chunks)).toEqual(frameAllAsBefore(chunks));
    }
  });

  test("joins a character split across chunks", () => {
    const text = Buffer.from("🙂\n");
    const { lines } = frameAll([text.subarray(0, 2), text.subarray(2)]);
    expect(lines).toEqual(["🙂"]);
  });

  test("a chunk with several frames and a partial tail keeps the tail", () => {
    const { lines } = frameAll([Buffer.from("one\ntwo\nthr"), Buffer.from("ee\n")]);
    expect(lines).toEqual(["one", "two", "three"]);
  });

  test("a terminated frame fails only past the limit", () => {
    const atLimit = Buffer.from(`${"a".repeat(LIMIT)}\n`);
    expect(frameAll([atLimit.subarray(0, 100), atLimit.subarray(100)])).toEqual({
      lines: ["a".repeat(LIMIT)],
    });
    const over = Buffer.from(`${"a".repeat(LIMIT + 1)}\n`);
    expect(frameAll([over.subarray(0, 100), over.subarray(100)]).failure).toBe("oversized");
  });

  test("an unterminated frame fails as soon as it is over the limit", () => {
    expect(frameAll([Buffer.alloc(LIMIT, 97)])).toEqual({ lines: [] });
    expect(frameAll([Buffer.alloc(LIMIT, 97), Buffer.from("a")]).failure).toBe(
      "unterminated-oversized",
    );
  });

  test("frames finished earlier in the chunk still arrive before a failure", () => {
    const stream = Buffer.from(`ok\n${"a".repeat(LIMIT + 1)}\n`);
    expect(frameAll([stream])).toEqual({ lines: ["ok"], failure: "oversized" });
  });
});

describe("JsonlLineFramer at the bridge's frame limit", () => {
  function pieces(bytes: Buffer, pieceBytes: number): Buffer[] {
    const chunks: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += pieceBytes) {
      chunks.push(bytes.subarray(at, at + pieceBytes));
    }
    return chunks;
  }

  function accept(chunks: readonly Buffer[]): { bytes: number[]; failure?: JsonlFrameFailure } {
    const framer = new JsonlLineFramer(REAL_LIMIT);
    const bytes: number[] = [];
    for (const chunk of chunks) {
      const failure = framer.accept(chunk, (line) => bytes.push(line.length));
      if (failure) return { bytes, failure };
    }
    return { bytes };
  }

  test("a terminated line closes one byte past the limit, however it was split", () => {
    for (const pieceBytes of [4 * 1024, 64 * 1024, REAL_LIMIT + 2]) {
      const atLimit = Buffer.alloc(REAL_LIMIT + 1, 97);
      atLimit[REAL_LIMIT] = 0x0a;
      expect(accept(pieces(atLimit, pieceBytes))).toEqual({ bytes: [REAL_LIMIT] });
    }
    // The newline shares a chunk with the last byte, so only the terminated
    // check can see this line.
    const held = Buffer.alloc(REAL_LIMIT, 97);
    expect(accept([held, Buffer.from("a\n")])).toEqual({ bytes: [], failure: "oversized" });
    const whole = Buffer.alloc(REAL_LIMIT + 2, 97);
    whole[REAL_LIMIT + 1] = 0x0a;
    expect(accept([whole])).toEqual({ bytes: [], failure: "oversized" });
  });

  test("an unterminated line closes one byte past the limit, however it was split", () => {
    for (const pieceBytes of [4 * 1024, 64 * 1024, REAL_LIMIT + 1]) {
      const over = Buffer.alloc(REAL_LIMIT + 1, 97);
      expect(accept(pieces(over, pieceBytes))).toEqual({
        bytes: [],
        failure: "unterminated-oversized",
      });
    }
    expect(accept(pieces(Buffer.alloc(REAL_LIMIT, 97), 64 * 1024))).toEqual({ bytes: [] });
  });

  test("copies and searches each byte of a frame once, whatever the chunk size", () => {
    const concat = Buffer.concat;
    const indexOf = Buffer.prototype.indexOf;
    let copiedBytes = 0;
    let searchedBytes = 0;
    Buffer.concat = ((list: readonly Uint8Array[], totalLength?: number) => {
      const joined = concat(list, totalLength);
      copiedBytes += joined.length;
      return joined;
    }) as typeof Buffer.concat;
    Buffer.prototype.indexOf = function (this: Buffer, value: number, from?: number) {
      searchedBytes += this.length - (from ?? 0);
      return indexOf.call(this, value, from);
    } as typeof Buffer.prototype.indexOf;
    const frame = Buffer.alloc(REAL_LIMIT + 1, 97);
    frame[REAL_LIMIT] = 0x0a;
    const chunks = pieces(frame, 1024);
    let outcome: ReturnType<typeof accept>;
    try {
      outcome = accept(chunks);
    } finally {
      Buffer.concat = concat;
      Buffer.prototype.indexOf = indexOf;
    }
    expect(outcome).toEqual({ bytes: [REAL_LIMIT] });
    expect(copiedBytes).toBe(REAL_LIMIT);
    // The search after the newline starts past it, so it adds nothing.
    expect(searchedBytes).toBe(REAL_LIMIT + 1);
  });
});

describe("AcpProcess stdout", () => {
  test("closes at the same frame size for a terminated and an unterminated line", () => {
    const probe = spawnSync(
      process.execPath,
      [resolve(import.meta.dir, "testing/stdout-frame-limit-probe.ts")],
      {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, NODE_ENV: "test" },
      },
    );
    expect(probe.status).toBe(0);
    const result = JSON.parse(probe.stdout.trim().split("\n").at(-1)!);
    expect(result.limit).toBe(REAL_LIMIT);
    const frameOverhead = '{"jsonrpc":"2.0","id":1,"result":{"text":""}}'.length;
    const answeredBytes = REAL_LIMIT - frameOverhead;
    expect(result.terminatedAtLimit).toEqual({ answeredBytes, closedAfter: false });
    // At the limit with no newline yet stays open until the newline arrives.
    expect(result.newlineAfterLimit).toEqual({ answeredBytes, closedAfter: false });
    expect(result.terminatedOverLimit).toEqual({
      error: "framing ACP emitted an oversized JSONL frame",
      closedAfter: true,
    });
    expect(result.unterminatedOverLimit).toEqual({
      error: "framing ACP emitted an unterminated oversized JSONL frame",
      closedAfter: true,
    });
  }, 90_000);

  test("copies a frame spread over many chunks once, not once per chunk", () => {
    const probe = spawnSync(
      process.execPath,
      [resolve(import.meta.dir, "testing/stdout-framing-probe.ts")],
      {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, NODE_ENV: "test" },
      },
    );
    expect(probe.status).toBe(0);
    const result = JSON.parse(probe.stdout.trim().split("\n").at(-1)!) as {
      matches: boolean;
      frameBytes: number;
      chunks: number;
      copiedBytes: number;
    };
    expect(result.matches).toBe(true);
    // The pieces really arrived apart, or this would prove nothing.
    expect(result.chunks).toBeGreaterThan(4);
    expect(result.copiedBytes).toBeLessThan(result.frameBytes * 1.1);
  });
});
