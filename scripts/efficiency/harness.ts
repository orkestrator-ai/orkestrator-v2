import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Function-level efficiency harness: types, runner and comparison.
 *
 * Workloads import repository modules from an explicit root, so the same
 * harness measures a baseline worktree and the current tree. Deterministic
 * operation counts are the primary result and are compared exactly; the
 * wall-clock figures are secondary, machine-specific and never compared.
 */

export const EFFICIENCY_SCHEMA_VERSION = 1;

export type CounterValue = number | string | boolean;

export interface CaseResult {
  counters: Record<string, CounterValue>;
  /** Time of the measured operation only, excluding fixture setup. */
  measuredMs?: number;
}

export interface CaseDefinition {
  id: string;
  description: string;
  /** Omitted when the API does not exist at this root. */
  run?: () => Promise<CaseResult>;
  unsupportedReason?: string;
  /** Overrides the run's repetition count for expensive cases. */
  repetitions?: number;
}

export interface WorkloadDefinition {
  id: string;
  title: string;
  findings: string[];
  fixture: Record<string, CounterValue>;
  method: string;
  cases: CaseDefinition[];
}

export interface WorkloadContext {
  /** Repository root the workload imports from. */
  root: string;
  /** Import a module relative to `root`. */
  load<T = Record<string, unknown>>(relativePath: string): Promise<T>;
  /** Import when present, `undefined` when this root predates the module. */
  loadOptional<T = Record<string, unknown>>(relativePath: string): Promise<T | undefined>;
}

export interface CaseReport {
  id: string;
  description: string;
  supported: boolean;
  unsupportedReason?: string;
  counters?: Record<string, CounterValue>;
  /** True when every repetition produced identical counters. */
  countersStable?: boolean;
  /** Names of the counters that varied between repetitions, when any did. */
  unstableCounters?: string[];
  timing?: {
    repetitions: number;
    coldMs: number;
    warmP50Ms: number;
    warmP95Ms: number;
  };
}

export interface WorkloadReport {
  id: string;
  title: string;
  findings: string[];
  fixture: Record<string, CounterValue>;
  method: string;
  cases: CaseReport[];
}

export interface EfficiencyReport {
  schemaVersion: number;
  generatedBy: "scripts/efficiency/run.ts";
  runId: string;
  label: string;
  source: { commit: string; appVersion: string };
  runtime: { bun: string; platform: string; arch: string };
  machine: { cpuModel: string; cpuCount: number; totalMemoryBytes: number };
  method: Record<string, string | number | boolean>;
  startedAt: string;
  finishedAt: string;
  workloads: WorkloadReport[];
}

export function createContext(root: string): WorkloadContext {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    load: async (relativePath) => import(path.join(resolved, relativePath)),
    loadOptional: async (relativePath) => {
      const file = path.join(resolved, relativePath);
      return existsSync(file) ? import(file) : undefined;
    },
  };
}

export function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index]!;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Runs one case `repetitions` times. Repetition 0 is the cold run (first call
 * of that code in this process); the rest are warm. Counters come from the
 * cold run and are checked for stability across the warm ones.
 */
export async function runCase(
  definition: CaseDefinition,
  repetitions: number,
): Promise<CaseReport> {
  if (!definition.run) {
    return {
      id: definition.id,
      description: definition.description,
      supported: false,
      unsupportedReason: definition.unsupportedReason ?? "not available at this revision",
    };
  }
  const count = Math.max(1, definition.repetitions ?? repetitions);
  const times: number[] = [];
  let first: CaseResult | undefined;
  const unstable = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    const result = await definition.run();
    const elapsed = result.measuredMs ?? performance.now() - started;
    times.push(elapsed);
    if (!first) first = result;
    else {
      for (const name of new Set([
        ...Object.keys(first.counters),
        ...Object.keys(result.counters),
      ])) {
        if (first.counters[name] !== result.counters[name]) unstable.add(name);
      }
    }
  }
  const warm = times.slice(1);
  return {
    id: definition.id,
    description: definition.description,
    supported: true,
    counters: first!.counters,
    countersStable: unstable.size === 0,
    ...(unstable.size > 0 ? { unstableCounters: [...unstable].toSorted() } : {}),
    timing: {
      repetitions: count,
      coldMs: round(times[0]!),
      warmP50Ms: round(percentile(warm.length > 0 ? warm : times, 0.5)),
      warmP95Ms: round(percentile(warm.length > 0 ? warm : times, 0.95)),
    },
  };
}

export function machineInfo(): EfficiencyReport["machine"] {
  const cpus = os.cpus();
  return {
    cpuModel: cpus[0]?.model?.trim() ?? "unknown",
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
  };
}

export function sourceInfo(root: string): EfficiencyReport["source"] {
  const result = Bun.spawnSync(["git", "rev-parse", "--short=12", "HEAD"], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
  });
  const commit = result.stdout.toString().trim();
  let appVersion = "unknown";
  try {
    appVersion =
      (
        JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
          version?: string;
        }
      ).version ?? "unknown";
  } catch {
    // An unreadable manifest leaves the version unknown rather than failing the run.
  }
  return {
    commit: result.exitCode === 0 && /^[0-9a-f]+$/.test(commit) ? commit : "unknown",
    appVersion,
  };
}

// --- Comparison ----------------------------------------------------------------

export interface CounterDifference {
  workload: string;
  caseId: string;
  counter: string;
  /** A counter value, or the case's availability when it is not measured in both. */
  baseline: CounterValue;
  candidate: CounterValue;
}

function caseMap(report: EfficiencyReport): Map<string, CaseReport> {
  const cases = new Map<string, CaseReport>();
  for (const workload of report.workloads) {
    for (const entry of workload.cases) cases.set(`${workload.id}\0${entry.id}`, entry);
  }
  return cases;
}

/** Every deterministic counter that differs; timings are never compared. */
export function compareReports(
  baseline: EfficiencyReport,
  candidate: EfficiencyReport,
): CounterDifference[] {
  const before = caseMap(baseline);
  const after = caseMap(candidate);
  const differences: CounterDifference[] = [];
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    const [workload, caseId] = key.split("\0") as [string, string];
    const left = before.get(key);
    const right = after.get(key);
    if (!left?.supported || !right?.supported) {
      const state = (entry: CaseReport | undefined) =>
        entry ? (entry.supported ? "supported" : "unsupported") : "absent";
      if (state(left) !== state(right)) {
        differences.push({
          workload,
          caseId,
          counter: "*",
          baseline: state(left),
          candidate: state(right),
        });
      }
      continue;
    }
    const names = new Set([
      ...Object.keys(left.counters ?? {}),
      ...Object.keys(right.counters ?? {}),
    ]);
    for (const counter of names) {
      const from = left.counters?.[counter];
      const to = right.counters?.[counter];
      if (from !== to) {
        differences.push({
          workload,
          caseId,
          counter,
          baseline: from ?? "absent",
          candidate: to ?? "absent",
        });
      }
    }
  }
  return differences;
}

/**
 * A compact before/after artifact small enough to commit: counters from both
 * runs side by side, the warm p50 per case, and the run metadata. Per-rep
 * timings and fixture payloads never appear in it.
 */
export function summarizeReports(
  baseline: EfficiencyReport,
  candidate: EfficiencyReport,
): Record<string, unknown> {
  const before = caseMap(baseline);
  const strip = (report: EfficiencyReport) => ({
    label: report.label,
    runId: report.runId,
    source: report.source,
    runtime: report.runtime,
    startedAt: report.startedAt,
  });
  return {
    schemaVersion: EFFICIENCY_SCHEMA_VERSION,
    generatedBy: "scripts/efficiency/run.ts",
    machine: candidate.machine,
    method: candidate.method,
    baseline: strip(baseline),
    candidate: strip(candidate),
    workloads: candidate.workloads.map((workload) => ({
      id: workload.id,
      title: workload.title,
      findings: workload.findings,
      fixture: workload.fixture,
      method: workload.method,
      cases: workload.cases.map((entry) => {
        const prior = before.get(`${workload.id}\0${entry.id}`);
        return {
          id: entry.id,
          baseline: prior?.supported
            ? { counters: prior.counters, warmP50Ms: prior.timing?.warmP50Ms }
            : { unsupported: prior?.unsupportedReason ?? "absent from baseline run" },
          candidate: entry.supported
            ? { counters: entry.counters, warmP50Ms: entry.timing?.warmP50Ms }
            : { unsupported: entry.unsupportedReason },
          ...(entry.unstableCounters || prior?.unstableCounters
            ? {
                unstableCounters: {
                  baseline: prior?.unstableCounters ?? [],
                  candidate: entry.unstableCounters ?? [],
                },
              }
            : {}),
        };
      }),
    })),
  };
}
