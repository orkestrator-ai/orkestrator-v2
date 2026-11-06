import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { createCounter, routeLabel, type CounterFile } from "./conditional-reads-bridge-counter";
import {
  assertWindowEvidence,
  summarizeCounters,
  withCleanup,
} from "./conditional-reads-measurement";

const snapshot = (messages: unknown[]) =>
  Buffer.from(JSON.stringify({ status: "snapshot", value: { messages } }));
describe("bridge measurements", () => {
  test("normalizes session ids and query values while retaining the v2 discriminator", () => {
    expect(
      routeLabel("GET", "/session/private/transcript?version=2&knownToken=secret&knownToken=again"),
    ).toBe("GET /session/:id/transcript?knownToken&version=2");
    expect(routeLabel("POST", "/sessions/activity")).toBe("POST /sessions/activity");
    expect(routeLabel(undefined, undefined)).toBe("GET /");
    expect(routeLabel("GET", "/sessions/private/status?token=secret")).toBe(
      "GET /sessions/:id/status?token",
    );
  });
  test("estimates changed and added rows, includes order, and isolates sessions", () => {
    const counter = createCounter();
    const first = { id: "a", text: "old" };
    counter.recordSnapshot("one", snapshot([first]), false);
    expect(counter.delta.snapshots).toBe(0); // no base yet
    const changed = { id: "a", text: "new" };
    const added = { id: "b", text: "é" };
    const body = snapshot([changed, added]);
    expect(counter.recordSnapshot("one", gzipSync(body), true)).toBe(body.byteLength);
    expect(counter.delta).toEqual({
      snapshots: 1,
      snapshotBytes: body.byteLength,
      changedRows: 2,
      rows: 2,
      estimatedDeltaBytes:
        Buffer.byteLength(JSON.stringify(changed)) +
        Buffer.byteLength(JSON.stringify(added)) +
        8 +
        512,
    });
    const previous = { ...counter.delta };
    counter.recordSnapshot("one", snapshot([added, changed]), false);
    expect(counter.delta.changedRows).toBe(previous.changedRows);
    expect(counter.delta.estimatedDeltaBytes - previous.estimatedDeltaBytes).toBe(520);
    counter.recordSnapshot("other", body, false);
    expect(counter.delta.snapshots).toBe(2);
    counter.recordSnapshot("one", snapshot([added]), false); // removed id is absent from order
    expect(counter.delta.estimatedDeltaBytes - previous.estimatedDeltaBytes).toBe(520 + 516);
    counter.recordSnapshot("one", Buffer.from('{"status":"unchanged"}'), false);
    expect(counter.delta.snapshots).toBe(3);
  });
  test("state repeats compare decoded bodies per route and session", () => {
    const counter = createCounter();
    const body = Buffer.from('{"phase":"idle"}');
    expect(counter.stateRepeated("GET /session/:id", "a", body, false)).toBe(false);
    expect(counter.stateRepeated("GET /session/:id", "a", gzipSync(body), true)).toBe(true);
    expect(counter.stateRepeated("GET /session/:id/status", "a", body, false)).toBe(false);
    expect(counter.stateRepeated("GET /session/:id", "b", body, false)).toBe(false);
    expect(counter.stateRepeated("GET /session/:id", "a", Buffer.from("{}"), false)).toBe(false);
  });
  test("uses exact half-open boundaries despite delayed flushes", () => {
    const delta = {
      snapshots: 1,
      snapshotBytes: 100,
      estimatedDeltaBytes: 50,
      changedRows: 1,
      rows: 2,
    };
    const route = { count: 1, bytes: 10, decodedBytes: 100, ms: 2, maxMs: 2, repeats: 1 };
    const file: CounterFile = {
      flushedAt: 5000,
      droppedThrough: 0,
      samples: [999, 1000, 1999, 2000, 4000].map((at) => ({
        at,
        label: "GET /session/:id",
        route,
        delta,
      })),
    };
    const result = summarizeCounters([file], 1000, 2000);
    expect(result.routes["GET /session/:id"]).toEqual({
      count: 2,
      bytes: 20,
      decodedBytes: 200,
      ms: 4,
      meanMs: 2,
      repeats: 2,
    });
    expect(result.delta.snapshots).toBe(2);
    expect(() => summarizeCounters([], 1000, 2000)).toThrow("Missing bridge instrumentation");
    expect(() => summarizeCounters([{ ...file, flushedAt: 1999 }], 1000, 2000)).toThrow(
      "not flushed",
    );
    expect(() => summarizeCounters([{ ...file, droppedThrough: 1000 }], 1000, 2000)).toThrow(
      "bounded history",
    );
  });
  test("rejects missing route, snapshot and viewer evidence", () => {
    const route = { count: 1, bytes: 1, decodedBytes: 1, ms: 1, meanMs: 1, repeats: 0 };
    const window = {
      bridge: {
        routes: { "GET /session/:id": route, "GET /session/:id/transcript?version=2": route },
        delta: { snapshots: 1, snapshotBytes: 1, estimatedDeltaBytes: 1, changedRows: 1, rows: 1 },
      },
      renderer: { first: { "transcript:delta": 1, "state:unchanged": 1 } },
    };
    expect(() => assertWindowEvidence(window, ["first"], true)).not.toThrow();
    expect(() => assertWindowEvidence(window, ["first", "second"], true)).toThrow("viewer");
    expect(() =>
      assertWindowEvidence(
        { ...window, bridge: { ...window.bridge, routes: {} } },
        ["first"],
        true,
      ),
    ).toThrow("state");
    expect(() =>
      assertWindowEvidence(
        { ...window, bridge: { ...window.bridge, routes: { "GET /session/:id": route } } },
        ["first"],
        true,
      ),
    ).toThrow("transcript observations");
    const idle = {
      ...window,
      bridge: { ...window.bridge, delta: { ...window.bridge.delta, snapshots: 0 } },
    };
    expect(() => assertWindowEvidence(idle, ["first"], true)).toThrow("snapshots");
    expect(() => assertWindowEvidence(idle, ["first"], false)).not.toThrow();
  });
  test("cleans up on setup and artifact failures", async () => {
    for (const failure of ["setup", "artifact"]) {
      const released: string[] = [];
      await expect(
        withCleanup(
          async () => {
            throw new Error(failure);
          },
          async () => {
            try {
              if (failure === "artifact") throw new Error("artifact");
            } finally {
              released.push("files", "model");
            }
          },
        ),
      ).rejects.toThrow(failure);
      expect(released).toEqual(["files", "model"]);
    }
  });
});
