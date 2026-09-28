import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ioAvailable } from "./counters.js";
import {
  EFFICIENCY_SCHEMA_VERSION,
  compareReports,
  createContext,
  machineInfo,
  runCase,
  sourceInfo,
  summarizeReports,
  type EfficiencyReport,
  type WorkloadContext,
  type WorkloadDefinition,
} from "./harness.js";
import { TRANSCRIPT_ENVIRONMENT } from "./workloads-transcripts.js";

/**
 * Efficiency baseline CLI.
 *
 *   mise run efficiency:baseline -- [--root <repo>] [--label <name>] [--run-id <id>]
 *     [--repetitions <n>] [--workloads a,b,...] [--out <file.json>]
 *     [--compare <baseline.json>] [--summary-out <file.json>] [--fail-on-change]
 *
 * Imports repository modules from `--root` (default: this checkout), so the
 * same harness measures a baseline worktree and the current tree. Writes the
 * full report to `output/efficiency/<run-id>/<label>.json` unless `--out` is
 * given. `--compare` prints every deterministic counter that differs from a
 * stored report; `--summary-out` also writes the compact before/after summary
 * committed under docs/improvements/efficiency/baseline/.
 */

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

// Backend modules under test may change the working directory; resolve every
// path argument against the directory the harness was invoked from.
const invocationDirectory = process.cwd();
function pathArgument(name: string): string | undefined {
  const value = argument(name);
  return value === undefined ? undefined : path.resolve(invocationDirectory, value);
}

const repositoryRoot = path.resolve(import.meta.dir, "..", "..");

// Bridge config modules read these at import; set them before any import.
for (const [name, value] of Object.entries(TRANSCRIPT_ENVIRONMENT)) process.env[name] = value;

type WorkloadFactory = (context: WorkloadContext) => Promise<WorkloadDefinition>;

async function workloadFactories(): Promise<Record<string, WorkloadFactory>> {
  const transcripts = await import("./workloads-transcripts.js");
  const storage = await import("./workloads-storage.js");
  const projection = await import("./workloads-projection.js");
  const frontend = await import("./workloads-frontend.js");
  return {
    a: transcripts.unchangedReadWorkload,
    b: transcripts.trimmingWorkload,
    c: transcripts.cursorStreamWorkload,
    d: storage.displayTailWorkload,
    e: transcripts.bridgeWindowWorkload,
    f: projection.projectionChangedReadWorkload,
    g: frontend.frontendAccountingWorkload,
    h: storage.codexRolloutWorkload,
    i: projection.historyPagingWorkload,
    j: projection.step14Workload,
  };
}

async function main(): Promise<number> {
  const root = pathArgument("--root") ?? repositoryRoot;
  const label = argument("--label") ?? (root === repositoryRoot ? "head" : "baseline");
  const runId =
    argument("--run-id") ?? new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  const repetitions = Number(argument("--repetitions") ?? 7);
  if (!Number.isSafeInteger(repetitions) || repetitions < 1)
    throw new Error("--repetitions must be a positive integer");
  const factories = await workloadFactories();
  const selected = (argument("--workloads") ?? Object.keys(factories).join(","))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const context = createContext(root);
  const startedAt = new Date().toISOString();
  const report: EfficiencyReport = {
    schemaVersion: EFFICIENCY_SCHEMA_VERSION,
    generatedBy: "scripts/efficiency/run.ts",
    runId,
    label,
    source: sourceInfo(root),
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    machine: machineInfo(),
    method: {
      primary:
        "deterministic operation counts (serialization visits, bytes, payload reads, provider calls)",
      secondary:
        "wall-clock ms via performance.now(); machine-specific, never compared; repetition 0 is cold, p50/p95 over warm repetitions",
      repetitions,
      ioCounters: ioAvailable()
        ? "/proc/self/io rchar/wchar deltas"
        : "unavailable on this platform",
      heap: "not measured: counts and retained-size estimates only",
    },
    startedAt,
    finishedAt: startedAt,
    workloads: [],
  };
  for (const id of selected) {
    const factory = factories[id];
    if (!factory)
      throw new Error(
        `Unknown workload ${id}; expected one of ${Object.keys(factories).join(",")}`,
      );
    const workload = await factory(context);
    console.error(`[efficiency] ${label}: ${workload.id}`);
    const cases = [];
    for (const definition of workload.cases) cases.push(await runCase(definition, repetitions));
    report.workloads.push({
      id: workload.id,
      title: workload.title,
      findings: workload.findings,
      fixture: workload.fixture,
      method: workload.method,
      cases,
    });
  }
  report.finishedAt = new Date().toISOString();

  const out =
    pathArgument("--out") ??
    path.join(repositoryRoot, "output", "efficiency", runId, `${label}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`[efficiency] wrote ${report.workloads.length} workloads to ${out}`);

  const comparePath = pathArgument("--compare");
  if (!comparePath) return 0;
  const baseline = JSON.parse(await readFile(comparePath, "utf8")) as EfficiencyReport;
  const summaryOut = pathArgument("--summary-out");
  if (summaryOut) {
    await mkdir(path.dirname(summaryOut), { recursive: true });
    await writeFile(summaryOut, `${JSON.stringify(summarizeReports(baseline, report), null, 2)}\n`);
    console.error(`[efficiency] wrote summary to ${summaryOut}`);
  }
  const differences = compareReports(baseline, report);
  console.log(`[efficiency] ${differences.length} counter(s) differ from ${comparePath}:`);
  for (const entry of differences) {
    console.log(
      `  ${entry.workload} ${entry.caseId} ${entry.counter}: ${entry.baseline} -> ${entry.candidate}`,
    );
  }
  return process.argv.includes("--fail-on-change") && differences.length > 0 ? 1 : 0;
}

process.exitCode = await main();
