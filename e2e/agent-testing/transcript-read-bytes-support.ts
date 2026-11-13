/**
 * Per-window figures for `transcript-read-bytes-live.spec.ts` (to-do 5340
 * (retired), task 1): what a bridge answered in each measured window, split
 * into transcript reads, state reads, the backend's background timers and
 * everything else.
 * Counts, bytes and milliseconds only.
 */
import type { summarizeCounters } from "./conditional-reads-measurement";

export type ReadWindowKind =
  "idle-background" | "running-background" | "turn-check" | "pre-e9-turn-check" | "prompt-send";

export interface ReadWindow {
  kind: ReadWindowKind;
  from: number;
  to: number;
  /** Prompt sends: time until the dispatch command answered. */
  dispatchMs?: number;
  /** Prompt sends: time until the model held the call. */
  modelReachedMs?: number;
}

type Counters = ReturnType<typeof summarizeCounters>;

export type RouteClass = "background" | "transcript" | "state" | "other";

/**
 * The backend's own timers read the bridge whatever a client does: the
 * activity sweep (every two seconds, for every persisted session) and the
 * change-evidence poll. Those are reported apart. Transcript reads are the
 * rows routes; state reads are the snapshot routes a turn check is meant to
 * use.
 */
export function routeClass(label: string): RouteClass {
  if (
    label.startsWith("POST /sessions/activity") ||
    /^GET \/session\/:id\/activity(\?|$)/.test(label) ||
    /^(GET|POST) \/change-evidence(\/|\?|$)/.test(label)
  )
    return "background";
  if (/^GET \/session\/:id\/(transcript|messages)(\/|\?|$)/.test(label)) return "transcript";
  if (/^GET \/session\/:id(\/status|\/state)?(\?|$)/.test(label)) return "state";
  return "other";
}

export interface WindowFigures {
  kind: ReadWindowKind;
  ms: number;
  dispatchMs?: number;
  modelReachedMs?: number;
  /** Everything but the backend's background timers. */
  requests: number;
  bytes: number;
  decodedBytes: number;
  transcriptRequests: number;
  transcriptBytes: number;
  stateRequests: number;
  stateBytes: number;
  backgroundRequests: number;
  backgroundBytes: number;
  routes: Record<string, { count: number; bytes: number }>;
}

export interface KindSummary {
  windows: number;
  meanRequests: number;
  meanBytes: number;
  minBytes: number;
  maxBytes: number;
  meanDecodedBytes: number;
  meanTranscriptBytes: number;
  meanStateBytes: number;
  meanBackgroundBytes: number;
  /** Requests and bytes per route over all windows of this kind. */
  routes: Record<string, { count: number; bytes: number }>;
}

const mean = (values: number[]) =>
  values.length ? Math.round(values.reduce((total, value) => total + value, 0) / values.length) : 0;

export function windowFigures(window: ReadWindow, counters: Counters): WindowFigures {
  const figures: WindowFigures = {
    kind: window.kind,
    ms: window.to - window.from,
    ...(window.dispatchMs === undefined ? {} : { dispatchMs: window.dispatchMs }),
    ...(window.modelReachedMs === undefined ? {} : { modelReachedMs: window.modelReachedMs }),
    requests: 0,
    bytes: 0,
    decodedBytes: 0,
    transcriptRequests: 0,
    transcriptBytes: 0,
    stateRequests: 0,
    stateBytes: 0,
    backgroundRequests: 0,
    backgroundBytes: 0,
    routes: {},
  };
  for (const [label, route] of Object.entries(counters.routes)) {
    figures.routes[label] = { count: route.count, bytes: route.bytes };
    const kind = routeClass(label);
    if (kind === "background") {
      figures.backgroundRequests += route.count;
      figures.backgroundBytes += route.bytes;
      continue;
    }
    figures.requests += route.count;
    figures.bytes += route.bytes;
    figures.decodedBytes += route.decodedBytes;
    if (kind === "transcript") {
      figures.transcriptRequests += route.count;
      figures.transcriptBytes += route.bytes;
    } else if (kind === "state") {
      figures.stateRequests += route.count;
      figures.stateBytes += route.bytes;
    }
  }
  return figures;
}

export function summarizeWindows(windows: WindowFigures[]): Record<string, KindSummary> {
  const byKind = new Map<ReadWindowKind, WindowFigures[]>();
  for (const window of windows) {
    const list = byKind.get(window.kind) ?? [];
    list.push(window);
    byKind.set(window.kind, list);
  }
  const summary: Record<string, KindSummary> = {};
  for (const [kind, list] of byKind) {
    const routes: KindSummary["routes"] = {};
    for (const window of list) {
      for (const [label, route] of Object.entries(window.routes)) {
        const into = (routes[label] ??= { count: 0, bytes: 0 });
        into.count += route.count;
        into.bytes += route.bytes;
      }
    }
    const bytes = list.map((window) => window.bytes);
    summary[kind] = {
      windows: list.length,
      meanRequests: Number(
        (list.reduce((total, window) => total + window.requests, 0) / list.length).toFixed(2),
      ),
      meanBytes: mean(bytes),
      minBytes: Math.min(...bytes),
      maxBytes: Math.max(...bytes),
      meanDecodedBytes: mean(list.map((window) => window.decodedBytes)),
      meanTranscriptBytes: mean(list.map((window) => window.transcriptBytes)),
      meanStateBytes: mean(list.map((window) => window.stateBytes)),
      meanBackgroundBytes: mean(list.map((window) => window.backgroundBytes)),
      routes,
    };
  }
  return summary;
}

export function readWindowFigures(
  windows: readonly ReadWindow[],
  read: (from: number, to: number) => Counters,
): { windows: WindowFigures[]; summary: Record<string, KindSummary> } {
  const figures = windows.map((window) => windowFigures(window, read(window.from, window.to)));
  return { windows: figures, summary: summarizeWindows(figures) };
}
