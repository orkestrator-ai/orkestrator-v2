import { describe, expect, mock, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  commandEventStreamConnection,
  commandTransportAvailable,
  createWindowOrkestratorClient,
} from "./command-client";

type Api = NonNullable<Window["orkestrator"]>;
type StreamState = "idle" | "connecting" | "connected" | "disconnected";

const NODE = "bk_command" as BackendId;

function fakeHost() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let streamState: StreamState = "connecting";
  const streamListeners = new Set<(state: StreamState) => void>();
  const api = {
    invoke: mock((command: string, args?: Record<string, unknown>) =>
      Promise.resolve({ command, args }),
    ),
    listen: (event: string, callback: (payload: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(callback);
      return () => set.delete(callback);
    },
    eventStreamReady: mock((_event: string) => Promise.resolve()),
    eventStreamConnection: {
      state: () => streamState,
      subscribe: (listener: (state: StreamState) => void) => {
        streamListeners.add(listener);
        return () => streamListeners.delete(listener);
      },
    },
  };
  return {
    api: api as unknown as Api,
    raw: api,
    emit: (event: string, payload: unknown) => {
      for (const callback of Array.from(listeners.get(event) ?? [])) callback(payload);
    },
    listenerCount: () => Array.from(listeners.values()).reduce((sum, set) => sum + set.size, 0),
    setStream: (state: StreamState) => {
      streamState = state;
      for (const listener of Array.from(streamListeners)) listener(state);
    },
    streamListenerCount: () => streamListeners.size,
  };
}

describe("createWindowOrkestratorClient", () => {
  test("invokes and listens through window.orkestrator, read on each call", async () => {
    const host = fakeHost();
    let installed: Api | undefined;
    const client = createWindowOrkestratorClient(NODE, () => installed);

    await expect(client.invokeRaw("get_config")).rejects.toThrow(/not available/);
    expect(client.listenRaw("resource-changed", () => {})).toBeFunction();

    installed = host.api;
    expect(await client.invokeRaw("get_config", { a: 1 })).toEqual({
      command: "get_config",
      args: { a: 1 },
    });
    const received: unknown[] = [];
    const unlisten = client.listenRaw("resource-changed", (payload) => received.push(payload));
    host.emit("resource-changed", { kind: "project" });
    unlisten();
    unlisten();
    host.emit("resource-changed", { kind: "ignored" });
    expect(received).toEqual([{ kind: "project" }]);
    expect(client.nodeId).toBe(NODE);
  });

  test("routes terminal output and readiness to the per-session event", async () => {
    const host = fakeHost();
    const client = createWindowOrkestratorClient(NODE, () => host.api);
    const frames: unknown[] = [];
    client.terminal.listenOutput("s1", (payload) => frames.push(payload));
    host.emit("terminal-output-s1", "frame");
    await client.terminal.outputReady("s1");
    expect(frames).toEqual(["frame"]);
    expect(host.raw.eventStreamReady).toHaveBeenCalledWith("terminal-output-s1");
  });

  test("maps the browser gateway's stream state onto the connection signal", () => {
    const host = fakeHost();
    const client = createWindowOrkestratorClient(NODE, () => host.api);
    // The client's own reconnect watch, which re-reads the hello (plan item 2011).
    const baseline = host.streamListenerCount();
    expect(client.connection.get()).toBe("connecting");
    const seen: string[] = [];
    const stop = client.connection.subscribe((state) => seen.push(state));
    host.setStream("connected");
    expect(client.connection.get()).toBe("live");
    host.setStream("disconnected");
    stop();
    expect(seen).toEqual(["live", "connecting"]);
    expect(host.streamListenerCount()).toBe(baseline);
    expect(client.domains.get()).toBeNull();
    client.dispose();
    expect(host.streamListenerCount()).toBe(0);
  });

  test("dispose drops only its own listeners and refuses further calls", async () => {
    const host = fakeHost();
    const unrelated = host.api.listen("resource-changed", () => {});
    const client = createWindowOrkestratorClient(NODE, () => host.api);
    client.listenRaw("resource-changed", () => {});
    client.terminal.listenOutput("s1", () => {});
    expect(host.listenerCount()).toBe(3);

    client.dispose();
    client.dispose();

    expect(host.listenerCount()).toBe(1);
    await expect(client.invokeRaw("get_config")).rejects.toThrow(/disposed/);
    client.listenRaw("resource-changed", () => {});
    expect(host.listenerCount()).toBe(1);
    unrelated();
  });

  test("reports whether the host is installed and hands out its raw stream state", () => {
    const host = fakeHost();
    expect(commandTransportAvailable(() => undefined)).toBe(false);
    expect(commandTransportAvailable(() => host.api)).toBe(true);
    expect(commandEventStreamConnection(() => undefined)).toBeUndefined();
    const stream = commandEventStreamConnection(() => host.api);
    host.setStream("disconnected");
    expect(stream?.state()).toBe("disconnected");
  });
});
