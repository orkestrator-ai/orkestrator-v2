/**
 * Signals from several machines as one set (docs/architecture/self-improvement.md,
 * "Leaf nodes"). A command node's run extracts signals from its own bundle and
 * from each connected leaf's, then merges them here, so the same problem on
 * two machines is one signal, one ticket and one verdict.
 *
 * Signatures do not change: a machine is never part of one, so the ledger's
 * entries keep matching. What changes is the measure:
 *
 * - A rate is occurrences per machine-day of observed source exposure.
 *   Fix verdicts use a separate baseline over the machines that saw the fault.
 * - A gauge is the worst value on any machine.
 * - The score ranks by the fleet's total rate, so a problem on every machine
 *   outranks the same problem on one.
 *
 * Pure: no I/O. With one machine, the extraction is returned unchanged.
 */
import {
  compareVersions,
  type ExtractedSignals,
  HOST_RESTARTED_SIGNATURE,
  type ObservedHours,
  scoreSignal,
  type Signal,
  type SignalSource,
  UNKNOWN_VERSION,
} from "./signals.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCES: readonly SignalSource[] = [
  "essential-log",
  "health-summary",
  "database",
  "insights",
];

export interface MachineSignals {
  nodeId: string;
  name: string;
  extracted: ExtractedSignals;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function observedSourceHours(extracted: ExtractedSignals, source: SignalSource): number {
  return Object.values(extracted.observedHours[source] ?? {}).reduce(
    (sum, value) => sum + value,
    0,
  );
}

/** Run endings come from the health rows, or the essential log when a bundle has none. */
export function diagnosticSource(signature: string, source: SignalSource, machine: MachineSignals) {
  return signature === "backend:crashed" || signature === HOST_RESTARTED_SIGNATURE
    ? (machine.extracted.crashSource ?? source)
    : source;
}

function mergeObservedHours(machines: readonly MachineSignals[]): ObservedHours {
  const merged = Object.fromEntries(SOURCES.map((source) => [source, {}])) as ObservedHours;
  for (const machine of machines) {
    for (const source of SOURCES) {
      for (const [version, hours] of Object.entries(
        machine.extracted.observedHours[source] ?? {},
      )) {
        merged[source][version] = round((merged[source][version] ?? 0) + hours);
      }
    }
  }
  return merged;
}

function mergeWindow(machines: readonly MachineSignals[]): ExtractedSignals["window"] {
  const froms = machines
    .map((machine) => Date.parse(machine.extracted.window.from ?? ""))
    .filter(Number.isFinite);
  const tos = machines
    .map((machine) => Date.parse(machine.extracted.window.to ?? ""))
    .filter(Number.isFinite);
  const from = froms.length > 0 ? Math.min(...froms) : null;
  const to = tos.length > 0 ? Math.max(...tos) : null;
  return {
    from: from === null ? null : new Date(from).toISOString(),
    to: to === null ? null : new Date(to).toISOString(),
    days: round(
      from !== null && to !== null
        ? Math.max((to - from) / DAY_MS, 1 / 24)
        : Math.max(...machines.map((machine) => machine.extracted.window.days), 1 / 24),
    ),
  };
}

function mergeGroup(
  group: ReadonlyArray<{ machine: MachineSignals; signal: Signal }>,
  machines: readonly MachineSignals[],
  windowDays: number,
): Signal {
  // The machine that saw it most leads: its title and evidence describe it best.
  const ordered = [...group].sort(
    (left, right) =>
      right.signal.count - left.signal.count || right.signal.score - left.signal.score,
  );
  const lead = ordered[0]!.signal;
  const versions: Signal["versions"] = {};
  for (const { signal } of group) {
    for (const [version, slice] of Object.entries(signal.versions)) {
      const merged = (versions[version] ??= { count: 0 });
      merged.count += slice.count;
      if (slice.value !== undefined) {
        merged.value = Math.max(merged.value ?? Number.NEGATIVE_INFINITY, slice.value);
      }
    }
  }
  const count = group.reduce((sum, { signal }) => sum + signal.count, 0);
  const firsts = group
    .map(({ signal }) => Date.parse(signal.firstAt ?? ""))
    .filter(Number.isFinite);
  const lasts = group.map(({ signal }) => Date.parse(signal.lastAt ?? "")).filter(Number.isFinite);
  let value: number;
  if (lead.measure.kind === "gauge") {
    value = Math.max(...group.map(({ signal }) => signal.measure.value));
  } else {
    const exposure = new Map(
      machines.map((machine) => [
        machine.nodeId,
        observedSourceHours(
          machine.extracted,
          diagnosticSource(lead.signature, lead.source, machine),
        ),
      ]),
    );
    const hours = Array.from(exposure.values()).reduce((sum, value) => sum + value, 0);
    const observedCount = group.reduce(
      (sum, { machine, signal }) =>
        sum + ((exposure.get(machine.nodeId) ?? 0) > 0 ? signal.count : 0),
      0,
    );
    value = hours > 0 ? (observedCount / hours) * 24 : lead.measure.value;
  }
  const signal: Signal = {
    signature: lead.signature,
    category: lead.category,
    source: lead.source,
    title: lead.title,
    count,
    firstAt: firsts.length > 0 ? new Date(Math.min(...firsts)).toISOString() : null,
    lastAt: lasts.length > 0 ? new Date(Math.max(...lasts)).toISOString() : null,
    // Days on different machines may coincide, so the busiest machine's count is the floor.
    activeDays: Math.max(...group.map(({ signal: one }) => one.activeDays)),
    measure: { ...lead.measure, value: round(value) },
    versions,
    evidence: {
      ...lead.evidence,
      machines: ordered.map(({ machine }) => machine.name).join(", "),
    },
    score: 0,
  };
  // Ranked by how often it happens across the fleet, so a problem on every
  // machine outranks the same problem on one; the measure stays per machine.
  signal.score = scoreSignal(
    lead.measure.kind === "rate"
      ? { ...signal, measure: { ...signal.measure, value: count / Math.max(windowDays, 1 / 24) } }
      : signal,
  );
  return signal;
}

/**
 * One extraction for every machine: signals with the same signature merged,
 * observed hours summed per version, the window spanning every machine's.
 * Insight signals are not here: themes are built once from every machine's
 * notes (`insights/analyze.ts`).
 */
export function mergeMachineSignals(machines: readonly MachineSignals[]): ExtractedSignals {
  if (machines.length === 0) throw new Error("No machine's signals to merge.");
  if (machines.length === 1) return machines[0]!.extracted;
  const groups = new Map<string, Array<{ machine: MachineSignals; signal: Signal }>>();
  for (const machine of machines) {
    for (const signal of machine.extracted.signals) {
      const group = groups.get(signal.signature) ?? [];
      group.push({ machine, signal });
      groups.set(signal.signature, group);
    }
  }
  const window = mergeWindow(machines);
  const signals = Array.from(groups.values())
    .map((group) => mergeGroup(group, machines, window.days))
    .sort(
      (left, right) => right.score - left.score || left.signature.localeCompare(right.signature),
    );
  return {
    window,
    signals,
    observedHours: mergeObservedHours(machines),
  };
}

/** The newest of several app versions; a ticket done now is fixed only after all of them. */
export function newestVersion(versions: readonly string[]): string {
  const known = versions.filter((version) => version && version !== UNKNOWN_VERSION);
  if (known.length === 0) return versions[0] ?? UNKNOWN_VERSION;
  return known.reduce((newest, version) =>
    compareVersions(version, newest) > 0 ? version : newest,
  );
}
