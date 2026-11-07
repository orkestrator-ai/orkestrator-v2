#!/usr/bin/env bun
/**
 * The contract checks behind `mise run contract:check`, and the shrink-only
 * ratchet on untyped commands (plan item 1011,
 * docs/architecture/version-compatibility.md#domain-contracts).
 *
 *   bun scripts/contract-check.ts                   # manifest drift + ratchet
 *   bun scripts/contract-check.ts --lower-baseline  # write a smaller baseline
 *
 * `packages/protocol/contracts/untyped-baseline.json` holds, per contract
 * domain, how many commands are still string-registered (`untyped`). The
 * check reads the counts from the committed manifest
 * (`packages/protocol/contracts/manifest.json`, `untypedByDomain`) and fails
 * when any domain has more than the baseline allows (a domain absent from the
 * baseline allows none), so every new command uses `defineCommand`. It also
 * fails when the baseline allows more than the manifest has, so the baseline
 * goes down with each conversion and a later PR cannot spend the headroom.
 *
 * `--lower-baseline` (run by `mise run contract:manifest` after it writes the
 * manifest) rewrites the baseline from the manifest only when no domain rose;
 * otherwise it writes nothing and fails with the same message. The baseline is
 * never raised by a command; moving an untyped command between domains in
 * `contract-domain-map.ts` is the one reason to edit it by hand, and review
 * checks that the total did not change.
 *
 * The same model as `tests/source-guards/baseline.ts` (`compareWithBaseline`).
 * The manifest is read as JSON, not through the generator, so this file does
 * not depend on the registry or on `effect`; the manifest drift check is the
 * generator's `--check` (`scripts/generate-contract-manifest.ts`), which the
 * default mode runs first.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

/** Where a reader finds the rules, named in every failure. */
export const CONTRACT_DOCS = "docs/architecture/version-compatibility.md#domain-contracts";
/** The committed manifest, relative to the repository root (plan item 1006). */
export const MANIFEST_PATH = "packages/protocol/contracts/manifest.json";
/** The committed ratchet, relative to the repository root. */
export const UNTYPED_BASELINE_PATH = "packages/protocol/contracts/untyped-baseline.json";
/** The manifest format this reader knows (`CONTRACT_MANIFEST_SCHEMA_VERSION`). */
const MANIFEST_SCHEMA_VERSION = 1;
const BASELINE_SCHEMA_VERSION = 1;
const LOWER_COMMAND = "mise run contract:manifest";

/** Untyped commands per domain. */
export type UntypedCounts = { readonly [domain: string]: number };

export interface UntypedBaseline {
  readonly total: number;
  readonly untypedByDomain: UntypedCounts;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function countsFrom(value: unknown, label: string): UntypedCounts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: untypedByDomain must be an object.`);
  }
  const counts: Record<string, number> = {};
  for (const [domain, count] of Object.entries(value)) {
    if (!isCount(count)) throw new Error(`${label}: the count for ${domain} is not a count.`);
    counts[domain] = count;
  }
  return counts;
}

function sum(counts: UntypedCounts): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

/**
 * The untyped counts in a manifest's text. Refuses an unknown
 * `schemaVersion`, and a `counts.untyped` that disagrees with the per-domain
 * counts (the generator's `--check` keeps them in step).
 */
export function untypedCountsFromManifest(text: string): UntypedCounts {
  const parsed = JSON.parse(text) as {
    schemaVersion?: unknown;
    counts?: { untyped?: unknown };
    untypedByDomain?: unknown;
  };
  if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `${MANIFEST_PATH}: unknown schemaVersion ${String(parsed.schemaVersion)}; update ${UNTYPED_BASELINE_PATH}'s reader.`,
    );
  }
  const counts = countsFrom(parsed.untypedByDomain, MANIFEST_PATH);
  if (parsed.counts?.untyped !== sum(counts)) {
    throw new Error(`${MANIFEST_PATH}: counts.untyped does not match untypedByDomain.`);
  }
  return counts;
}

/** Parses the committed baseline. Refuses a `total` that is not the sum. */
export function parseUntypedBaseline(text: string): UntypedBaseline {
  const parsed = JSON.parse(text) as {
    schemaVersion?: unknown;
    total?: unknown;
    untypedByDomain?: unknown;
  };
  if (parsed.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `${UNTYPED_BASELINE_PATH}: unknown schemaVersion ${String(parsed.schemaVersion)}.`,
    );
  }
  const untypedByDomain = countsFrom(parsed.untypedByDomain, UNTYPED_BASELINE_PATH);
  if (parsed.total !== sum(untypedByDomain)) {
    throw new Error(`${UNTYPED_BASELINE_PATH}: total is not the sum of untypedByDomain.`);
  }
  return { total: sum(untypedByDomain), untypedByDomain };
}

/** Stable text: domains sorted, domains with no untyped command left out, trailing newline. */
export function serializeUntypedBaseline(counts: UntypedCounts): string {
  const sorted: Record<string, number> = {};
  for (const domain of Object.keys(counts).sort()) {
    if (counts[domain]! > 0) sorted[domain] = counts[domain]!;
  }
  const baseline = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    description: `Untyped (string-registered) backend commands per contract domain. Shrink-only: see ${CONTRACT_DOCS}.`,
    total: sum(sorted),
    untypedByDomain: sorted,
  };
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export interface CountChange {
  readonly domain: string;
  readonly allowed: number;
  readonly actual: number;
}

export interface UntypedRatchetResult {
  /** Domains with more untyped commands than the baseline allows. */
  readonly rises: readonly CountChange[];
  /** Domains the baseline allows more for than they now have. */
  readonly stale: readonly CountChange[];
}

export function compareUntypedCounts(
  actual: UntypedCounts,
  baseline: UntypedBaseline,
): UntypedRatchetResult {
  const allowedByDomain = baseline.untypedByDomain;
  const rises: CountChange[] = [];
  const stale: CountChange[] = [];
  for (const domain of Object.keys(actual).sort()) {
    const allowed = allowedByDomain[domain] ?? 0;
    if (actual[domain]! > allowed) rises.push({ domain, allowed, actual: actual[domain]! });
  }
  for (const domain of Object.keys(allowedByDomain).sort()) {
    const count = actual[domain] ?? 0;
    if (count < allowedByDomain[domain]!) {
      stale.push({ domain, allowed: allowedByDomain[domain]!, actual: count });
    }
  }
  return { rises, stale };
}

export function formatRises(rises: readonly CountChange[]): string {
  if (rises.length === 0) return "";
  return [
    "More untyped (string-registered) backend commands than packages/protocol/contracts/untyped-baseline.json allows:",
    ...rises.map(
      ({ domain, allowed, actual }) => `  ${domain}: baseline ${allowed}, now ${actual}`,
    ),
    "New commands use defineCommand and register(def, handler); the untyped count only falls.",
    `How to add a command: ${CONTRACT_DOCS}`,
  ].join("\n");
}

export function formatStale(stale: readonly CountChange[]): string {
  if (stale.length === 0) return "";
  return [
    "packages/protocol/contracts/untyped-baseline.json allows more untyped commands than the manifest has.",
    `It only goes down: run \`${LOWER_COMMAND}\` and commit the smaller baseline.`,
    ...stale.map(
      ({ domain, allowed, actual }) => `  ${domain}: baseline ${allowed}, now ${actual}`,
    ),
  ].join("\n");
}

export interface RatchetFiles {
  /** Absolute path of the manifest. */
  readonly manifestPath?: string;
  /** Absolute path of the baseline. */
  readonly baselinePath?: string;
  readonly log?: (line: string) => void;
}

async function readCounts(
  files: RatchetFiles,
): Promise<{ actual: UntypedCounts; baseline: UntypedBaseline | null }> {
  const manifestPath = files.manifestPath ?? join(repoRoot, MANIFEST_PATH);
  const baselinePath = files.baselinePath ?? join(repoRoot, UNTYPED_BASELINE_PATH);
  const actual = untypedCountsFromManifest(await readFile(manifestPath, "utf8"));
  const baseline = existsSync(baselinePath)
    ? parseUntypedBaseline(await readFile(baselinePath, "utf8"))
    : null;
  return { actual, baseline };
}

/** Compares the manifest with the baseline. Returns the exit status. */
export async function checkUntypedRatchet(files: RatchetFiles = {}): Promise<number> {
  const log = files.log ?? ((line: string) => console.log(line));
  let counts: Awaited<ReturnType<typeof readCounts>>;
  try {
    counts = await readCounts(files);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (counts.baseline === null) {
    log(`${UNTYPED_BASELINE_PATH} is missing: run \`${LOWER_COMMAND}\`.`);
    return 1;
  }
  const { rises, stale } = compareUntypedCounts(counts.actual, counts.baseline);
  for (const text of [formatRises(rises), formatStale(stale)]) if (text) log(text);
  if (rises.length > 0 || stale.length > 0) return 1;
  log(`${UNTYPED_BASELINE_PATH} matches: ${sum(counts.actual)} untyped commands.`);
  return 0;
}

/**
 * Rewrites the baseline from the manifest when no domain rose. A missing
 * baseline is written from the manifest (the first run). Returns the exit
 * status.
 */
export async function lowerUntypedBaseline(files: RatchetFiles = {}): Promise<number> {
  const log = files.log ?? ((line: string) => console.log(line));
  const baselinePath = files.baselinePath ?? join(repoRoot, UNTYPED_BASELINE_PATH);
  let counts: Awaited<ReturnType<typeof readCounts>>;
  try {
    counts = await readCounts(files);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (counts.baseline !== null) {
    const { rises } = compareUntypedCounts(counts.actual, counts.baseline);
    if (rises.length > 0) {
      log(formatRises(rises));
      log(`${UNTYPED_BASELINE_PATH} was not changed.`);
      return 1;
    }
  }
  const text = serializeUntypedBaseline(counts.actual);
  const before = existsSync(baselinePath) ? await readFile(baselinePath, "utf8") : null;
  if (before === text) {
    log(`${UNTYPED_BASELINE_PATH} is current: ${sum(counts.actual)} untyped commands.`);
    return 0;
  }
  await writeFile(baselinePath, text);
  log(
    `Wrote ${UNTYPED_BASELINE_PATH}: ${sum(counts.actual)} untyped commands (was ${counts.baseline?.total ?? "absent"}).`,
  );
  return 0;
}

export interface ContractCheckOptions extends RatchetFiles {
  /** The manifest drift check; defaults to the generator's `--check`. Returns its exit status. */
  readonly checkManifest?: (log: (line: string) => void) => Promise<number>;
}

/**
 * `mise run contract:check`: the generator's manifest drift check, then the
 * ratchet on the committed manifest. Both always run; any failure ends with a
 * pointer to the rules.
 */
export async function runContractCheck(options: ContractCheckOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const checkManifest = options.checkManifest ?? generatorCheck;
  const manifestStatus = await checkManifest(log);
  const ratchetStatus = await checkUntypedRatchet({ ...options, log });
  if (manifestStatus === 0 && ratchetStatus === 0) return 0;
  log(`Contract rules (domains, defineCommand, the manifest and this check): ${CONTRACT_DOCS}`);
  return 1;
}

async function generatorCheck(log: (line: string) => void): Promise<number> {
  // Loaded only here: the generator loads the backend registry in a child.
  const { runContractManifest } = await import("./generate-contract-manifest.ts");
  return await runContractManifest({ check: true, log });
}

export function parseArguments(args: readonly string[]): { readonly lowerBaseline: boolean } {
  if (args.length === 0) return { lowerBaseline: false };
  if (args.length === 1 && args[0] === "--lower-baseline") return { lowerBaseline: true };
  throw new Error("usage: bun scripts/contract-check.ts [--lower-baseline]");
}

if (import.meta.main) {
  const { lowerBaseline } = parseArguments(process.argv.slice(2));
  process.exit(lowerBaseline ? await lowerUntypedBaseline() : await runContractCheck());
}
