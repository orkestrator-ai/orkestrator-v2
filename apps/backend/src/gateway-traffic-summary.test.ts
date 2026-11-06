import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import {
  GATEWAY_TRAFFIC_BURST_THRESHOLD,
  GATEWAY_TRAFFIC_MAX_KEYS,
  GatewayTrafficSummary,
  gatewayTrafficClient,
  gatewayTrafficSource,
  type GatewayTrafficSummaryFields,
} from "./gateway-traffic-summary.js";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function fakeRequest(
  remoteAddress: string,
  headers: Record<string, string | string[]> = {},
): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

function viaServe(device: string, userAgent = CHROME): IncomingMessage {
  return fakeRequest("127.0.0.1", { "x-forwarded-for": device, "user-agent": userAgent });
}

function harness() {
  let now = 1_000_000;
  const reports: GatewayTrafficSummaryFields[] = [];
  let scheduled = 0;
  let cancelled = 0;
  const summary = new GatewayTrafficSummary({
    now: () => now,
    schedule: () => {
      scheduled += 1;
      return () => {
        cancelled += 1;
      };
    },
    openSockets: () => 7,
    report: (fields) => reports.push(fields),
  });
  return {
    summary,
    reports,
    timers: () => ({ scheduled, cancelled }),
    advance(ms: number) {
      now += ms;
      summary.tick();
    },
  };
}

describe("gatewayTrafficSource", () => {
  test("names the tailnet device Serve forwards for", () => {
    expect(gatewayTrafficSource(viaServe("100.64.0.7"))).toBe("100.64.0.7");
    expect(
      gatewayTrafficSource(fakeRequest("::ffff:127.0.0.1", { "x-forwarded-for": "fd7a::1" })),
    ).toBe("fd7a::1");
  });

  test("a loopback request without the header is local", () => {
    expect(gatewayTrafficSource(fakeRequest("127.0.0.1"))).toBe("loopback");
  });

  test("never logs header text that is not an address", () => {
    expect(
      gatewayTrafficSource(fakeRequest("127.0.0.1", { "x-forwarded-for": "secret-token" })),
    ).toBe("invalid");
  });

  test("ignores the header from a direct client, which could set anything", () => {
    expect(
      gatewayTrafficSource(fakeRequest("100.64.0.9", { "x-forwarded-for": "100.64.0.7" })),
    ).toBe("100.64.0.9");
    expect(gatewayTrafficSource(fakeRequest(""))).toBe("unknown");
  });
});

describe("gatewayTrafficClient", () => {
  test("maps a user agent to a fixed family", () => {
    expect(gatewayTrafficClient(CHROME)).toBe("chrome");
    expect(gatewayTrafficClient(`${CHROME} Electron/45.0.0`)).toBe("electron");
    expect(
      gatewayTrafficClient(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("safari");
    expect(gatewayTrafficClient("Bun/1.4.4")).toBe("bun");
    expect(gatewayTrafficClient("node")).toBe("node");
    expect(gatewayTrafficClient("curl/8.7.1")).toBe("curl");
    expect(gatewayTrafficClient("something/1.0 private")).toBe("other");
    expect(gatewayTrafficClient(undefined)).toBe("none");
  });
});

describe("GatewayTrafficSummary", () => {
  test("ordinary traffic writes nothing", () => {
    const { summary, reports, timers, advance } = harness();
    for (let second = 0; second < 30; second += 1) {
      for (let i = 0; i < GATEWAY_TRAFFIC_BURST_THRESHOLD - 1; i += 1) {
        summary.noteRequest(viaServe("100.64.0.7"), "invoke");
      }
      advance(1_000);
    }
    expect(reports).toEqual([]);
    expect(timers().scheduled).toBe(0);
  });

  test("a request burst is reported once it has been quiet for five windows", () => {
    const { summary, reports, timers, advance } = harness();
    for (let i = 0; i < 150; i += 1) summary.noteRequest(viaServe("100.64.0.7"), "invoke");
    for (let i = 0; i < 10; i += 1) summary.noteRequest(viaServe("100.64.0.9"), "events");
    for (let i = 0; i < 150; i += 1) summary.noteInvoke("get_environment");
    expect(timers().scheduled).toBe(1);

    for (let window = 0; window < 5; window += 1) advance(1_000);
    expect(reports).toHaveLength(0);
    advance(1_000);

    expect(reports).toEqual([
      {
        windows: 1,
        durationMs: 1_000,
        requests: 160,
        connections: 0,
        peakRequests: 160,
        peakConnections: 0,
        openSockets: 7,
        closedByPeer: 0,
        closedByServer: 0,
        closedOnError: 0,
        singleRequestSockets: 0,
        sources: "100.64.0.7=150,100.64.0.9=10",
        routes: "invoke=150,events=10",
        clients: "chrome=160",
        listeners: "",
        invokes: "get_environment=150",
      },
    ]);
    expect(timers()).toEqual({ scheduled: 1, cancelled: 1 });
  });

  test("a connection burst counts by listener", () => {
    const { summary, reports, advance } = harness();
    for (let i = 0; i < GATEWAY_TRAFFIC_BURST_THRESHOLD; i += 1) summary.noteConnection("browser");
    summary.noteConnection("control");
    for (let window = 0; window < 6; window += 1) advance(1_000);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      connections: 101,
      peakConnections: 101,
      listeners: "browser=100,control=1",
    });
  });

  test("a connection-hot burst includes quiet-window requests in its peak", () => {
    const { summary, reports, advance } = harness();
    for (let i = 0; i < 100; i += 1) summary.noteConnection("browser");
    advance(1_000);
    for (let i = 0; i < 99; i += 1) summary.noteRequest(viaServe("100.64.0.7"), "invoke");
    advance(5_000);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      windows: 1,
      durationMs: 1_000,
      requests: 99,
      connections: 100,
      peakRequests: 99,
      peakConnections: 100,
    });
  });

  test("a request-hot burst includes quiet-window connections in its peak", () => {
    const { summary, reports, advance } = harness();
    for (let i = 0; i < 100; i += 1) summary.noteRequest(viaServe("100.64.0.7"), "invoke");
    advance(1_000);
    for (let i = 0; i < 99; i += 1) summary.noteConnection("browser");
    advance(5_000);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      windows: 1,
      durationMs: 1_000,
      requests: 100,
      connections: 99,
      peakRequests: 100,
      peakConnections: 99,
    });
  });

  test("bursts closer together than thirty seconds share one line", () => {
    const { summary, reports, advance } = harness();
    const spike = () => {
      for (let i = 0; i < 120; i += 1) summary.noteRequest(viaServe("100.64.0.7"), "invoke");
    };
    spike();
    for (let window = 0; window < 6; window += 1) advance(1_000);
    expect(reports).toHaveLength(1);

    spike();
    advance(1_000);
    advance(8_000);
    spike();
    advance(1_000);
    for (let window = 0; window < 8; window += 1) advance(1_000);
    expect(reports).toHaveLength(1);

    for (let window = 0; window < 15; window += 1) advance(1_000);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ windows: 2, requests: 240, peakRequests: 120 });
  });

  test("a burst that never stops is reported every minute", () => {
    const { summary, reports, advance } = harness();
    for (let second = 0; second < 125; second += 1) {
      for (let i = 0; i < 110; i += 1) summary.noteRequest(viaServe("100.64.0.7"), "invoke");
      advance(1_000);
    }
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ windows: 60, durationMs: 60_000, requests: 6_600 });
  });

  test("stop reports an open burst at once", () => {
    const { summary, reports, timers } = harness();
    for (let i = 0; i < 100; i += 1) summary.noteRequest(viaServe("100.64.0.7"), "static");
    summary.flush();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ requests: 100, routes: "static=100" });
    expect(timers().cancelled).toBe(1);
  });

  test("distinct sources are bounded and the rest count as other", () => {
    const { summary, reports } = harness();
    for (let i = 0; i < GATEWAY_TRAFFIC_MAX_KEYS + 40; i += 1) {
      summary.noteRequest(viaServe(`100.64.1.${i}`), "invoke");
    }
    summary.flush();
    const sources = reports[0]!.sources.split(",");
    expect(sources).toHaveLength(8);
    expect(sources[0]).toBe("other=40");
  });

  test("a burst line says how its sockets closed and how many carried one request", () => {
    const { summary, reports, advance } = harness();
    const churned = Array.from({ length: 120 }, () => ({ remoteAddress: "100.64.0.7" }));
    const reused = { remoteAddress: "100.64.0.8" };
    for (const socket of churned) {
      summary.noteConnection("browser");
      summary.noteRequest({ socket, headers: {} } as unknown as IncomingMessage, "invoke");
    }
    summary.noteConnection("browser");
    for (let i = 0; i < 5; i += 1) {
      summary.noteRequest({ socket: reused, headers: {} } as unknown as IncomingMessage, "invoke");
    }
    churned.slice(0, 100).forEach((socket) => summary.noteSocketClosed(socket, "peer"));
    churned.slice(100).forEach((socket) => summary.noteSocketClosed(socket, "error"));
    summary.noteSocketClosed(reused, "server");

    for (let window = 0; window < 6; window += 1) advance(1_000);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      connections: 121,
      closedByPeer: 100,
      closedByServer: 1,
      closedOnError: 20,
      singleRequestSockets: 120,
    });
  });
});
