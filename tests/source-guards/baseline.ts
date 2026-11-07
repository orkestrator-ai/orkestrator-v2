import path from "node:path";
import { GUARD_IDS, type GuardId } from "./guard";
import type { Finding, Findings } from "./scan";

/** Per guard, per repository-relative file, how many findings are tolerated. */
export type Baseline = Record<GuardId, Record<string, number>>;

export const BASELINE_PATH = path.join(import.meta.dir, "baseline.json");
export const REGENERATE_COMMAND = "bun tests/source-guards/update-baseline.ts";

export function baselineFromFindings(findings: Findings): Baseline {
  const baseline = {} as Baseline;
  for (const guard of GUARD_IDS) {
    baseline[guard] = {};
    for (const file of Object.keys(findings[guard]).sort())
      baseline[guard][file] = findings[guard][file]!.length;
  }
  return baseline;
}

/** Stable text: guards in declaration order, files sorted, trailing newline. */
export function serializeBaseline(baseline: Baseline): string {
  const ordered: Record<string, Record<string, number>> = {};
  for (const guard of GUARD_IDS) {
    ordered[guard] = {};
    for (const file of Object.keys(baseline[guard] ?? {}).sort())
      ordered[guard][file] = baseline[guard][file]!;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function parseBaseline(text: string): Baseline {
  const parsed = JSON.parse(text) as Partial<Baseline>;
  const baseline = {} as Baseline;
  for (const guard of GUARD_IDS) baseline[guard] = { ...parsed[guard] };
  return baseline;
}

export interface Regression {
  guard: GuardId;
  file: string;
  allowed: number;
  findings: Finding[];
}

export interface StaleEntry {
  guard: GuardId;
  file: string;
  allowed: number;
  actual: number;
}

export interface RatchetResult {
  /** Files offending more than the baseline allows (a file absent from it allows none). */
  regressions: Regression[];
  /** Baseline entries above what the file now has, so the baseline can shrink. */
  stale: StaleEntry[];
}

export function compareWithBaseline(findings: Findings, baseline: Baseline): RatchetResult {
  const regressions: Regression[] = [];
  const stale: StaleEntry[] = [];
  for (const guard of GUARD_IDS) {
    const actual = findings[guard];
    const allowedByFile = baseline[guard] ?? {};
    for (const file of Object.keys(actual).sort()) {
      const allowed = allowedByFile[file] ?? 0;
      if (actual[file]!.length > allowed)
        regressions.push({ guard, file, allowed, findings: actual[file]! });
    }
    for (const file of Object.keys(allowedByFile).sort()) {
      const count = actual[file]?.length ?? 0;
      if (count < allowedByFile[file]!)
        stale.push({ guard, file, allowed: allowedByFile[file]!, actual: count });
    }
  }
  return { regressions, stale };
}

export function formatRegressions(
  regressions: readonly Regression[],
  advice: Readonly<Record<GuardId, string>>,
): string {
  if (regressions.length === 0) return "";
  const lines = [
    "New source-guard findings. Fix them; do not raise the baseline to hide them.",
    "",
  ];
  for (const guard of GUARD_IDS) {
    const own = regressions.filter((regression) => regression.guard === guard);
    if (own.length === 0) continue;
    lines.push(`[${guard}] ${advice[guard]}`);
    for (const regression of own) {
      lines.push(
        `  ${regression.file}: ${regression.findings.length} finding(s), baseline allows ${regression.allowed}`,
      );
      for (const finding of regression.findings) lines.push(`    ${finding.file}:${finding.line}`);
    }
    lines.push("");
  }
  lines.push(
    "Each file is held to its baseline count, so the lines above include the file's tolerated",
    "findings too. If a finding is a false positive, or a rewrite moved an existing offender",
    `between files, regenerate that guard's entries with \`${REGENERATE_COMMAND} --guard <id>\``,
    "and justify it in review.",
  );
  return lines.join("\n");
}

export function formatStale(stale: readonly StaleEntry[]): string {
  if (stale.length === 0) return "";
  return [
    "The source-guard baseline allows more than the code has. It only ever goes down: regenerate",
    `that guard's entries with \`${REGENERATE_COMMAND} --guard <id>\` and commit the smaller baseline.`,
    ...stale.map(
      (entry) => `  [${entry.guard}] ${entry.file}: baseline ${entry.allowed}, now ${entry.actual}`,
    ),
  ].join("\n");
}
