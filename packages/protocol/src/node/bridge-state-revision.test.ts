import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  bridgeObservationFrameData,
  bridgeObservationRevisionVersion,
  isBridgeStateUnchanged,
  parseBridgeObservationFrame,
} from "../bridge-state-revision.js";
import { BridgeStateRevisions, expectStateRevisionMoves } from "./bridge-state-revision.js";
import { BridgeObservationHub } from "./bridge-observation-stream.js";

describe("BridgeStateRevisions", () => {
  test("a bump moves the peeked revision; settle with unchanged content keeps it", () => {
    const revisions = new BridgeStateRevisions({ generation: "gen" });
    const first = revisions.settle("s1", { status: "idle" });
    expect(first).toMatch(/^gen:\d+$/);
    expect(revisions.settle("s1", { status: "idle" })).toBe(first);
    const bumped = revisions.bump("s1");
    expect(bumped).not.toBe(first);
    expect(revisions.peek("s1")).toBe(bumped);
    // The read after a bump records the digest at the new counter, without moving again.
    expect(revisions.settle("s1", { status: "running" })).toBe(bumped);
  });

  test("a change no site bumped still moves the revision at the next read", () => {
    const revisions = new BridgeStateRevisions({ generation: "gen" });
    const first = revisions.settle("s1", { status: "idle" });
    const second = revisions.settle("s1", { status: "running" });
    expect(second).not.toBe(first);
    // Changing back is a new revision too, never the old one.
    expect(revisions.settle("s1", { status: "idle" })).not.toBe(first);
  });

  test("answer is unchanged only for the current revision", () => {
    const revisions = new BridgeStateRevisions({ generation: "gen" });
    const revision = revisions.settle("s1", { a: 1 });
    expect(revisions.answer("s1", { a: 1 }, revision)).toEqual({
      unchanged: true,
      body: { unchanged: true, stateRevision: revision },
    });
    expect(revisions.answer("s1", { a: 2 }, revision).unchanged).toBe(false);
    expect(revisions.answer("s1", { a: 2 }, "other:1").unchanged).toBe(false);
    expect(revisions.answer("s1", { a: 2 }, "not a revision").unchanged).toBe(false);
  });

  test("revisions are never reused across sessions or after eviction", () => {
    const revisions = new BridgeStateRevisions({ generation: "gen", maxSessions: 2 });
    const a = revisions.peek("a");
    revisions.peek("b");
    revisions.peek("c");
    expect(revisions.size).toBe(2);
    expect(revisions.peek("a")).not.toBe(a);
    expect(revisions.peek("b")).not.toBe(revisions.peek("c"));
  });

  test("the harness fails a mutation that changes the read without moving the revision", async () => {
    const revisions = new BridgeStateRevisions({ generation: "gen" });
    let body = { status: "idle" };
    const read = () => body;
    const peek = () => revisions.peek("s1");
    await expect(
      expectStateRevisionMoves({
        label: "silent",
        read,
        peek,
        mutate: () => {
          body = { status: "running" };
        },
      }),
    ).rejects.toThrow("silent");
    await expect(
      expectStateRevisionMoves({
        label: "bumped",
        read,
        peek,
        mutate: () => {
          body = { status: "idle" };
          revisions.bump("s1");
        },
      }),
    ).resolves.toEqual({ changed: true, moved: true });
  });
});

describe("observe frame data", () => {
  test("round-trips the session and revisions from a bounded prefix", () => {
    const data = bridgeObservationFrameData('se"ss', {
      stateRevision: "gen:4",
      transcriptRevision: "t-9.2",
    });
    expect(parseBridgeObservationFrame(data)).toEqual({
      sessionId: 'se"ss',
      stateRevision: "gen:4",
      transcriptRevision: "t-9.2",
    });
    expect(parseBridgeObservationFrame('{"sessionId":"s1"}')).toEqual({ sessionId: "s1" });
    expect(parseBridgeObservationFrame("{}")).toEqual({});
    expect(parseBridgeObservationFrame(null)).toEqual({});
    expect(parseBridgeObservationFrame('{"sessionId":"s1","stateRevision":"bad"}')).toEqual({
      sessionId: "s1",
    });
  });

  test("the connected frame's revision version and the unchanged answer", () => {
    expect(bridgeObservationRevisionVersion('{"observe":true,"revisions":1}')).toBe(1);
    expect(bridgeObservationRevisionVersion('{"observe":true}')).toBe(0);
    expect(bridgeObservationRevisionVersion("not json")).toBe(0);
    expect(isBridgeStateUnchanged({ unchanged: true, stateRevision: "g:1" })).toBe(true);
    expect(isBridgeStateUnchanged({ unchanged: true })).toBe(false);
    expect(isBridgeStateUnchanged({ status: "idle", stateRevision: "g:1" })).toBe(false);
  });
});

describe("BridgeObservationHub", () => {
  async function serve(hub: BridgeObservationHub): Promise<{ server: Server; url: string }> {
    const server = createServer((request, response) => {
      hub.serve(request, response, new URL(request.url ?? "/", "http://localhost"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  async function readUntil(body: ReadableStream<Uint8Array>, needle: string): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();
    return text;
  }

  test("refuses a subscription without observe=1", async () => {
    const hub = new BridgeObservationHub({ generation: "g" });
    const { server, url } = await serve(hub);
    try {
      const response = await fetch(`${url}/event/subscribe`);
      expect(response.status).toBe(400);
    } finally {
      server.close();
    }
  });

  test("streams content-free frames with revisions, and a stale cursor gets replay.required", async () => {
    const hub = new BridgeObservationHub({ generation: "g" });
    const { server, url } = await serve(hub);
    const controller = new AbortController();
    try {
      const response = await fetch(`${url}/event/subscribe?observe=1`, {
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const body = response.body!;
      const connected = await readUntil(body, "event: connected");
      expect(connected).toContain('"revisions":1');
      expect(connected).toContain('"observe":true');
      hub.publish("session.changed", "s1", { stateRevision: "g:7", transcriptRevision: "3" });
      const frame = await readUntil(body, "session.changed");
      expect(frame).toContain("id: g:1");
      expect(frame).toContain(
        'data: {"sessionId":"s1","stateRevision":"g:7","transcriptRevision":"3"}',
      );
      controller.abort();

      const stale = new AbortController();
      const again = await fetch(`${url}/event/subscribe?observe=1&since=other:3`, {
        signal: stale.signal,
      });
      const text = await readUntil(again.body!, "replay.required");
      expect(text).toContain("id: other:3");
      expect(text).toContain("event: replay.required");
      stale.abort();
    } finally {
      controller.abort();
      hub.close();
      server.close();
    }
  });

  test("bounds subscribers", async () => {
    const hub = new BridgeObservationHub({ generation: "g", maxSubscribers: 1 });
    const { server, url } = await serve(hub);
    const first = new AbortController();
    try {
      const open = await fetch(`${url}/event/subscribe?observe=1`, { signal: first.signal });
      await readUntil(open.body!, "connected");
      expect(hub.subscriberCount).toBe(1);
      const refused = await fetch(`${url}/event/subscribe?observe=1`);
      expect(refused.status).toBe(503);
    } finally {
      first.abort();
      hub.close();
      server.close();
    }
  });
});
