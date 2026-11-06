import { readFileSync } from "node:fs";
import process from "node:process";
import type { WindowSummary } from "./recurring-live-ab-summary";

/**
 * Merges `scripts/recurring-live-ab.ts` artifacts into one before-and-after
 * table: per label (`--label`, else the commit) and arm, each kind's starts and work
 * units per minute as the range over every run, then the process totals.
 *
 *   mise exec -- bun scripts/recurring-live-ab-compare.ts output/benchmarks/task1/idle-*.json
 *
 * Only runs without an error count. Missing kinds count as zero only in a
 * measured window; invalid or partial rates are unavailable, never zero.
 */

type Artifact = {
  commit?: string;
  label?: string;
  results?: Array<{ arm?: string; summary: WindowSummary | null; error?: string }>;
};

export type Side = { label: string; commit: string; arm: string; runs: WindowSummary[] };

export function collectSides(artifacts: Artifact[]): Side[] {
  const sides = new Map<string, Side>();
  const commits = new Map<string, string>();
  for (const artifact of artifacts) {
    const commit = artifact.commit ?? "unknown";
    const label = artifact.label ?? commit;
    if (commits.has(label) && commits.get(label) !== commit)
      throw new Error(`Conflicting commits for label ${label}`);
    commits.set(label, commit);
    for (const result of artifact.results ?? []) {
      if (result.error || !result.summary) continue;
      if (!result.arm) throw new Error(`Missing experiment arm for ${label}`);
      const key = JSON.stringify([label, result.arm]);
      const side = sides.get(key) ?? { label, commit, arm: result.arm, runs: [] };
      side.runs.push(result.summary);
      sides.set(key, side);
    }
  }
  return [...sides.values()];
}

/** `a` or `a–b` over the values, rounded to two places. */
export function range(values: Array<number | null | undefined>): string {
  if (
    values.length === 0 ||
    values.some((value) => typeof value !== "number" || !Number.isFinite(value))
  )
    return "—";
  const round = (value: number) => Math.round(value * 100) / 100;
  const low = round(Math.min(...(values as number[])));
  const high = round(Math.max(...(values as number[])));
  return low === high ? String(low) : `${low}–${high}`;
}

export function compareTable(sides: Side[]): string {
  const kinds = new Set<string>();
  const units = new Map<string, Set<string>>();
  for (const side of sides)
    for (const run of side.runs)
      for (const [kind, rates] of Object.entries(run.kinds)) {
        kinds.add(kind);
        const set = units.get(kind) ?? new Set<string>();
        for (const unit of Object.keys(rates.workUnitsPerMinute)) set.add(unit);
        units.set(kind, set);
      }
  const header = sides.map(
    (side) => `${side.label}/${side.arm} (${side.commit}, ${side.runs.length} runs)`,
  );
  const lines = [
    `| Kind | Per minute | ${header.join(" | ")} |`,
    `| --- | --- | ${sides.map(() => "---").join(" | ")} |`,
  ];
  for (const kind of [...kinds].sort()) {
    const rate = (summary: WindowSummary, unit?: string): number | undefined => {
      if (!Number.isFinite(summary.windowMs) || summary.windowMs <= 0 || summary.samples < 2)
        return undefined;
      const rates = summary.kinds[kind];
      if (!rates) return 0;
      if (rates.partial || !Number.isFinite(rates.observedMs) || rates.observedMs <= 0)
        return undefined;
      if (!unit) return rates.startedPerMinute;
      return Object.hasOwn(rates.workUnitsPerMinute, unit) ? rates.workUnitsPerMinute[unit] : 0;
    };
    const rows: Array<[string, (summary: WindowSummary) => number | undefined]> = [
      ["starts", (summary) => rate(summary)],
      ...[...(units.get(kind) ?? [])]
        .sort()
        .map(
          (unit) =>
            [unit, (summary: WindowSummary) => rate(summary, unit)] as [
              string,
              (summary: WindowSummary) => number | undefined,
            ],
        ),
    ];
    for (const [name, value] of rows) {
      lines.push(
        `| ${kind} | ${name} | ${sides.map((side) => range(side.runs.map((run) => (side.arm === "metrics-off" ? undefined : value(run))))).join(" | ")} |`,
      );
    }
  }
  const processRows: Array<[string, (summary: WindowSummary) => number | undefined]> = [
    ["backend CPU ms/min", (summary) => summary.processes.backend?.cpuMsPerMinute],
    [
      "backend RSS MiB, median",
      (summary) =>
        summary.processes.backend ? summary.processes.backend.rssKiBMedian / 1024 : undefined,
    ],
    ["Electron CPU ms/min", (summary) => summary.processes.electron?.cpuMsPerMinute],
  ];
  for (const [name, value] of processRows) {
    lines.push(
      `| process | ${name} | ${sides.map((side) => range(side.runs.map(value))).join(" | ")} |`,
    );
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: bun scripts/recurring-live-ab-compare.ts <artifact.json>...");
    process.exitCode = 2;
  } else {
    const artifacts = files.map((file) => JSON.parse(readFileSync(file, "utf8")) as Artifact);
    console.log(compareTable(collectSides(artifacts)));
  }
}
