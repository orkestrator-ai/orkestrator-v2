import { describe, expect, test } from "bun:test";
import { DEFAULT_RING_CAPACITY, EventRing, parseEventCursor } from "./event-ring.js";

describe("EventRing", () => {
  test("assigns monotonic revisions starting at 1", () => {
    const ring = new EventRing<string>();
    expect(ring.append("a")).toBe(1);
    expect(ring.append("b")).toBe(2);
    expect(ring.latestRevision).toBe(2);
  });

  test("replays everything after the cursor", () => {
    const ring = new EventRing<string>();
    ring.append("a");
    ring.append("b");
    ring.append("c");

    const replay = ring.since(1);
    expect(replay.complete).toBe(true);
    expect(replay.events.map((entry) => entry.event)).toEqual(["b", "c"]);
    expect(replay.events.map((entry) => entry.revision)).toEqual([2, 3]);
  });

  test("a caught-up cursor is complete with nothing to send", () => {
    const ring = new EventRing<string>();
    ring.append("a");
    const replay = ring.since(1);
    expect(replay.complete).toBe(true);
    expect(replay.events).toEqual([]);
  });

  test("cursor 0 replays the whole retained buffer", () => {
    const ring = new EventRing<string>();
    ring.append("a");
    ring.append("b");
    const replay = ring.since(0);
    expect(replay.complete).toBe(true);
    expect(replay.events.map((entry) => entry.event)).toEqual(["a", "b"]);
  });

  test("an expired cursor is reported incomplete and sends nothing", () => {
    const ring = new EventRing<string>(2);
    ring.append("a");
    ring.append("b");
    ring.append("c"); // evicts revision 1

    // Asking for everything after 0 needs revision 1, which is gone. A partial
    // replay would leave a permanent hole, so the caller must reconcile instead.
    const replay = ring.since(0);
    expect(replay.complete).toBe(false);
    expect(replay.events).toEqual([]);
    expect(replay.latestRevision).toBe(3);
  });

  test("a cursor exactly at the oldest boundary still replays", () => {
    const ring = new EventRing<string>(2);
    ring.append("a");
    ring.append("b");
    ring.append("c"); // retains 2,3

    // The client has revision 1; the range it needs starts at 2, which we kept.
    const replay = ring.since(1);
    expect(replay.complete).toBe(true);
    expect(replay.events.map((entry) => entry.event)).toEqual(["b", "c"]);
  });

  test("a cursor from the future is incomplete", () => {
    const ring = new EventRing<string>();
    ring.append("a");
    // A client reconnecting to a *restarted* bridge, whose revisions began at 1
    // again. Its cursor refers to a sequence that no longer exists.
    const replay = ring.since(99);
    expect(replay.complete).toBe(false);
    expect(replay.events).toEqual([]);
  });

  test("an empty ring reports an incomplete replay for a non-zero cursor", () => {
    const ring = new EventRing<string>();
    expect(ring.since(5).complete).toBe(false);
    // Cursor 0 against an empty ring means "I have nothing and there is nothing".
    expect(ring.since(0).complete).toBe(true);
  });

  test("evicts oldest first and counts drops", () => {
    const ring = new EventRing<number>(3);
    for (let index = 1; index <= 5; index += 1) ring.append(index);

    const stats = ring.getStats();
    expect(stats.retained).toBe(3);
    expect(stats.dropped).toBe(2);
    expect(stats.latestRevision).toBe(5);
    expect(ring.oldestRevision).toBe(3);
  });

  test("evicts by retained bytes even when the frame-count cap is not reached", () => {
    const ring = new EventRing<string>(100, {
      maxBytes: 5,
      measureBytes: (value) => Buffer.byteLength(value, "utf8"),
    });
    ring.append("aa");
    ring.append("bbb");
    ring.append("cccc");

    expect(ring.since(2).events.map((entry) => entry.event)).toEqual(["cccc"]);
    expect(ring.getStats()).toMatchObject({
      retained: 1,
      retainedBytes: 4,
      maxBytes: 5,
      dropped: 2,
    });
  });

  test("does not retain one frame larger than the whole byte budget", () => {
    const ring = new EventRing<string>(100, {
      maxBytes: 3,
      measureBytes: (value) => Buffer.byteLength(value, "utf8"),
    });
    const revision = ring.append("oversized");

    expect(ring.getStats()).toMatchObject({ retained: 0, retainedBytes: 0 });
    expect(ring.since(revision - 1).complete).toBe(false);
  });

  test("a zero or negative capacity is clamped to 1", () => {
    const ring = new EventRing<string>(0);
    ring.append("a");
    ring.append("b");
    expect(ring.getStats().retained).toBe(1);
    expect(ring.since(1).complete).toBe(true);
  });

  test("a negative cursor is rejected rather than treated as zero", () => {
    const ring = new EventRing<string>();
    ring.append("a");
    expect(ring.since(-1).complete).toBe(false);
    expect(ring.since(Number.NaN).complete).toBe(false);
  });

  test("default capacity covers a realistic reconnect gap", () => {
    const ring = new EventRing<number>();
    for (let index = 0; index < DEFAULT_RING_CAPACITY; index += 1) ring.append(index);
    expect(ring.since(0).complete).toBe(true);
    expect(ring.getStats().dropped).toBe(0);
  });

  test("clear releases retained byte accounting", () => {
    const ring = new EventRing<string>(10, {
      maxBytes: 100,
      measureBytes: (value) => value.length,
    });
    ring.append("payload");
    ring.clear();
    expect(ring.getStats()).toMatchObject({ retained: 0, retainedBytes: 0 });
  });

  test("advance records an unreplayable gap without retaining a payload", () => {
    const ring = new EventRing<string>();
    ring.append("before");
    const cursor = ring.latestRevision;
    ring.clear();
    expect(ring.advance()).toBe(cursor + 1);
    expect(ring.getStats()).toMatchObject({
      retained: 0,
      latestRevision: cursor + 1,
    });
    expect(ring.since(cursor)).toMatchObject({
      events: [],
      complete: false,
      latestRevision: cursor + 1,
    });
  });
});

describe("EventRing supersede", () => {
  interface Frame {
    kind: "full" | "patch";
    id: string;
    seq: number;
    collapsed?: boolean;
  }
  /** A full frame collapses every frame of the same id since the last collapsed one. */
  function ring(calls?: Frame[]) {
    return new EventRing<Frame>(16, {
      supersede: (incoming, retained) => {
        calls?.push(retained);
        if (incoming.kind !== "full" || incoming.id !== retained.id) return null;
        if (retained.collapsed) return retained;
        return { ...retained, collapsed: true };
      },
    });
  }

  test("a full frame collapses every earlier frame of its identity, patches included", () => {
    const events = ring();
    events.append({ kind: "full", id: "a", seq: 1 });
    events.append({ kind: "patch", id: "a", seq: 2 });
    events.append({ kind: "full", id: "b", seq: 3 });
    events.append({ kind: "patch", id: "a", seq: 4 });
    events.append({ kind: "full", id: "a", seq: 5 });

    const replay = events.since(0);
    expect(replay.complete).toBe(true);
    expect(replay.events.map((entry) => [entry.revision, entry.event.collapsed === true])).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, true],
      [5, false],
    ]);
  });

  test("the scan stops at the first entry returned unchanged", () => {
    const calls: Frame[] = [];
    const events = ring(calls);
    events.append({ kind: "full", id: "b", seq: 0 });
    events.append({ kind: "full", id: "a", seq: 1 });
    events.append({ kind: "full", id: "a", seq: 2 });
    events.append({ kind: "patch", id: "a", seq: 3 });
    calls.length = 0;
    events.append({ kind: "full", id: "a", seq: 4 });
    // seq 3 and seq 2 collapse and the scan continues; seq 1, collapsed when
    // seq 2 arrived, is returned unchanged and ends it before seq 0.
    expect(calls.map((frame) => frame.seq)).toEqual([3, 2, 1]);
    expect(events.since(0).events.map((entry) => entry.event.collapsed === true)).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  test("collapse keeps revisions dense and re-weighs the replaced entry", () => {
    const events = new EventRing<{ id: string; bytes: number }>(16, {
      maxBytes: 1_000,
      measureBytes: (event) => event.bytes,
      supersede: (incoming, retained) =>
        incoming.id !== retained.id
          ? null
          : retained.bytes === 1
            ? retained
            : { ...retained, bytes: 1 },
    });
    events.append({ id: "a", bytes: 400 });
    events.append({ id: "a", bytes: 400 });
    expect(events.getStats().retainedBytes).toBe(401);
    expect(events.since(0).events.map((entry) => entry.revision)).toEqual([1, 2]);
  });
});

describe("EventRing with an outside sequence", () => {
  test("appendAt retains under the given revision", () => {
    const events = new EventRing<string>();
    events.appendAt(7, "seven");
    events.appendAt(8, "eight");
    expect(events.latestRevision).toBe(8);
    expect(events.since(6)).toEqual({
      events: [
        { revision: 7, event: "seven" },
        { revision: 8, event: "eight" },
      ],
      complete: true,
      latestRevision: 8,
    });
  });

  test("a jump past the next revision drops what a replay could no longer cover densely", () => {
    const events = new EventRing<string>();
    events.appendAt(1, "one");
    events.appendAt(2, "two");
    events.appendAt(5, "five");
    expect(events.getStats()).toMatchObject({ retained: 1, dropped: 2, latestRevision: 5 });
    // A client holding revision 1 missed 3 and 4, which were never recorded.
    expect(events.since(1)).toMatchObject({ events: [], complete: false });
    expect(events.since(4).events.map((entry) => entry.event)).toEqual(["five"]);
  });

  test("advanceTo moves the cursor without retaining and drops what it strands", () => {
    const events = new EventRing<string>();
    events.appendAt(1, "one");
    events.advanceTo(3);
    expect(events.getStats()).toMatchObject({ retained: 0, latestRevision: 3 });
    expect(events.since(1)).toMatchObject({ complete: false });
    expect(events.since(3)).toEqual({ events: [], complete: true, latestRevision: 3 });
    // Re-advancing to the current revision is a no-op.
    events.appendAt(4, "four");
    events.advanceTo(4);
    expect(events.getStats()).toMatchObject({ retained: 1, latestRevision: 4 });
  });

  test("advance drops retained events, which would otherwise hide its revision", () => {
    const events = new EventRing<string>();
    events.append("one");
    events.advance();
    events.append("three");
    expect(events.since(1)).toMatchObject({ events: [], complete: false });
    expect(events.since(2).events.map((entry) => entry.event)).toEqual(["three"]);
  });

  test("a revision that goes backwards is refused", () => {
    const events = new EventRing<string>();
    events.appendAt(5, "five");
    expect(() => events.appendAt(5, "again")).toThrow(RangeError);
    expect(() => events.advanceTo(4)).toThrow(RangeError);
    expect(() => events.appendAt(Number.NaN, "nan")).toThrow(RangeError);
    expect(events.getStats()).toMatchObject({ retained: 1, latestRevision: 5 });
  });
});

describe("parseEventCursor", () => {
  test("accepts non-negative integers", () => {
    expect(parseEventCursor("0")).toBe(0);
    expect(parseEventCursor("42")).toBe(42);
    expect(parseEventCursor(" 7 ")).toBe(7);
  });

  test("rejects anything else as no cursor", () => {
    // All of these mean "fresh subscription", not "error": a garbled Last-Event-ID
    // must not fail the connection.
    for (const input of [null, undefined, "", "  ", "abc", "-1", "1.5", "1e3", "0x10", "٣"]) {
      expect(parseEventCursor(input)).toBeNull();
    }
  });

  test("rejects values beyond safe integer range", () => {
    expect(parseEventCursor("99999999999999999999")).toBeNull();
  });
});
