import type { CounterFile, DeltaTotals, RouteTotals } from "./conditional-reads-bridge-counter";

type Counters = { routes: Record<string, RouteTotals>; delta: DeltaTotals };
const EMPTY_ROUTE: RouteTotals = {
  count: 0,
  bytes: 0,
  decodedBytes: 0,
  ms: 0,
  maxMs: 0,
  repeats: 0,
};
const empty = (): Counters => ({
  routes: {},
  delta: {
    snapshots: 0,
    snapshotBytes: 0,
    estimatedDeltaBytes: 0,
    changedRows: 0,
    rows: 0,
    trimmedHeads: 0,
  },
});

/** Response completion timestamps use the same wall clock and half-open window as renderer answers. */
export function summarizeCounters(files: CounterFile[], from: number, to: number) {
  if (!files.length) throw new Error("Missing bridge instrumentation");
  const total = empty();
  for (const file of files) {
    if (file.flushedAt < to) throw new Error("Bridge counter has not flushed the window");
    if (file.droppedThrough >= from)
      throw new Error("Bridge counter window exceeded its bounded history");
    for (const sample of file.samples) {
      if (sample.at < from || sample.at >= to) continue;
      const into = (total.routes[sample.label] ??= { ...EMPTY_ROUTE });
      for (const key of Object.keys(into) as Array<keyof RouteTotals>) {
        if (key === "maxMs") into[key] = Math.max(into[key], sample.route[key]);
        else into[key] += sample.route[key];
      }
      for (const key of Object.keys(total.delta) as Array<keyof DeltaTotals>)
        total.delta[key] += sample.delta[key];
    }
  }
  return countersBetween(empty(), total);
}

function countersBetween(before: Counters, after: Counters) {
  const routes: Record<string, Omit<RouteTotals, "maxMs"> & { meanMs: number }> = {};
  for (const [route, value] of Object.entries(after.routes)) {
    const start = before.routes[route] ?? EMPTY_ROUTE;
    const count = value.count - start.count;
    if (count > 0)
      routes[route] = {
        count,
        bytes: value.bytes - start.bytes,
        decodedBytes: value.decodedBytes - start.decodedBytes,
        ms: Math.round(value.ms - start.ms),
        meanMs: Number(((value.ms - start.ms) / count).toFixed(2)),
        repeats: value.repeats - start.repeats,
      };
  }
  const delta = { ...after.delta };
  for (const key of Object.keys(delta) as Array<keyof DeltaTotals>) delta[key] -= before.delta[key];
  return { routes, delta };
}

export function assertWindowEvidence(
  window: {
    bridge: ReturnType<typeof summarizeCounters>;
    renderer: Record<string, Record<string, number>>;
  },
  viewers: readonly string[],
  streaming: boolean,
) {
  // Claude's bridge answers state on `/session/:id`, Codex's on `/session/:id/status`.
  if (
    !(window.bridge.routes["GET /session/:id"]?.count > 0) &&
    !(window.bridge.routes["GET /session/:id/status"]?.count > 0)
  )
    throw new Error("Missing bridge state observations");
  const transcripts = Object.entries(window.bridge.routes).filter(([label]) =>
    label.startsWith("GET /session/:id/transcript?"),
  );
  if (!transcripts.some(([, value]) => value.count > 0))
    throw new Error("Missing bridge transcript observations");
  if (streaming && window.bridge.delta.snapshots < 1)
    throw new Error("Missing measured transcript snapshots");
  for (const viewer of viewers) {
    const bucket = window.renderer[viewer];
    if (
      !bucket ||
      !Object.entries(bucket).some(([key, count]) => key.startsWith("transcript:") && count > 0) ||
      !Object.entries(bucket).some(([key, count]) => key.startsWith("state:") && count > 0)
    )
      throw new Error("Missing expected viewer responses");
  }
}

export async function withCleanup<T>(
  run: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  try {
    return await run();
  } finally {
    await cleanup();
  }
}
