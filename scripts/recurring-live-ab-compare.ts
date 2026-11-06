import { readFileSync } from "node:fs";
import process from "node:process";
import type { WindowSummary } from "./recurring-live-ab-summary";

/**
 * Merges `scripts/recurring-live-ab.ts` artifacts into one before-and-after
 * table: per label (`--label`, else the commit), each kind's starts and work
 * units per minute as the range over every run, then the process totals.
 *
 *   mise exec -- bun scripts/recurring-live-ab-compare.ts output/benchmarks/task1/idle-*.json
 *
 * Only runs without an error count. A kind missing from a run counts as 0 for
 * that run, so a kind one side never starts shows as `0` there.
 */

type Artifact = {
  commit?: string;
  label?: string;
  results?: Array<{ summary: WindowSummary | null; error?: string }>;
};

export type Side = { label: string; commit: string; runs: WindowSummary[] };

export function collectSides(artifacts: Artifact[]): Side[] {
  const sides = new Map<string, Side>();
  for (const artifact of artifacts) {
    const commit = artifact.commit ?? "unknown";
    const label = artifact.label ?? commit;
    const side = sides.get(label) ?? { label, commit, runs: [] };
    for (const result of artifact.results ?? []) {
      if (!result.error && result.summary) side.runs.push(result.summary);
    }
    sides.set(label, side);
  }
  return [...sides.values()];
}

/** `a` or `a–b` over the values, rounded to two places. */
export function range(values: number[]): string {
  if (values.length === 0) return "—";
  const round = (value: number) => Math.round(value * 100) / 100;
  const low = round(Math.min(...values));
  const high = round(Math.max(...values));
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
  const header = sides.map((side) => `${side.label} (${side.commit}, ${side.runs.length} runs)`);
  const lines = [
    `| Kind | Per minute | ${header.join(" | ")} |`,
    `| --- | --- | ${sides.map(() => "---").join(" | ")} |`,
  ];
  for (const kind of [...kinds].sort()) {
    const rows: Array<[string, (summary: WindowSummary) => number]> = [
      ["starts", (summary) => summary.kinds[kind]?.startedPerMinute ?? 0],
      ...[...(units.get(kind) ?? [])]
        .sort()
        .map(
          (unit) =>
            [
              unit,
              (summary: WindowSummary) => summary.kinds[kind]?.workUnitsPerMinute[unit] ?? 0,
            ] as [string, (summary: WindowSummary) => number],
        ),
    ];
    for (const [name, value] of rows) {
      lines.push(
        `| ${kind} | ${name} | ${sides.map((side) => range(side.runs.map(value))).join(" | ")} |`,
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
      `| process | ${name} | ${sides
        .map((side) =>
          range(side.runs.map(value).filter((entry): entry is number => entry !== undefined)),
        )
        .join(" | ")} |`,
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
