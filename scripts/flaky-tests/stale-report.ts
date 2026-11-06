/**
 * Lists open flake cases nobody has observed for a while, with the evidence a
 * person needs to close them quickly. Read-only: it never edits the registry.
 *
 *   bun scripts/flaky-tests/stale-report.ts [--days N] [--group G]
 *
 * A case is stale when its group index says `open` and the newest
 * `YYYY-MM-DD` in its case file is more than N days old (default 21). For each
 * one the report shows the owning test files from the index row's File column,
 * whether they still exist, the commits on HEAD dated after that day that
 * changed them (a deletion included), and any commit the case file cites that
 * HEAD already contains.
 *
 * Cases most likely to close come first: an owning file that no longer exists,
 * then an owning file changed since the last observation, then a cited commit
 * already in HEAD, then the rest; oldest first within each.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  type Commit,
  caseStatus,
  citedHashes,
  commitsSince,
  DEFAULT_REPO,
  daysBetween,
  type IndexRow,
  newestDate,
  owningFiles,
  REGISTRY_RELATIVE,
  reachableCommits,
  readIndexRows,
  resolveCommits,
  todayUtc,
} from "./registry";

export const DEFAULT_DAYS = 21;
export const USAGE =
  "Usage: bun scripts/flaky-tests/stale-report.ts [--days N] [--group G] [--today YYYY-MM-DD] [--repo <dir>]";

export interface StaleOptions {
  days: number;
  group?: string;
  today: string;
  repo: string;
}

export function parseArguments(argv: readonly string[], now = new Date()): StaleOptions {
  const options: StaleOptions = { days: DEFAULT_DAYS, today: todayUtc(now), repo: DEFAULT_REPO };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${token} needs a value`);
      index += 1;
      return next;
    };
    if (token === "--") continue;
    if (token === "--days") {
      const days = value();
      if (!/^\d+$/.test(days)) throw new Error(`--days needs a whole number, got ${days}`);
      options.days = Number(days);
    } else if (token === "--group") options.group = value();
    else if (token === "--today") {
      const today = value();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`--today needs YYYY-MM-DD`);
      options.today = today;
    } else if (token === "--repo") options.repo = value();
    else throw new Error(`Unexpected argument ${token}`);
  }
  return options;
}

export interface OwningFile {
  path: string;
  exists: boolean;
  /** Short hashes of HEAD commits dated after the last observation day that touched it. */
  changedBy: string[];
}

export type Signal = "file-gone" | "file-changed" | "cited-in-head" | "none";

export interface StaleCase {
  row: IndexRow;
  relativePath: string;
  lastObserved: string | undefined;
  ageDays: number | undefined;
  files: OwningFile[];
  citedInHead: string[];
  /** Status line of the case file when it disagrees with the index row. */
  statusMismatch?: string;
  signal: Signal;
}

export interface StaleReport {
  options: StaleOptions;
  openCases: number;
  cases: StaleCase[];
}

const SIGNAL_ORDER: Signal[] = ["file-gone", "file-changed", "cited-in-head", "none"];

function signalOf(entry: Omit<StaleCase, "signal">): Signal {
  if (entry.files.some((file) => !file.exists)) return "file-gone";
  if (entry.files.some((file) => file.changedBy.length > 0)) return "file-changed";
  if (entry.citedInHead.length > 0) return "cited-in-head";
  return "none";
}

function changesTo(file: string, since: string, commits: readonly Commit[]): string[] {
  return (
    commits
      // Strictly after the observation day: a same-day commit may be the one observed.
      .filter((commit) => commit.date > since && commit.files.includes(file))
      .map((commit) => commit.hash.slice(0, 10))
  );
}

export async function staleReport(options: StaleOptions): Promise<StaleReport> {
  const registryRoot = path.join(options.repo, REGISTRY_RELATIVE);
  const openRows = readIndexRows(registryRoot, options.group).filter(
    (row) => row.status === "open",
  );

  const candidates = openRows.map((row) => {
    const relativePath = `${REGISTRY_RELATIVE}/${row.group}/${row.caseFile}`;
    const absolute = path.join(options.repo, relativePath);
    const text = existsSync(absolute) ? Bun.file(absolute).text() : Promise.resolve("");
    return { row, relativePath, text };
  });
  const texts = await Promise.all(candidates.map((candidate) => candidate.text));
  const stale = candidates
    .map((candidate, index) => {
      const text = texts[index]!;
      const lastObserved = newestDate(text, options.today);
      const ageDays = lastObserved ? daysBetween(lastObserved, options.today) : undefined;
      return { ...candidate, text, lastObserved, ageDays };
    })
    // A case file with no date at all is reported too: nothing says it is fresh.
    .filter((entry) => entry.ageDays === undefined || entry.ageDays > options.days);

  const oldest = stale
    .map((entry) => entry.lastObserved)
    .filter((date): date is string => date !== undefined)
    .sort()[0];
  const commits = oldest ? await commitsSince(options.repo, "HEAD", oldest) : [];
  const allHashes = Array.from(new Set(stale.flatMap((entry) => citedHashes(entry.text))));
  const resolved = await resolveCommits(options.repo, allHashes);
  const head = resolved.size > 0 ? await reachableCommits(options.repo, "HEAD") : new Set();

  const cases: StaleCase[] = stale.map((entry) => {
    const files = owningFiles(entry.row.fileColumn).map((file) => ({
      path: file,
      exists: existsSync(path.join(options.repo, file)),
      changedBy: entry.lastObserved ? changesTo(file, entry.lastObserved, commits) : [],
    }));
    const citedInHead = citedHashes(entry.text).filter((hash) => {
      const commit = resolved.get(hash);
      return commit !== undefined && head.has(commit);
    });
    const fileStatus = caseStatus(entry.text);
    const base: Omit<StaleCase, "signal"> = {
      row: entry.row,
      relativePath: entry.relativePath,
      lastObserved: entry.lastObserved,
      ageDays: entry.ageDays,
      files,
      citedInHead,
      ...(fileStatus !== entry.row.status ? { statusMismatch: fileStatus ?? "(missing)" } : {}),
    };
    return { ...base, signal: signalOf(base) };
  });

  cases.sort(
    (a, b) =>
      SIGNAL_ORDER.indexOf(a.signal) - SIGNAL_ORDER.indexOf(b.signal) ||
      (a.lastObserved ?? "").localeCompare(b.lastObserved ?? "") ||
      a.row.id.localeCompare(b.row.id) ||
      a.row.group.localeCompare(b.row.group),
  );
  return { options, openCases: openRows.length, cases };
}

const SIGNAL_HEADINGS: Record<Signal, string> = {
  "file-gone": "Owning test file no longer exists",
  "file-changed": "Owning test file changed since the last observation",
  "cited-in-head": "A cited commit is already in HEAD",
  none: "No signal",
};

function plainTest(test: string): string {
  const text = test.replace(/\s*\(`[^`]*`\)\s*$/, "").replace(/`/g, "");
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

export function summaryCounts(report: StaleReport) {
  const count = (predicate: (entry: StaleCase) => boolean) => report.cases.filter(predicate).length;
  return {
    open: report.openCases,
    stale: report.cases.length,
    fileGone: count((entry) => entry.files.some((file) => !file.exists)),
    fileChanged: count((entry) => entry.files.some((file) => file.changedBy.length > 0)),
    citedInHead: count((entry) => entry.citedInHead.length > 0),
    noFileNamed: count((entry) => entry.files.length === 0),
  };
}

export function formatReport(report: StaleReport): string {
  const counts = summaryCounts(report);
  const scope = report.options.group ? ` in ${report.options.group}` : "";
  const lines = [
    `Stale flake cases${scope}: ${counts.stale} of ${counts.open} open cases were last observed more than ${report.options.days} days before ${report.options.today}.`,
    `  owning file gone: ${counts.fileGone}; owning file changed since: ${counts.fileChanged}; cited commit in HEAD: ${counts.citedInHead}; no owning file named: ${counts.noFileNamed}`,
  ];
  let heading: Signal | undefined;
  for (const entry of report.cases) {
    if (entry.signal !== heading) {
      heading = entry.signal;
      lines.push("", `## ${SIGNAL_HEADINGS[heading]}`);
    }
    const age =
      entry.lastObserved === undefined
        ? "no date in case file"
        : `last observed ${entry.lastObserved} (${entry.ageDays} days)`;
    lines.push("", `${entry.row.id} ${entry.row.group}: ${age}`);
    lines.push(`  test: ${plainTest(entry.row.test)}`);
    lines.push(`  case: ${entry.relativePath}`);
    if (entry.statusMismatch) {
      lines.push(`  note: the case file says ${entry.statusMismatch}, the index says open`);
    }
    if (entry.files.length === 0) lines.push(`  file: none named (${entry.row.fileColumn})`);
    for (const file of entry.files) {
      const state = !file.exists
        ? "missing"
        : file.changedBy.length > 0
          ? `changed since by ${file.changedBy.length} commit(s): ${file.changedBy.slice(0, 5).join(", ")}${file.changedBy.length > 5 ? ", ..." : ""}`
          : "unchanged since";
      lines.push(`  file: ${file.path} (${state})`);
    }
    if (entry.citedInHead.length > 0) {
      lines.push(`  cited commits in HEAD: ${entry.citedInHead.join(", ")}`);
    }
  }
  return lines.join("\n");
}

if (import.meta.main) {
  let options: StaleOptions;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  try {
    console.log(formatReport(await staleReport(options)));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
