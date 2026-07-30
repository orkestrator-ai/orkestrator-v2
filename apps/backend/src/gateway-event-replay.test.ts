import { describe, expect, jest, test } from "bun:test";
import {
  DEFAULT_GATEWAY_REPLAY_FRAME_CAPACITY,
  DEFAULT_GATEWAY_REPLAY_IDLE_RETENTION_MS,
  DEFAULT_GATEWAY_REPLAY_MAX_BYTES,
  GatewayEventReplay,
  formatGatewayCursor,
  parseGatewayCursor,
} from "./gateway-event-replay.js";

const GENERATION = "generation";

describe("gateway event replay cursors", () => {
  test("formats generation-scoped revisions", () => {
    expect(formatGatewayCursor("generation_123", 0)).toBe("generation_123:0");
    expect(formatGatewayCursor("generation-123", Number.MAX_SAFE_INTEGER)).toBe(
      `generation-123:${Number.MAX_SAFE_INTEGER}`,
    );
  });

  test.each([
    [null, { kind: "absent" }],
    [undefined, { kind: "absent" }],
    ["", { kind: "invalid", raw: "" }],
    [" \t\r\n ", { kind: "invalid", raw: "" }],
  ] as const)("parses absent and blank cursor input %#", (raw, expected) => {
    expect(parseGatewayCursor(raw)).toEqual(expected);
  });

  test("accepts the generation length boundaries and trims surrounding whitespace", () => {
    const minimumGeneration = "a".repeat(8);
    const maximumGeneration = "Z".repeat(128);

    expect(parseGatewayCursor(`${minimumGeneration}:0`)).toEqual({
      kind: "valid",
      raw: `${minimumGeneration}:0`,
      generation: minimumGeneration,
      revision: 0,
    });
    expect(parseGatewayCursor(` \t${maximumGeneration}:42\r\n`)).toEqual({
      kind: "valid",
      raw: `${maximumGeneration}:42`,
      generation: maximumGeneration,
      revision: 42,
    });
  });

  test.each([
    [`${"a".repeat(7)}:1`, "generation shorter than eight characters"],
    [`${"a".repeat(129)}:1`, "generation longer than 128 characters"],
    ["abcdefg!:1", "invalid generation punctuation"],
    ["abcd efgh:1", "generation whitespace"],
    ["abcdefgh:\n1", "embedded control character"],
    ["abcdefgh:01", "leading zero"],
    ["abcdefgh:-1", "negative revision"],
    ["abcdefgh:+1", "signed positive revision"],
    ["abcdefgh:1.5", "fractional revision"],
    ["abcdefgh:", "missing revision"],
  ])("rejects %s (%s)", (raw) => {
    expect(parseGatewayCursor(raw)).toEqual({ kind: "invalid", raw: raw.trim() });
  });

  test("accepts the largest safe revision and rejects an unsafe integer", () => {
    expect(parseGatewayCursor(`abcdefgh:${Number.MAX_SAFE_INTEGER}`)).toEqual({
      kind: "valid",
      raw: `abcdefgh:${Number.MAX_SAFE_INTEGER}`,
      generation: "abcdefgh",
      revision: Number.MAX_SAFE_INTEGER,
    });
    expect(parseGatewayCursor(`abcdefgh:${Number.MAX_SAFE_INTEGER + 1}`)).toEqual({
      kind: "invalid",
      raw: `abcdefgh:${Number.MAX_SAFE_INTEGER + 1}`,
    });
  });
});

describe("GatewayEventReplay configuration and append", () => {
  test("uses the documented defaults", () => {
    const replay = new GatewayEventReplay(GENERATION);
    try {
      expect(replay.getStats()).toEqual({
        generation: GENERATION,
        latestRevision: 0,
        oldestRevision: 0,
        retainedFrames: 0,
        retainedBytes: 0,
        droppedFrames: 0,
        frameCapacity: DEFAULT_GATEWAY_REPLAY_FRAME_CAPACITY,
        maxBytes: DEFAULT_GATEWAY_REPLAY_MAX_BYTES,
        idleRetentionMs: DEFAULT_GATEWAY_REPLAY_IDLE_RETENTION_MS,
      });
      expect(replay.latestCursor).toBe(`${GENERATION}:0`);
    } finally {
      replay.releaseRetained();
    }
  });

  test("clamps negative capacities and retention values", () => {
    const replay = new GatewayEventReplay(GENERATION, {
      frameCapacity: -20,
      maxBytes: -30,
      idleRetentionMs: -40,
    });

    expect(replay.getStats()).toMatchObject({
      frameCapacity: 1,
      maxBytes: 0,
      idleRetentionMs: 0,
    });

    replay.append("event", { value: 1 });
    expect(replay.getStats()).toMatchObject({
      latestRevision: 1,
      retainedFrames: 0,
      retainedBytes: 0,
      droppedFrames: 1,
    });
  });

  test("returns the exact SSE frame and counts UTF-8 encoded bytes", () => {
    const replay = new GatewayEventReplay(GENERATION, { idleRetentionMs: 60_000 });
    try {
      const frame = replay.append("environment-renamed", { label: "café 🙂" });
      const expectedMessage =
        `id: ${GENERATION}:1\n` +
        'data: {"event":"environment-renamed","payload":{"label":"café 🙂"}}\n\n';

      expect(frame).toEqual({
        revision: 1,
        cursor: `${GENERATION}:1`,
        event: "environment-renamed",
        message: expectedMessage,
        encodedBytes: Buffer.byteLength(expectedMessage),
      });
      expect(frame.encodedBytes).toBeGreaterThan(expectedMessage.length);
      expect(replay.latestRevision).toBe(1);
      expect(replay.oldestRevision).toBe(1);
      expect(replay.latestCursor).toBe(`${GENERATION}:1`);
      expect(replay.getStats()).toMatchObject({
        retainedFrames: 1,
        retainedBytes: Buffer.byteLength(expectedMessage),
        droppedFrames: 0,
      });
    } finally {
      replay.releaseRetained();
    }
  });

  test("tracks every frame evicted by the count bound", () => {
    const replay = new GatewayEventReplay(GENERATION, {
      frameCapacity: 1,
      maxBytes: Number.MAX_SAFE_INTEGER,
      idleRetentionMs: 60_000,
    });
    try {
      replay.append("one", 1);
      replay.append("two", 2);
      replay.append("three", 3);

      expect(replay.getStats()).toMatchObject({
        latestRevision: 3,
        oldestRevision: 3,
        retainedFrames: 1,
        droppedFrames: 2,
      });
      expect(replay.since(2).frames.map((frame) => frame.event)).toEqual(["three"]);
    } finally {
      replay.releaseRetained();
    }
  });

  test("retains a frame at the exact byte limit and drops it below that limit", () => {
    const probe = new GatewayEventReplay(GENERATION, { idleRetentionMs: 60_000 });
    const encodedBytes = probe.append("unicode", "é🙂").encodedBytes;
    probe.releaseRetained();

    const exact = new GatewayEventReplay(GENERATION, {
      maxBytes: encodedBytes,
      idleRetentionMs: 60_000,
    });
    const below = new GatewayEventReplay(GENERATION, {
      maxBytes: encodedBytes - 1,
      idleRetentionMs: 60_000,
    });
    try {
      exact.append("unicode", "é🙂");
      below.append("unicode", "é🙂");

      expect(exact.getStats()).toMatchObject({
        retainedFrames: 1,
        retainedBytes: encodedBytes,
        droppedFrames: 0,
      });
      expect(below.getStats()).toMatchObject({
        retainedFrames: 0,
        retainedBytes: 0,
        droppedFrames: 1,
      });
    } finally {
      exact.releaseRetained();
      below.releaseRetained();
    }
  });
});

describe("GatewayEventReplay replay windows", () => {
  test("rejects invalid, fractional, unsafe, and future revisions with metadata", () => {
    const replay = new GatewayEventReplay(GENERATION, {
      frameCapacity: 2,
      idleRetentionMs: 60_000,
    });
    try {
      replay.append("one", 1);
      replay.append("two", 2);
      replay.append("three", 3);
      const expected = {
        complete: false,
        frames: [],
        latestRevision: 3,
        oldestRevision: 2,
      };

      for (const revision of [
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
        4,
      ]) {
        expect(replay.since(revision)).toEqual(expected);
      }
    } finally {
      replay.releaseRetained();
    }
  });

  test("reports incomplete expired windows and complete retained windows", () => {
    const replay = new GatewayEventReplay(GENERATION, {
      frameCapacity: 2,
      idleRetentionMs: 60_000,
    });
    try {
      replay.append("one", 1);
      replay.append("two", 2);
      replay.append("three", 3);

      expect(replay.since(0)).toEqual({
        complete: false,
        frames: [],
        latestRevision: 3,
        oldestRevision: 2,
      });
      expect(replay.since(1)).toEqual({
        complete: true,
        frames: [
          expect.objectContaining({ revision: 2, event: "two" }),
          expect.objectContaining({ revision: 3, event: "three" }),
        ],
        latestRevision: 3,
        oldestRevision: 2,
      });
      expect(replay.since(2)).toEqual({
        complete: true,
        frames: [expect.objectContaining({ revision: 3, event: "three" })],
        latestRevision: 3,
        oldestRevision: 2,
      });
    } finally {
      replay.releaseRetained();
    }
  });

  test("treats the latest revision as caught up, including an empty replay", () => {
    const empty = new GatewayEventReplay(GENERATION, { idleRetentionMs: 60_000 });
    const populated = new GatewayEventReplay(GENERATION, { idleRetentionMs: 60_000 });
    try {
      expect(empty.since(0)).toEqual({
        complete: true,
        frames: [],
        latestRevision: 0,
        oldestRevision: 0,
      });

      populated.append("one", 1);
      populated.append("two", 2);
      expect(populated.since(2)).toEqual({
        complete: true,
        frames: [],
        latestRevision: 2,
        oldestRevision: 1,
      });
    } finally {
      empty.releaseRetained();
      populated.releaseRetained();
    }
  });

  test("releaseRetained preserves revisions while expiring the replay window", () => {
    const replay = new GatewayEventReplay(GENERATION, { idleRetentionMs: 60_000 });
    replay.append("one", 1);
    replay.releaseRetained();

    expect(replay.getStats()).toMatchObject({
      latestRevision: 1,
      oldestRevision: 0,
      retainedFrames: 0,
      retainedBytes: 0,
      droppedFrames: 0,
    });
    expect(replay.since(0)).toEqual({
      complete: false,
      frames: [],
      latestRevision: 1,
      oldestRevision: 0,
    });
  });
});

describe("GatewayEventReplay idle retention", () => {
  test("resets the idle release timer after each append", () => {
    jest.useFakeTimers();
    const replay = new GatewayEventReplay(GENERATION, { idleRetentionMs: 100 });
    try {
      replay.append("one", 1);
      jest.advanceTimersByTime(75);
      replay.append("two", 2);

      jest.advanceTimersByTime(25);
      expect(replay.getStats()).toMatchObject({
        latestRevision: 2,
        retainedFrames: 2,
      });

      jest.advanceTimersByTime(74);
      expect(replay.getStats().retainedFrames).toBe(2);
      jest.advanceTimersByTime(1);
      expect(replay.getStats()).toMatchObject({
        latestRevision: 2,
        oldestRevision: 0,
        retainedFrames: 0,
        retainedBytes: 0,
        droppedFrames: 0,
      });
    } finally {
      replay.releaseRetained();
      jest.useRealTimers();
    }
  });

  test("releases zero-retention frames immediately without resetting revisions", () => {
    const replay = new GatewayEventReplay(GENERATION, { idleRetentionMs: 0 });
    const frame = replay.append("one", 1);

    expect(frame).toMatchObject({
      revision: 1,
      cursor: `${GENERATION}:1`,
      event: "one",
    });
    expect(replay.getStats()).toMatchObject({
      latestRevision: 1,
      oldestRevision: 0,
      retainedFrames: 0,
      retainedBytes: 0,
      droppedFrames: 0,
      idleRetentionMs: 0,
    });
    expect(replay.since(0)).toMatchObject({
      complete: false,
      latestRevision: 1,
      oldestRevision: 0,
    });
  });
});
