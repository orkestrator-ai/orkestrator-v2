import { describe, expect, mock, test } from "bun:test";
import { PUSH_STREAM_STATE_EVENT } from "@orkestrator/protocol/push-events";
import {
  createBrowserGatewayApi,
  MockEventSource,
  useGatewayTestGlobals,
} from "./web-gateway.test-support";

/** The transport's `push-stream-state`: what each `gateway.connected` offered, and drops. */
useGatewayTestGlobals();

const STREAM = "stream-aaaaaaaaaaaaaaaa";

function connected(source: MockEventSource, payload: unknown) {
  source.onmessage?.(
    new MessageEvent("message", {
      data: JSON.stringify({ event: "gateway.connected", payload }),
      lastEventId: "12345678:0",
    }),
  );
}

describe("push stream state", () => {
  test("reports each connection's offer, a backend without one, and a drop", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const states = mock((_state: unknown) => undefined);
    const stop = api.listen(PUSH_STREAM_STATE_EVENT, states);
    const source = MockEventSource.instances[0];
    if (!source) throw new Error("EventSource was not created");

    source.onopen?.();
    connected(source, { status: "fresh", push: { versions: [1], streamId: STREAM } });
    expect(states.mock.calls.at(-1)?.[0]).toEqual({
      state: "connected",
      offer: { versions: [1], streamId: STREAM },
    });

    source.onerror?.();
    expect(states.mock.calls.at(-1)?.[0]).toEqual({ state: "disconnected" });
    // Only one drop is reported while the stream stays down.
    expect(states).toHaveBeenCalledTimes(2);
    stop();
  });

  test("a backend that offers no push is reported as connected without an offer", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const states = mock((_state: unknown) => undefined);
    const stop = api.listen(PUSH_STREAM_STATE_EVENT, states);
    const source = MockEventSource.instances[0];
    if (!source) throw new Error("EventSource was not created");
    source.onopen?.();
    connected(source, { status: "caught-up" });
    expect(states.mock.calls.at(-1)?.[0]).toEqual({ state: "connected", offer: null });
    stop();
  });

  test("a listener that attaches after the stream connected is told at once", async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const stopFirst = api.listen("some-event", () => undefined);
    const source = MockEventSource.instances[0];
    if (!source) throw new Error("EventSource was not created");
    source.onopen?.();
    connected(source, { status: "fresh", push: { versions: [1], streamId: STREAM } });

    const late = mock((_state: unknown) => undefined);
    const stop = api.listen(PUSH_STREAM_STATE_EVENT, late);
    expect(late).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(late).toHaveBeenCalledWith({
      state: "connected",
      offer: { versions: [1], streamId: STREAM },
    });
    stop();
    stopFirst();
  });

  test("a server frame cannot impersonate the transport's push state", () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const api = createBrowserGatewayApi();
    const states = mock((_state: unknown) => undefined);
    const stop = api.listen(PUSH_STREAM_STATE_EVENT, states);
    const source = MockEventSource.instances[0];
    if (!source) throw new Error("EventSource was not created");
    source.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          event: PUSH_STREAM_STATE_EVENT,
          payload: { state: "connected", offer: { versions: [1], streamId: STREAM } },
        }),
        lastEventId: "",
      }),
    );
    expect(states).not.toHaveBeenCalled();
    stop();
  });
});
