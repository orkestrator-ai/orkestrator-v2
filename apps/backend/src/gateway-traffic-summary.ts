import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("gateway");

/** Length of one counting window. */
export const GATEWAY_TRAFFIC_WINDOW_MS = 1_000;
/** Requests or new connections in one window that make it a burst. */
export const GATEWAY_TRAFFIC_BURST_THRESHOLD = 100;
/** Quiet windows in a row that end a burst. */
export const GATEWAY_TRAFFIC_QUIET_WINDOWS = 5;
/** Least time between two summary lines; nearer bursts are merged. */
export const GATEWAY_TRAFFIC_MIN_REPORT_INTERVAL_MS = 30_000;
/** A burst still running after this long is reported and a new one starts. */
export const GATEWAY_TRAFFIC_MAX_BURST_MS = 60_000;
/** Distinct keys kept per dimension; the rest are counted under `other`. */
export const GATEWAY_TRAFFIC_MAX_KEYS = 64;
/** Keys written per dimension in one summary line. */
export const GATEWAY_TRAFFIC_TOP_KEYS = 8;

const OTHER_KEY = "other";

/** Everything a summary line carries. Addresses, route classes and command names only. */
export type GatewayTrafficSummaryFields = {
  windows: number;
  durationMs: number;
  requests: number;
  connections: number;
  peakRequests: number;
  peakConnections: number;
  openSockets: number;
  sources: string;
  routes: string;
  clients: string;
  listeners: string;
  invokes: string;
};

type Counts = Map<string, number>;

type Tally = {
  requests: number;
  connections: number;
  sources: Counts;
  routes: Counts;
  clients: Counts;
  listeners: Counts;
  invokes: Counts;
};

type Burst = Tally & {
  startedAt: number;
  lastHotAt: number;
  windows: number;
  peakRequests: number;
  peakConnections: number;
  quietWindows: number;
};

export type GatewayTrafficSummaryOptions = {
  now?: () => number;
  /** Runs `tick` every window while a burst is open; returns its cancel. */
  schedule?: (tick: () => void, intervalMs: number) => () => void;
  openSockets?: () => number;
  report?: (fields: GatewayTrafficSummaryFields) => void;
};

function emptyTally(): Tally {
  return {
    requests: 0,
    connections: 0,
    sources: new Map(),
    routes: new Map(),
    clients: new Map(),
    listeners: new Map(),
    invokes: new Map(),
  };
}

function increment(counts: Counts, key: string, by = 1): void {
  const slot = counts.has(key) || counts.size < GATEWAY_TRAFFIC_MAX_KEYS ? key : OTHER_KEY;
  counts.set(slot, (counts.get(slot) ?? 0) + by);
}

function merge(into: Counts, from: Counts): void {
  for (const [key, count] of from) increment(into, key, count);
}

function formatTop(counts: Counts): string {
  return Array.from(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, GATEWAY_TRAFFIC_TOP_KEYS)
    .map(([key, count]) => `${key}=${count}`)
    .join(",");
}

function defaultSchedule(tick: () => void, intervalMs: number): () => void {
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Where a request came from. Tailscale Serve connects from loopback and names
 * the tailnet device in `X-Forwarded-For`; that header is believed only on a
 * loopback connection and only when it is an IP literal, so a direct client
 * cannot write arbitrary text into the log.
 */
export function gatewayTrafficSource(request: IncomingMessage): string {
  const peer = request.socket?.remoteAddress ?? "";
  if (!isLoopback(peer)) return isIP(peer) ? peer.replace(/^::ffff:/, "") : "unknown";
  const forwarded = request.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
  if (raw === undefined) return "loopback";
  const last = raw.split(",").at(-1)?.trim() ?? "";
  return isIP(last) ? last.replace(/^::ffff:/, "") : "invalid";
}

/** A fixed client family from the user agent; never the user agent itself. */
export function gatewayTrafficClient(userAgent: string | undefined): string {
  if (!userAgent) return "none";
  if (/\bElectron\//.test(userAgent)) return "electron";
  if (/\bBun\//.test(userAgent)) return "bun";
  if (/^node$|\bundici\b/i.test(userAgent)) return "node";
  if (userAgent.startsWith("curl/")) return "curl";
  if (userAgent.startsWith("Go-http-client/")) return "go";
  if (/\bFirefox\//.test(userAgent)) return "firefox";
  if (/\b(Chrome|Chromium|CriOS|Edg)\//.test(userAgent)) return "chrome";
  if (/\bSafari\//.test(userAgent) || /\bAppleWebKit\//.test(userAgent)) return "safari";
  return "other";
}

/**
 * Counts gateway connections and requests per second and writes one
 * `traffic.burst` line when they spike, naming the sources, routes, client
 * families and invoke commands involved. Requests a full accept queue resets
 * never reach the gateway, so a burst's counts are what got through.
 */
export class GatewayTrafficSummary {
  private readonly now: () => number;
  private readonly schedule: NonNullable<GatewayTrafficSummaryOptions["schedule"]>;
  private readonly openSockets: () => number;
  private readonly report: (fields: GatewayTrafficSummaryFields) => void;
  private windowStart = 0;
  private window = emptyTally();
  private burst: Burst | null = null;
  private lastReportAt = Number.NEGATIVE_INFINITY;
  private cancelTicks: (() => void) | null = null;

  constructor(options: GatewayTrafficSummaryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
    this.openSockets = options.openSockets ?? (() => 0);
    this.report = options.report ?? ((fields) => log.warn("traffic.burst", fields));
    this.windowStart = this.now();
  }

  noteConnection(listener: string): void {
    this.advance();
    this.window.connections += 1;
    increment(this.window.listeners, listener);
    this.checkWindow();
  }

  noteRequest(request: IncomingMessage, route: string): void {
    this.advance();
    this.window.requests += 1;
    increment(this.window.sources, gatewayTrafficSource(request));
    increment(this.window.routes, route);
    const userAgent = request.headers["user-agent"];
    increment(this.window.clients, gatewayTrafficClient(userAgent));
    this.checkWindow();
  }

  /** `command` must already be a registered, metric-safe name. */
  noteInvoke(command: string): void {
    this.advance();
    increment(this.window.invokes, command);
  }

  /** Closes elapsed windows; reports a burst that has ended or run too long. */
  tick(): void {
    this.advance();
  }

  /** Reports an open burst at once, for shutdown. */
  flush(): void {
    this.advance();
    if (!this.burst && !this.isHot(this.window)) return;
    // Fold the window still in progress into the burst before reporting it.
    const now = this.now();
    this.closeWindow(now);
    this.closeBurst(now);
  }

  private checkWindow(): void {
    // Open the burst as soon as a window crosses the threshold, so its
    // timer runs even if the traffic stops dead right after.
    if (!this.burst && this.isHot(this.window)) this.openBurst(this.windowStart);
  }

  private isHot(tally: Tally): boolean {
    return (
      tally.requests >= GATEWAY_TRAFFIC_BURST_THRESHOLD ||
      tally.connections >= GATEWAY_TRAFFIC_BURST_THRESHOLD
    );
  }

  private advance(): void {
    const now = this.now();
    while (now - this.windowStart >= GATEWAY_TRAFFIC_WINDOW_MS) {
      this.closeWindow(this.windowStart + GATEWAY_TRAFFIC_WINDOW_MS);
      // A long idle gap is many empty windows; skip them in one step.
      if (!this.burst && this.window.requests === 0 && this.window.connections === 0) {
        this.windowStart = now - ((now - this.windowStart) % GATEWAY_TRAFFIC_WINDOW_MS);
      }
    }
  }

  private closeWindow(endedAt: number): void {
    const tally = this.window;
    this.window = emptyTally();
    this.windowStart = endedAt;
    const hot = this.isHot(tally);
    if (hot && !this.burst) this.openBurst(endedAt - GATEWAY_TRAFFIC_WINDOW_MS);
    const burst = this.burst;
    if (!burst) return;
    burst.requests += tally.requests;
    burst.connections += tally.connections;
    merge(burst.sources, tally.sources);
    merge(burst.routes, tally.routes);
    merge(burst.clients, tally.clients);
    merge(burst.listeners, tally.listeners);
    merge(burst.invokes, tally.invokes);
    burst.peakRequests = Math.max(burst.peakRequests, tally.requests);
    burst.peakConnections = Math.max(burst.peakConnections, tally.connections);
    if (hot) {
      burst.windows += 1;
      burst.lastHotAt = endedAt;
      burst.quietWindows = 0;
    } else {
      burst.quietWindows += 1;
    }
    const ended =
      burst.quietWindows >= GATEWAY_TRAFFIC_QUIET_WINDOWS &&
      endedAt - this.lastReportAt >= GATEWAY_TRAFFIC_MIN_REPORT_INTERVAL_MS;
    if (ended || endedAt - burst.startedAt >= GATEWAY_TRAFFIC_MAX_BURST_MS) {
      this.closeBurst(endedAt);
    }
  }

  private openBurst(startedAt: number): void {
    this.burst = {
      ...emptyTally(),
      startedAt,
      lastHotAt: startedAt,
      windows: 0,
      peakRequests: 0,
      peakConnections: 0,
      quietWindows: 0,
    };
    this.cancelTicks ??= this.schedule(() => this.tick(), GATEWAY_TRAFFIC_WINDOW_MS);
  }

  private closeBurst(at: number): void {
    const burst = this.burst;
    if (!burst) return;
    this.burst = null;
    this.cancelTicks?.();
    this.cancelTicks = null;
    this.lastReportAt = at;
    this.report({
      windows: burst.windows,
      durationMs: Math.max(0, burst.lastHotAt - burst.startedAt),
      requests: burst.requests,
      connections: burst.connections,
      peakRequests: burst.peakRequests,
      peakConnections: burst.peakConnections,
      openSockets: this.openSockets(),
      sources: formatTop(burst.sources),
      routes: formatTop(burst.routes),
      clients: formatTop(burst.clients),
      listeners: formatTop(burst.listeners),
      invokes: formatTop(burst.invokes),
    });
  }
}
