import { describe, expect, test } from "bun:test";
import {
  designCanvasChangedEvent,
  terminalOutputEvents,
} from "@orkestrator/protocol/contract/domains/events";
import type { BackendId } from "@orkestrator/protocol/federation";
import { createWindowOrkestratorClient } from "./command-client";
import { typedHandler, typedListen } from "./typed-listen";

type Handler = (payload: unknown) => void;
type OrkestratorApi = NonNullable<Window["orkestrator"]>;

function rawSource() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    listenRaw(event: string, handler: Handler) {
      const set = handlers.get(event) ?? new Set();
      handlers.set(event, set);
      set.add(handler);
      return () => set.delete(handler);
    },
    deliver(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    count: () => Array.from(handlers.values()).reduce((n, set) => n + set.size, 0),
  };
}

describe("typedListen", () => {
  test("delivers decodable payloads as sent and drops the rest", () => {
    const source = rawSource();
    const listen = typedListen(source.listenRaw);
    const received: unknown[] = [];
    const stop = listen(designCanvasChangedEvent, (payload) => received.push(payload));
    const valid = { canvasId: "c1", revision: 2, generation: "g", newer: true };
    source.deliver("design-canvas-changed", valid);
    source.deliver("design-canvas-changed", { canvasId: 1, revision: 2 });
    source.deliver("design-canvas-changed", null);
    expect(received).toEqual([valid]);
    stop();
    expect(source.count()).toBe(0);
  });

  test("subscribes to one family member by name", () => {
    const source = rawSource();
    const listen = typedListen(source.listenRaw);
    const texts: string[] = [];
    listen(terminalOutputEvents.at("s1"), (payload) => texts.push(payload.text));
    source.deliver("terminal-output-s1", { text: "a", revision: 1, generation: 1 });
    source.deliver("terminal-output-s2", { text: "b" });
    expect(texts).toEqual(["a"]);
  });
});

describe("NodeClient.listen on the command-scope client", () => {
  test("goes through the client's listenRaw and stops with dispose", () => {
    const source = rawSource();
    const host = {
      invoke: async () => null,
      listen: (event: string, handler: Handler) => source.listenRaw(event, handler),
    } as unknown as OrkestratorApi;
    const client = createWindowOrkestratorClient("node-a" as BackendId, () => host);
    const revisions: number[] = [];
    client.listen(designCanvasChangedEvent, (payload) => revisions.push(payload.revision));
    source.deliver("design-canvas-changed", { canvasId: "c", revision: 7 });
    expect(revisions).toEqual([7]);
    client.dispose();
    expect(source.count()).toBe(0);
  });
});

describe("typedHandler", () => {
  test("hands decodable payloads on as sent and drops the rest", () => {
    const received: unknown[] = [];
    const deliver = typedHandler(designCanvasChangedEvent, (payload) => received.push(payload));
    const valid = { canvasId: "c1", revision: 2, generation: "g", newer: true };
    deliver({ canvasId: 1, revision: 2 });
    deliver(undefined);
    deliver(valid);
    expect(received).toEqual([valid]);
  });
});
