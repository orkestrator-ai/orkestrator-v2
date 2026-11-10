/**
 * Regenerates tests/source-guards/baseline.json from the current tree:
 *
 *   bun tests/source-guards/update-baseline.ts
 *   bun tests/source-guards/update-baseline.ts --guard window-orkestrator-direct
 *   bun tests/source-guards/update-baseline.ts --guard lib-backend-command-default
 *
 * With `--guard <id>` (repeatable) only those guards' entries are rescanned;
 * every other guard's entries are kept exactly as committed, so adding or
 * shrinking one guard cannot also absorb another guard's new findings. A guard
 * that counts per subject (`lib-backend-command-default`, per `lib/backend`
 * file) also prints each subject's total.
 *
 * It scans what `mise run guards` scans: the files `git ls-files -co
 * --exclude-standard` lists. The output is deterministic (guards in declaration order, files sorted), so
 * running it twice on the same tree writes the same bytes. A baseline entry
 * should only ever go down; review any increase as a new offender.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BASELINE_PATH,
  baselineFromFindings,
  parseBaseline,
  serializeBaseline,
  type Baseline,
} from "./baseline";
import { GUARD_IDS, type GuardId } from "./guard";
import { RepositoryIndex } from "./repository-index";
import { SOURCE_GUARDS, scanRepository } from "./scan";

/** The guards named by `--guard <id>` arguments, or `null` for all of them. */
export function selectedGuards(argv: readonly string[]): GuardId[] | null {
  const selected: GuardId[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--guard") throw new Error(`Unknown argument: ${argv[index]}`);
    const id = argv[index + 1];
    if (!(GUARD_IDS as readonly string[]).includes(id ?? ""))
      throw new Error(`--guard takes one of: ${GUARD_IDS.join(", ")}`);
    selected.push(id as GuardId);
    index += 1;
  }
  return selected.length > 0 ? selected : null;
}

/** Totals per subject for a guard whose entries are keyed `[subject] file`. */
export function subjectTotals(entries: Readonly<Record<string, number>>): Array<[string, number]> {
  const totals = new Map<string, number>();
  for (const [key, count] of Object.entries(entries)) {
    const subject = /^\[([^\]]+)\] /.exec(key)?.[1];
    if (subject) totals.set(subject, (totals.get(subject) ?? 0) + count);
  }
  return [...totals].sort(([left], [right]) => left.localeCompare(right));
}

/** `committed` with the `selected` guards' entries replaced by `scanned`'s. */
export function mergeBaseline(
  committed: Baseline,
  scanned: Baseline,
  selected: readonly GuardId[],
): Baseline {
  const merged = {} as Baseline;
  for (const guard of GUARD_IDS)
    merged[guard] = { ...(selected.includes(guard) ? scanned[guard] : committed[guard]) };
  return merged;
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "../..");
  const selected = selectedGuards(process.argv.slice(2));
  const guards = selected
    ? SOURCE_GUARDS.filter((guard) => selected.includes(guard.id))
    : SOURCE_GUARDS;
  const started = performance.now();
  const scanned = baselineFromFindings(scanRepository(RepositoryIndex.fromGit(root), guards));
  const elapsed = performance.now() - started;
  const baseline = selected
    ? mergeBaseline(
        parseBaseline(existsSync(BASELINE_PATH) ? readFileSync(BASELINE_PATH, "utf8") : "{}"),
        scanned,
        selected,
      )
    : scanned;
  writeFileSync(BASELINE_PATH, serializeBaseline(baseline));
  for (const guard of selected ?? GUARD_IDS) {
    const counts = Object.values(baseline[guard]);
    const total = counts.reduce((sum, count) => sum + count, 0);
    console.log(`${guard}: ${counts.length} file(s), ${total} finding(s)`);
    for (const [subject, count] of subjectTotals(baseline[guard]))
      console.log(`  [${subject}] ${count} finding(s)`);
  }
  console.log(`Wrote ${path.relative(root, BASELINE_PATH)} (scan ${Math.round(elapsed)} ms).`);
}
