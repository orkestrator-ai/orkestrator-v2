/**
 * Says whether a failure of a registered flake on a given base is a real
 * recurrence. Read-only: it never edits the registry.
 *
 *   bun scripts/flaky-tests/recurrence-check.ts <case-id> [--base <commit>] [--registry-ref <ref>]
 *
 * `--base` is the commit the failing run was built on (default `HEAD`); for a
 * branch use `git merge-base HEAD origin/main`. `--registry-ref` reads the
 * case files as committed at that ref (for example `origin/main`) instead of
 * the working tree, which is how a branch whose own copy of the registry
 * predates a resolution still learns about it.
 *
 * A resolved case's fix commits are the commit that set its status to
 * `resolved` on the registry ref, plus the commits its Resolution sections
 * cite that are reachable from that ref. A cited commit that is not reachable
 * (a branch commit later squash-merged) cannot say anything about the base and
 * is listed but not used.
 */
import process from "node:process";
import {
  type CaseRecord,
  type CaseSource,
  citedHashes,
  DEFAULT_REPO,
  findCases,
  gitTreeSource,
  isAncestor,
  resolutionText,
  resolveCommit,
  statusFlipCommit,
  workingTreeSource,
} from "./registry";

export const USAGE =
  "Usage: bun scripts/flaky-tests/recurrence-check.ts <case-id> [--base <commit>] [--registry-ref <ref>] [--repo <dir>]";

export interface RecurrenceOptions {
  query: string;
  base: string;
  registryRef?: string;
  repo: string;
}

export function parseArguments(argv: readonly string[]): RecurrenceOptions {
  const options: Partial<RecurrenceOptions> = { base: "HEAD", repo: DEFAULT_REPO };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${token} needs a value`);
      index += 1;
      return next;
    };
    if (token === "--") continue;
    else if (token === "--base") options.base = value();
    else if (token === "--registry-ref") options.registryRef = value();
    else if (token === "--repo") options.repo = value();
    else if (token.startsWith("-")) throw new Error(`Unknown option ${token}`);
    else if (options.query === undefined) options.query = token;
    else throw new Error(`Unexpected argument ${token}`);
  }
  if (options.query === undefined) throw new Error("No case id given");
  return options as RecurrenceOptions;
}

export type Verdict =
  | { kind: "real-recurrence"; fixes: string[] }
  | { kind: "base-predates-fix"; missing: string[] }
  | { kind: "resolved-fix-unknown" }
  | { kind: "open" }
  | { kind: "environmental" }
  | { kind: "unknown-status"; status: string | undefined };

export interface CitedCommit {
  cited: string;
  commit: string;
  inBase: boolean;
  /** Reachable from the registry ref; unreachable commits do not decide the verdict. */
  onRegistryRef: boolean;
  inResolution: boolean;
}

export interface CaseReport {
  record: CaseRecord;
  cited: CitedCommit[];
  unresolved: string[];
  statusFlip?: { commit: string; inBase: boolean };
  verdict: Verdict;
}

export interface RecurrenceReport {
  base: string;
  baseCommit: string;
  registry: string;
  registryCommit: string;
  cases: CaseReport[];
}

async function assessCase(
  repo: string,
  record: CaseRecord,
  baseCommit: string,
  registryCommit: string,
): Promise<CaseReport> {
  const resolutionHashes = new Set(citedHashes(resolutionText(record.text)));
  const cited: CitedCommit[] = [];
  const unresolved: string[] = [];
  for (const hash of citedHashes(record.text)) {
    const commit = await resolveCommit(repo, hash);
    if (!commit) {
      unresolved.push(hash);
      continue;
    }
    if (cited.some((entry) => entry.commit === commit)) continue;
    cited.push({
      cited: hash,
      commit,
      inBase: await isAncestor(repo, commit, baseCommit),
      onRegistryRef: await isAncestor(repo, commit, registryCommit),
      inResolution: resolutionHashes.has(hash),
    });
  }

  const report: CaseReport = { record, cited, unresolved, verdict: { kind: "open" } };
  switch (record.status) {
    case "open":
      return report;
    case "environmental":
      report.verdict = { kind: "environmental" };
      return report;
    case "resolved":
      break;
    default:
      report.verdict = { kind: "unknown-status", status: record.status };
      return report;
  }

  const flip = await statusFlipCommit(repo, registryCommit, record.relativePath);
  if (flip) report.statusFlip = { commit: flip, inBase: await isAncestor(repo, flip, baseCommit) };
  const fixes = new Map<string, boolean>();
  if (report.statusFlip) fixes.set(report.statusFlip.commit, report.statusFlip.inBase);
  for (const entry of cited) {
    if (entry.inResolution && entry.onRegistryRef) fixes.set(entry.commit, entry.inBase);
  }
  if (fixes.size === 0) {
    report.verdict = { kind: "resolved-fix-unknown" };
  } else {
    const missing = [...fixes].filter(([, inBase]) => !inBase).map(([commit]) => commit);
    report.verdict =
      missing.length > 0
        ? { kind: "base-predates-fix", missing }
        : { kind: "real-recurrence", fixes: [...fixes.keys()] };
  }
  return report;
}

export async function checkRecurrence(options: RecurrenceOptions): Promise<RecurrenceReport> {
  const baseCommit = await resolveCommit(options.repo, options.base);
  if (!baseCommit) throw new Error(`--base ${options.base} is not a commit in ${options.repo}`);
  const registryRevision = options.registryRef ?? "HEAD";
  const registryCommit = await resolveCommit(options.repo, registryRevision);
  if (!registryCommit) throw new Error(`${registryRevision} is not a commit in ${options.repo}`);
  const source: CaseSource = options.registryRef
    ? await gitTreeSource(options.repo, options.registryRef)
    : workingTreeSource(options.repo);
  const records = await findCases(source, options.query);
  if (records.length === 0) throw new Error(`No case file matches ${options.query}`);
  const cases: CaseReport[] = [];
  for (const record of records) {
    cases.push(await assessCase(options.repo, record, baseCommit, registryCommit));
  }
  return {
    base: options.base,
    baseCommit,
    registry: options.registryRef ?? "working tree",
    registryCommit,
    cases,
  };
}

const short = (commit: string) => commit.slice(0, 10);

export function verdictLine(verdict: Verdict): string {
  switch (verdict.kind) {
    case "real-recurrence":
      return (
        `resolved, and the base contains its fix (${verdict.fixes.map(short).join(", ")}). ` +
        "This is a real recurrence: reopen the case (status open in the case file and its " +
        "group index) and record the failure."
      );
    case "base-predates-fix":
      return (
        `resolved, but the base predates fix ${verdict.missing.map(short).join(", ")}. ` +
        'Not a recurrence: rebase onto a base that contains the fix and rerun; if you note it, write "base predates fix".'
      );
    case "resolved-fix-unknown":
      return (
        "resolved, but no fix commit could be identified from the case file or its history. " +
        "Read its Resolution section and compare with the base before reopening."
      );
    case "open":
      return "open. Record the failure as a recurrence in the case file and its index row.";
    case "environmental":
      return "environmental. Record it only if the host matches the case's note.";
    case "unknown-status":
      return `the case file has no recognised status (${verdict.status ?? "none"}); fix the case file first.`;
  }
}

export function formatReport(report: RecurrenceReport): string {
  const lines: string[] = [
    `Base: ${report.base} (${short(report.baseCommit)})`,
    `Registry: ${report.registry} (${short(report.registryCommit)})`,
  ];
  if (report.cases.length > 1) {
    lines.push(
      `${report.cases.length} case files share this number; pass the file name to pick one.`,
    );
  }
  for (const entry of report.cases) {
    lines.push("", `Case ${entry.record.id}: ${entry.record.relativePath}`);
    lines.push(`  Status: ${entry.record.status ?? "(missing)"}`);
    if (entry.cited.length === 0) lines.push("  Cited commits: none that resolve here");
    else lines.push("  Cited commits:");
    for (const commit of entry.cited) {
      const notes = [commit.inBase ? "ancestor of base" : "not in base"];
      if (!commit.onRegistryRef) notes.push("not on the registry ref (branch or squashed commit)");
      if (commit.inResolution) notes.push("cited in Resolution");
      lines.push(`    ${commit.cited.padEnd(10)} ${notes.join("; ")}`);
    }
    if (entry.unresolved.length > 0) {
      lines.push(`  Not commits in this repository: ${entry.unresolved.length}`);
    }
    if (entry.statusFlip) {
      lines.push(
        `  Set to resolved by: ${short(entry.statusFlip.commit)} (${entry.statusFlip.inBase ? "ancestor of base" : "not in base"})`,
      );
    }
    lines.push(`  Verdict: ${verdictLine(entry.verdict)}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  let options: RecurrenceOptions;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  try {
    console.log(formatReport(await checkRecurrence(options)));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
