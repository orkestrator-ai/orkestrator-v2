import { createLogger, type LogFields } from "@orkestrator/protocol/logger";

/**
 * Development-only memory sampling for the desktop's processes (plan 0004).
 *
 * When on, it logs one `process-memory` line per interval with the
 * working set of every Electron process type, then one
 * `process-memory.realm` line per workspace realm, labelled by a hash
 * of its node id (the same hash its storage partition uses), never by the
 * node's name, address or credential. Numbers only.
 *
 * It is off unless the desktop runs in development mode (`ELECTRON_DEV=1` on
 * an unpacked app, `desktopDevMode`) and `ORKESTRATOR_DEV_PROCESS_MEMORY_MS`
 * names an interval. A packaged app never samples, whatever its environment.
 */
export const PROCESS_MEMORY_DIAGNOSTIC_ENV = "ORKESTRATOR_DEV_PROCESS_MEMORY_MS";
export const PROCESS_MEMORY_MIN_INTERVAL_MS = 1_000;
export const PROCESS_MEMORY_MAX_INTERVAL_MS = 10 * 60_000;

const log = createLogger("desktop");

/** The parts of Electron's `ProcessMetric` this reads. Sizes are in kilobytes. */
export type ProcessMetricLike = {
  pid: number;
  type: string;
  memory: { workingSetSize: number; peakWorkingSetSize?: number; privateBytes?: number };
};

/** A workspace realm's renderer, as main knows it. */
export type RealmProcessLike = {
  pid: number;
  /** Hash of the realm's node id; see `connectionPartitionKey`. */
  nodeHash: string;
  visible: boolean;
};

export type ProcessMemorySample = {
  processes: number;
  totalWorkingSetKb: number;
  /** Working set per Electron process type (`Browser`, `Tab`, `GPU`, `Utility`, ...). */
  byType: Record<string, { count: number; workingSetKb: number }>;
  /** Renderers that are windows, not realms. */
  windowRenderers: { count: number; workingSetKb: number };
  realms: Array<{
    nodeHash: string;
    visible: boolean;
    workingSetKb: number;
    peakWorkingSetKb: number | null;
    privateKb: number | null;
  }>;
};

/** The sampling interval, or null when the diagnostic is off. */
export function processMemoryDiagnosticInterval(
  isDev: boolean,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (!isDev) return null;
  const raw = env[PROCESS_MEMORY_DIAGNOSTIC_ENV];
  if (!raw || !/^\d+$/u.test(raw)) return null;
  return Math.min(
    PROCESS_MEMORY_MAX_INTERVAL_MS,
    Math.max(PROCESS_MEMORY_MIN_INTERVAL_MS, Number(raw)),
  );
}

export function summarizeProcessMemory(
  metrics: readonly ProcessMetricLike[],
  realms: readonly RealmProcessLike[],
): ProcessMemorySample {
  const byType: ProcessMemorySample["byType"] = {};
  let totalWorkingSetKb = 0;
  for (const metric of metrics) {
    const bucket = (byType[metric.type] ??= { count: 0, workingSetKb: 0 });
    bucket.count += 1;
    bucket.workingSetKb += metric.memory.workingSetSize;
    totalWorkingSetKb += metric.memory.workingSetSize;
  }
  const realmPids = new Set(realms.map((realm) => realm.pid));
  const windowRenderers = { count: 0, workingSetKb: 0 };
  for (const metric of metrics) {
    if (metric.type !== "Tab" || realmPids.has(metric.pid)) continue;
    windowRenderers.count += 1;
    windowRenderers.workingSetKb += metric.memory.workingSetSize;
  }
  const byPid = new Map(metrics.map((metric) => [metric.pid, metric]));
  return {
    processes: metrics.length,
    totalWorkingSetKb,
    byType,
    windowRenderers,
    realms: realms.map((realm) => {
      const metric = byPid.get(realm.pid);
      return {
        nodeHash: realm.nodeHash,
        visible: realm.visible,
        workingSetKb: metric?.memory.workingSetSize ?? 0,
        peakWorkingSetKb: metric?.memory.peakWorkingSetSize ?? null,
        privateKb: metric?.memory.privateBytes ?? null,
      };
    }),
  };
}

/** Scalar log fields: one per process type, so the line stays greppable. */
export function processMemoryLogFields(sample: ProcessMemorySample): LogFields {
  const fields: Record<string, number> = {
    processes: sample.processes,
    totalWorkingSetKb: sample.totalWorkingSetKb,
    windowRenderers: sample.windowRenderers.count,
    windowRendererKb: sample.windowRenderers.workingSetKb,
    realms: sample.realms.length,
    realmKb: sample.realms.reduce((sum, realm) => sum + realm.workingSetKb, 0),
  };
  for (const [type, bucket] of Object.entries(sample.byType)) {
    const key = type.replace(/[^A-Za-z0-9]/gu, "");
    fields[`${key}Count`] = bucket.count;
    fields[`${key}Kb`] = bucket.workingSetKb;
  }
  return fields;
}

export function logProcessMemorySample(sample: ProcessMemorySample): void {
  log.info("process-memory", processMemoryLogFields(sample));
  for (const realm of sample.realms) {
    log.info("process-memory.realm", {
      node: realm.nodeHash,
      visible: realm.visible,
      workingSetKb: realm.workingSetKb,
      ...(realm.peakWorkingSetKb === null ? {} : { peakWorkingSetKb: realm.peakWorkingSetKb }),
      ...(realm.privateKb === null ? {} : { privateKb: realm.privateKb }),
    });
  }
}

/**
 * Sample on an interval until the returned stop is called. Does nothing (and
 * returns a no-op) when `intervalMs` is null. The timer is unref'd so it never
 * keeps the app alive; a failed read is skipped, never thrown.
 */
export function startProcessMemoryDiagnostic(options: {
  intervalMs: number | null;
  metrics: () => readonly ProcessMetricLike[];
  realms: () => readonly RealmProcessLike[];
  report?: (sample: ProcessMemorySample) => void;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}): () => void {
  const { intervalMs } = options;
  if (intervalMs === null) return () => undefined;
  const report = options.report ?? logProcessMemorySample;
  const setTimer = options.setIntervalImpl ?? setInterval;
  const clearTimer = options.clearIntervalImpl ?? clearInterval;
  const tick = () => {
    try {
      report(summarizeProcessMemory(options.metrics(), options.realms()));
    } catch (error) {
      log.debug("process-memory.failed", {
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
  };
  const timer = setTimer(tick, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimer(timer);
}
