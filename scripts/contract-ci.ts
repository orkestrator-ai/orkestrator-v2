#!/usr/bin/env bun
/**
 * The contract CI job (plan item 1008, docs/reports/unified-federation.md
 * §11.3 steps 3 and 5): the current tree still serves every client in the
 * support window, and still has a client adapter for every backend in it.
 *
 *   bun scripts/contract-ci.ts                 # stage 1 (mise run contract:ci, every PR)
 *   bun scripts/contract-ci.ts --stage2        # stage 2 (on by default since plan item 7001)
 *   bun scripts/contract-ci.ts --now <iso>     # as on another day
 *   bun scripts/contract-ci.ts --retirements [--json]  # the retirement schedule, no checks
 *
 * The support floor is the newest Stable release published at least 60 days
 * before `now`, otherwise v2.21.0 (`docs/architecture/version-compatibility.md`,
 * "The support window"), from `packages/protocol/contracts/releases/index.json`.
 * Every snapshotted release at or above the floor is in the window, including
 * one whose `publishedAt` is still `null` (versioned, not yet published),
 * which is never the floor.
 *
 * Stage 1 (on):
 *
 * 1. The release index and the snapshot files agree, and every in-window
 *    snapshot verifies (`readReleaseSnapshot`).
 * 2. **Adapters:** for every (domain, version) an in-window release speaks
 *    (version 0 for a domain it does not advertise), the domain's client in
 *    `contracts/adapters.json` has that adapter. A domain with no client is
 *    still called by command name through the untyped invoke, which is the
 *    version 0 behaviour for every peer, so it is checked from the day it
 *    gets a client; a domain that no longer exists fails.
 * 3. **Removed commands:** a command of an in-window release that the
 *    current manifest no longer has must be named by a register or retired
 *    row, and its domain must be at a higher version now than in that release
 *    (unless the domain is unversioned on both sides, or the snapshot has no
 *    domain for it: there is nothing to bump).
 * 4. **Register:** every register row with a counter names ids in
 *    `COMPATIBILITY_PATH_IDS` (or domain adapter ids); every domain bump past
 *    an in-window release's version has a register row naming the old
 *    version's adapter counter (`domain-adapter.<side>.<domain>.v<version>`);
 *    a register row naming an adapter that `adapters.json` no longer has
 *    fails; no domain is below an in-window release's version.
 * 5. **Schema store:** every defined command's argument schema (current
 *    manifest and in-window releases) is stored (`scripts/contract-ci-schemas.ts`),
 *    so stage 2 has the older schemas when it is turned on.
 * 6. **Retirements** (plan item 7013, `scripts/contract-ci-retirements.ts`):
 *    an adapter whose version no in-window peer speaks any more (the floor
 *    has passed the first Stable release that advertises the domain at
 *    `v + 1`), or a capability command whose retirement condition the floor
 *    has passed, fails as unreachable; `contracts/retirements.json` lists
 *    every legacy capability command.
 *
 * Stage 2 ({@link CONTRACT_CI_STAGE_2}, on since plan item 7001):
 *
 * 7. **New required fields:** a defined command whose argument schema
 *    requires a field an in-window release's schema did not, while its domain
 *    is at the same version.
 * 8. **Argument fixtures:** fixtures generated from each in-window defined
 *    command's older schema (`effect/Arbitrary`) are decoded by the current
 *    registry's parser, in a sandboxed child.
 *
 * Every failure ends with the docs pointer `CONTRACT_DOCS`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hasDomainAdapter,
  parseAdapterList,
  ADAPTER_LIST_PATH,
  type AdapterList,
} from "@orkestrator/protocol/contract/client-adapters";
import { isDomainName } from "@orkestrator/protocol/contract/domain";
import { COMPATIBILITY_PATH_IDS } from "../apps/backend/src/core/compatibility-path-usage.ts";
import {
  checkRegisterCounters,
  parseRegisterDocument,
  REGISTER_DOCUMENT,
  rowAdapters,
  type RegisterDocument,
} from "./contract-ci-register.ts";
import {
  checkSchemaStore,
  newRequiredFields,
  readStoredSchema,
  runFixturesInChild,
  type FixtureCase,
  type FixtureReport,
} from "./contract-ci-schemas.ts";
import {
  checkRetirementList,
  checkRetirements,
  formatRetirementSchedule,
  parseRetirementList,
  retiredCommands,
  retirementSchedule,
  RETIREMENT_LIST_PATH,
  SUPPORT_WINDOW_DAYS,
  type RetirementList,
  type StableRelease,
} from "./contract-ci-retirements.ts";
import { CONTRACT_DOCS } from "./contract-check.ts";
import {
  compareVersions,
  CONTRACTS_DIRECTORY,
  FIRST_PUBLISHED_RELEASE,
  readReleaseIndex,
  readReleaseSnapshot,
  type ReleaseContract,
  type ReleaseIndex,
  type ReleaseIndexEntry,
} from "./contract-snapshots.ts";

const repoRoot = join(import.meta.dir, "..");

/**
 * Stage 2 (argument fixtures and new required fields). On since the first
 * domain other than the pilot converted (plan item 7001, `native-sessions`).
 */
export const CONTRACT_CI_STAGE_2 = true;

export { SUPPORT_WINDOW_DAYS };
const DAY_MS = 24 * 60 * 60 * 1000;

/** The parts of the committed manifest the job reads. */
export interface CiManifest {
  readonly domains: {
    readonly [domain: string]: { readonly version: number; readonly min: number };
  };
  readonly commands: {
    readonly [command: string]: {
      readonly domain: string;
      readonly untyped?: true;
      readonly argsDigest?: string;
    };
  };
}

export interface SupportFloor {
  readonly version: string;
  /** The Stable release that set it; `null` while none is old enough (v2.21.0). */
  readonly release: ReleaseIndexEntry | null;
}

/**
 * The newest Stable release published at least {@link SUPPORT_WINDOW_DAYS}
 * days before `now`, otherwise v2.21.0. A release with no publication time
 * is never the floor.
 */
export function supportFloor(index: ReleaseIndex, now: Date): SupportFloor {
  const cutoff = now.getTime() - SUPPORT_WINDOW_DAYS * DAY_MS;
  let floor: ReleaseIndexEntry | null = null;
  for (const entry of index.releases) {
    if (entry.channel !== "stable" || entry.publishedAt === null) continue;
    const published = Date.parse(entry.publishedAt);
    if (!Number.isFinite(published) || published > cutoff) continue;
    if (floor === null || compareVersions(entry.version, floor.version) > 0) floor = entry;
  }
  if (floor === null || compareVersions(floor.version, FIRST_PUBLISHED_RELEASE) < 0) {
    return { version: FIRST_PUBLISHED_RELEASE, release: null };
  }
  return { version: floor.version, release: floor };
}

/** Every indexed release at or above the floor, unpublished ones included. */
export function windowReleases(index: ReleaseIndex, floor: string): ReleaseIndexEntry[] {
  return index.releases.filter((entry) => compareVersions(entry.version, floor) >= 0);
}

/** The release index names exactly the snapshot files, and its times parse. */
export function checkReleaseIndex(
  index: ReleaseIndex,
  snapshotVersions: readonly string[],
): string[] {
  const problems: string[] = [];
  const indexed = new Set(index.releases.map((entry) => entry.version));
  const files = new Set(snapshotVersions);
  for (const version of [...indexed].sort(compareVersions)) {
    if (!files.has(version)) {
      problems.push(`releases/index.json lists ${version}, which has no releases/${version}.json.`);
    }
  }
  for (const version of [...files].sort(compareVersions)) {
    if (!indexed.has(version)) {
      problems.push(
        `releases/${version}.json is not in releases/index.json: run \`mise run contract:backfill\`.`,
      );
    }
  }
  for (const entry of index.releases) {
    if (entry.publishedAt !== null && !Number.isFinite(Date.parse(entry.publishedAt))) {
      problems.push(`releases/index.json: ${entry.version} has publishedAt ${entry.publishedAt}.`);
    }
  }
  return problems;
}

/** The version `release` speaks for `domain`: its advertised version, or 0. */
export function releaseDomainVersion(release: ReleaseContract, domain: string): number {
  return release.domains[domain]?.version ?? 0;
}

/** The domains a release has commands in, or advertises. */
export function releaseDomains(release: ReleaseContract): string[] {
  const domains = new Set(Object.keys(release.domains));
  for (const entry of Object.values(release.commands)) {
    if (entry.domain !== null) domains.add(entry.domain);
  }
  return [...domains].sort();
}

function currentDomainVersion(manifest: CiManifest, domain: string): number {
  return manifest.domains[domain]?.version ?? 0;
}

function releaseList(versions: readonly string[]): string {
  const sorted = [...versions].sort(compareVersions);
  if (sorted.length <= 2) return sorted.join(" and ");
  return `${sorted[0]} to ${sorted.at(-1)} (${sorted.length} releases)`;
}

/** Groups (key → releases) so a finding that holds for many releases is one line. */
function grouped<K>(): {
  add(key: K, release: string): void;
  entries(): Array<[K, string[]]>;
} {
  const map = new Map<string, { key: K; releases: string[] }>();
  return {
    add(key, release) {
      const id = JSON.stringify(key);
      const entry = map.get(id) ?? { key, releases: [] };
      entry.releases.push(release);
      map.set(id, entry);
    },
    entries: () => [...map.values()].map(({ key, releases }) => [key, releases]),
  };
}

/** Check 2: a client adapter for every (domain, version) in the window. */
export function checkAdapters(window: readonly ReleaseContract[], adapters: AdapterList): string[] {
  const missing = grouped<{ domain: string; version: number }>();
  for (const release of window) {
    for (const domain of releaseDomains(release)) {
      const version = releaseDomainVersion(release, domain);
      const client = isDomainName(domain) ? adapters.domains[domain] : undefined;
      if (client === undefined) {
        // No client: callers use the untyped invoke, which is version 0 for
        // every peer. Only a domain that no longer exists cannot be called.
        if (version > 0 && !isDomainName(domain)) missing.add({ domain, version }, release.version);
        continue;
      }
      if (!hasDomainAdapter(adapters, domain, version)) {
        missing.add({ domain, version }, release.version);
      }
    }
  }
  return missing.entries().map(([{ domain, version }, releases]) => {
    if (!isDomainName(domain)) {
      return `${releaseList(releases)} speak${releases.length === 1 ? "s" : ""} domain ${domain} v${version}, which is no longer in DOMAIN_NAMES; keep the domain and a client adapter for v${version} while the release is in the window.`;
    }
    const client = adapters.domains[domain]!;
    return `${releaseList(releases)} speak${releases.length === 1 ? "s" : ""} ${domain} v${version}, but the ${domain} client has adapters [${client.adapters.join(", ")}] (${ADAPTER_LIST_PATH}): keep adapter ${version} until the floor passes the first Stable release with v${version + 1}.`;
  });
}

function rowsNaming(register: RegisterDocument, name: string): boolean {
  return [...register.register, ...register.retired].some((row) => row.names.has(name));
}

/**
 * Check 3: no command of an in-window release disappeared without a bump and
 * a row. A capability command retired on schedule (`retired`, plan item
 * 7013) needs no bump: every in-window renderer has the domain and never
 * calls it.
 */
export function checkRemovedCommands(
  window: readonly ReleaseContract[],
  manifest: CiManifest,
  register: RegisterDocument,
  retired: ReadonlySet<string> = new Set(),
): string[] {
  const removed = grouped<{
    command: string;
    domain: string | null;
    unbumped: string | null;
    named: boolean;
  }>();
  for (const release of window) {
    for (const [command, entry] of Object.entries(release.commands)) {
      if (Object.hasOwn(manifest.commands, command)) continue;
      const domain = entry.domain;
      let unbumped: string | null = null;
      if (domain !== null) {
        const was = releaseDomainVersion(release, domain);
        const now = currentDomainVersion(manifest, domain);
        if ((was > 0 || now > 0) && now <= was && !retired.has(command))
          unbumped = `${domain} is v${now}, as in the release`;
      }
      const named = rowsNaming(register, command);
      if (named && unbumped === null) continue;
      removed.add({ command, domain, unbumped, named }, release.version);
    }
  }
  return removed.entries().map(([{ command, domain, unbumped, named }, releases]) => {
    const needs: string[] = [];
    if (unbumped !== null) needs.push(`a domain bump (${unbumped})`);
    if (!named)
      needs.push(`a register or retired row in ${REGISTER_DOCUMENT} naming \`${command}\``);
    return `${command}${domain === null ? "" : ` (${domain})`} is in ${releaseList(releases)} but no longer registered; removing it needs ${needs.join(" and ")}.`;
  });
}

/** Check 4 (domain part): bumps have rows, rows have adapters, no domain went backwards. */
export function checkDomainRegister(
  window: readonly ReleaseContract[],
  manifest: CiManifest,
  register: RegisterDocument,
  adapters: AdapterList,
): string[] {
  const problems: string[] = [];
  const rowed = new Set<string>();
  for (const row of register.register) {
    for (const adapter of rowAdapters(row)) {
      rowed.add(`${adapter.domain}@${adapter.version}`);
      if (!hasDomainAdapter(adapters, adapter.domain, adapter.version)) {
        problems.push(
          `${REGISTER_DOCUMENT}:${row.line} names \`${adapter.id}\`, but ${ADAPTER_LIST_PATH} has no ${adapter.domain} adapter ${adapter.version}: move the row to Retired.`,
        );
      }
    }
  }
  const unrowed = grouped<{ domain: string; was: number; now: number }>();
  const backwards = grouped<{ domain: string; was: number; now: number }>();
  for (const release of window) {
    for (const [domain, range] of Object.entries(release.domains)) {
      const now = currentDomainVersion(manifest, domain);
      const was = range.version;
      if (now < was) backwards.add({ domain, was, now }, release.version);
      else if (now > was && !rowed.has(`${domain}@${was}`)) {
        unrowed.add({ domain, was, now }, release.version);
      }
    }
  }
  for (const [{ domain, was, now }, releases] of backwards.entries()) {
    problems.push(
      `${domain} is at v${now}, below v${was} in ${releaseList(releases)}: a domain version never goes down.`,
    );
  }
  for (const [{ domain, was, now }, releases] of unrowed.entries()) {
    problems.push(
      `${domain} went from v${was} (${releaseList(releases)}) to v${now} without a register row: add one naming \`domain-adapter.renderer.${domain}.v${was}\` or \`domain-adapter.backend.${domain}.v${was}\` in ${REGISTER_DOCUMENT}#register.`,
    );
  }
  return problems;
}

/** The argument digests stage 2 needs: current manifest and in-window defined commands. */
export function neededArgumentDigests(
  window: readonly ReleaseContract[],
  manifest: CiManifest,
): Map<string, string[]> {
  const needed = new Map<string, string[]>();
  const add = (digest: string, user: string) => {
    const users = needed.get(digest) ?? [];
    if (!users.includes(user)) users.push(user);
    needed.set(digest, users);
  };
  for (const [command, entry] of Object.entries(manifest.commands)) {
    if (typeof entry.argsDigest === "string") add(entry.argsDigest, `${command} (current)`);
  }
  for (const release of window) {
    for (const [command, entry] of Object.entries(release.commands)) {
      if ("argsDigest" in entry && typeof entry.argsDigest === "string") {
        add(entry.argsDigest, `${command} (${release.version})`);
      }
    }
  }
  return needed;
}

/** One (command, older schema) pair stage 2 compares with the current tree. */
interface OlderSchema {
  readonly command: string;
  readonly digest: string;
  readonly domain: string;
  readonly version: number;
  readonly releases: string[];
}

function olderSchemas(window: readonly ReleaseContract[], manifest: CiManifest): OlderSchema[] {
  const byKey = new Map<string, OlderSchema>();
  for (const release of window) {
    for (const [command, entry] of Object.entries(release.commands)) {
      if (!("argsDigest" in entry) || typeof entry.argsDigest !== "string") continue;
      const current = manifest.commands[command];
      if (!current || typeof current.argsDigest !== "string" || entry.domain === null) continue;
      const version = releaseDomainVersion(release, entry.domain);
      const key = `${command}\u0000${entry.argsDigest}\u0000${version}`;
      const known = byKey.get(key);
      if (known) known.releases.push(release.version);
      else {
        byKey.set(key, {
          command,
          digest: entry.argsDigest,
          domain: entry.domain,
          version,
          releases: [release.version],
        });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => (a.command < b.command ? -1 : 1));
}

/** Check 6 (stage 2): no new required argument field without a domain bump. */
export function checkNewRequiredFields(
  window: readonly ReleaseContract[],
  manifest: CiManifest,
  contractsDirectory: string,
): string[] {
  const problems: string[] = [];
  for (const older of olderSchemas(window, manifest)) {
    const current = manifest.commands[older.command]!;
    if (current.argsDigest === older.digest) continue;
    if (current.domain !== older.domain) continue;
    if (currentDomainVersion(manifest, older.domain) > older.version) continue;
    let before;
    let after;
    try {
      before = readStoredSchema(contractsDirectory, older.digest);
      after = readStoredSchema(contractsDirectory, current.argsDigest!);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    // A missing schema is reported by the store check.
    if (before === null || after === null) continue;
    const fields = newRequiredFields(before, after);
    if (fields.length === 0) continue;
    problems.push(
      `${older.command} now requires ${fields.map((field) => `\`${field}\``).join(", ")}, which ${releaseList(older.releases)} did not send (${older.domain} is still v${older.version}): make ${fields.length === 1 ? "it" : "them"} optional, or bump ${older.domain}.`,
    );
  }
  return problems;
}

/** The fixture cases for check 7: every in-window older schema of a command still defined. */
export function fixtureCases(
  window: readonly ReleaseContract[],
  manifest: CiManifest,
  contractsDirectory: string,
): FixtureCase[] {
  const cases: FixtureCase[] = [];
  const seen = new Set<string>();
  for (const older of olderSchemas(window, manifest)) {
    const key = `${older.command}\u0000${older.digest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A bumped domain may refuse an older version's arguments by design.
    if (currentDomainVersion(manifest, older.domain) > older.version) continue;
    const document = readStoredSchema(contractsDirectory, older.digest);
    if (document === null) continue;
    cases.push({
      command: older.command,
      digest: older.digest,
      releases: older.releases,
      document,
    });
  }
  return cases;
}

/** The fixture report as problems. */
export function fixtureProblems(report: FixtureReport): string[] {
  return report.failures.map(
    (failure) =>
      `${failure.command}: the current parser refuses arguments valid for ${releaseList(failure.releases)} (${failure.digest.slice(0, 19)}...): ${failure.message}${failure.fixture === "" ? "" : `\n      fixture: ${failure.fixture.length > 400 ? `${failure.fixture.slice(0, 397)}...` : failure.fixture}`}`,
  );
}

export interface ContractCiOptions {
  readonly root?: string;
  readonly now?: Date;
  readonly stage2?: boolean;
  /** Counter ids the register may name. Defaults to `COMPATIBILITY_PATH_IDS`. */
  readonly counterIds?: Iterable<string>;
  /** The capability commands the list must classify. Defaults to `LEGACY_CAPABILITY_COMMANDS`. */
  readonly legacyCapabilityCommands?: Readonly<Partial<Record<string, readonly string[]>>>;
  /** Print the retirement schedule instead of checking (`--retirements`). */
  readonly retirements?: "text" | "json";
  /** Runs the fixtures. Defaults to the sandboxed registry child. */
  readonly runFixtures?: (cases: readonly FixtureCase[]) => Promise<FixtureReport>;
  readonly log?: (line: string) => void;
}

function readText(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** Runs the job. Returns the exit status. */
export async function runContractCi(options: ContractCiOptions = {}): Promise<number> {
  const root = options.root ?? repoRoot;
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? new Date();
  const stage2 = options.stage2 ?? CONTRACT_CI_STAGE_2;
  const contractsDirectory = join(root, CONTRACTS_DIRECTORY);
  const sections: Array<readonly [string, string[]]> = [];
  const fatal = (message: string) => {
    log(`Contract CI cannot run: ${message}`);
    log(`Contract rules: ${CONTRACT_DOCS}`);
    return 1;
  };

  let index: ReleaseIndex;
  let manifest: CiManifest;
  let adapters: AdapterList | null;
  let register: RegisterDocument;
  try {
    index = readReleaseIndex(contractsDirectory);
    const manifestText = readText(join(contractsDirectory, "manifest.json"));
    if (manifestText === null) return fatal(`${CONTRACTS_DIRECTORY}/manifest.json is missing.`);
    manifest = JSON.parse(manifestText) as CiManifest;
    const adapterText = readText(join(root, ADAPTER_LIST_PATH));
    if (adapterText === null) return fatal(`${ADAPTER_LIST_PATH} is missing.`);
    adapters = parseAdapterList(JSON.parse(adapterText));
    const registerText = readText(join(root, REGISTER_DOCUMENT));
    if (registerText === null) return fatal(`${REGISTER_DOCUMENT} is missing.`);
    register = parseRegisterDocument(registerText);
  } catch (error) {
    return fatal(error instanceof Error ? error.message : String(error));
  }
  if (adapters === null) return fatal(`${ADAPTER_LIST_PATH} is not a valid adapter list.`);
  let retirementList: RetirementList | string;
  try {
    const listText = readText(join(root, RETIREMENT_LIST_PATH));
    retirementList =
      listText === null
        ? `${RETIREMENT_LIST_PATH} is missing.`
        : parseRetirementList(JSON.parse(listText));
  } catch (error) {
    retirementList = `${RETIREMENT_LIST_PATH}: ${error instanceof Error ? error.message : String(error)}`;
  }

  const releasesDirectory = join(contractsDirectory, "releases");
  const snapshotVersions = existsSync(releasesDirectory)
    ? readdirSync(releasesDirectory)
        .filter((name) => name.endsWith(".json") && name !== "index.json")
        .map((name) => name.slice(0, -".json".length))
    : [];
  sections.push(["Release index", checkReleaseIndex(index, snapshotVersions)]);

  const floor = supportFloor(index, now);
  const inWindow = windowReleases(index, floor.version);
  const window: ReleaseContract[] = [];
  const unreadable: string[] = [];
  for (const entry of inWindow) {
    try {
      window.push(readReleaseSnapshot(contractsDirectory, entry.version));
    } catch (error) {
      unreadable.push(error instanceof Error ? error.message : String(error));
    }
  }
  sections.push(["Release snapshots", unreadable]);

  // Every Stable release, also below the floor: the first one that advertises
  // a domain version dates its older adapter's retirement.
  const stable: StableRelease[] = [];
  for (const entry of index.releases) {
    if (entry.channel !== "stable") continue;
    const snapshot =
      window.find((release) => release.version === entry.version) ??
      (() => {
        try {
          return readReleaseSnapshot(contractsDirectory, entry.version);
        } catch {
          return null; // reported by the index check when the file is missing
        }
      })();
    if (snapshot !== null) {
      stable.push({
        version: entry.version,
        publishedAt: entry.publishedAt,
        domains: snapshot.domains,
      });
    }
  }
  const schedule =
    typeof retirementList === "string"
      ? null
      : retirementSchedule({
          adapters,
          list: retirementList,
          stable,
          floor: floor.version,
          now,
          register,
        });
  if (options.retirements !== undefined) {
    if (schedule === null) return fatal(retirementList as string);
    if (options.retirements === "json") log(JSON.stringify(schedule, null, 2));
    else for (const line of formatRetirementSchedule(schedule)) log(line);
    return 0;
  }

  const unpublished = inWindow.filter((entry) => entry.publishedAt === null).length;
  log(
    `Support floor on ${now.toISOString().slice(0, 10)}: v${floor.version} (${floor.release ? `the newest Stable release published at least ${SUPPORT_WINDOW_DAYS} days earlier, ${floor.release.publishedAt}` : `no Stable release is ${SUPPORT_WINDOW_DAYS} days old yet`}). In the window: ${inWindow.length} snapshotted releases${inWindow.length > 0 ? `, v${inWindow[0]!.version} to v${inWindow.at(-1)!.version}` : ""}${unpublished > 0 ? `, ${unpublished} not yet published` : ""}.`,
  );

  const knownIds = new Set<string>(options.counterIds ?? COMPATIBILITY_PATH_IDS);
  sections.push(["Client adapters", checkAdapters(window, adapters)]);
  sections.push([
    "Removed commands",
    checkRemovedCommands(
      window,
      manifest,
      register,
      schedule === null ? undefined : retiredCommands(schedule),
    ),
  ]);
  sections.push([
    "Register",
    [
      ...checkRegisterCounters(register, knownIds),
      ...checkDomainRegister(window, manifest, register, adapters),
    ],
  ]);
  sections.push([
    "Argument schema store",
    checkSchemaStore(contractsDirectory, neededArgumentDigests(window, manifest)),
  ]);
  sections.push([
    "Retirements",
    typeof retirementList === "string"
      ? [retirementList]
      : [
          ...checkRetirementList(
            retirementList,
            manifest.commands,
            register,
            options.legacyCapabilityCommands,
          ),
          ...checkRetirements(schedule!),
        ],
  ]);

  if (stage2) {
    sections.push([
      "New required fields",
      checkNewRequiredFields(window, manifest, contractsDirectory),
    ]);
    let fixtures: string[];
    try {
      const cases = fixtureCases(window, manifest, contractsDirectory);
      const report = await (options.runFixtures ?? runFixturesInChild)(cases);
      log(`Argument fixtures: ${report.checked} decoded from ${cases.length} older schemas.`);
      fixtures = fixtureProblems(report);
    } catch (error) {
      fixtures = [error instanceof Error ? error.message : String(error)];
    }
    sections.push(["Argument fixtures", fixtures]);
  } else {
    log("Stage 2 (argument fixtures, new required fields) is off: CONTRACT_CI_STAGE_2.");
  }

  const failed = sections.filter(([, problems]) => problems.length > 0);
  if (failed.length === 0) {
    log(`Contract CI passed: ${sections.map(([name]) => name.toLowerCase()).join(", ")}.`);
    return 0;
  }
  for (const [name, problems] of failed) {
    log(`${name}:`);
    for (const problem of problems) log(`  - ${problem}`);
  }
  log(`Contract rules: ${CONTRACT_DOCS}`);
  return 1;
}

export function parseArguments(args: readonly string[]): {
  readonly now?: Date;
  readonly stage2?: boolean;
  readonly retirements?: "text" | "json";
} {
  const usage =
    "usage: bun scripts/contract-ci.ts [--stage2] [--now <ISO date>] [--retirements [--json]]";
  let now: Date | undefined;
  let stage2: boolean | undefined;
  let retirements = false;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--stage2" && stage2 === undefined) stage2 = true;
    else if (arg === "--retirements" && !retirements) retirements = true;
    else if (arg === "--json" && !json) json = true;
    else if (arg === "--now" && now === undefined && args[index + 1] !== undefined) {
      now = new Date(args[++index]!);
      if (!Number.isFinite(now.getTime())) throw new Error(`${usage}\nbad date ${args[index]}`);
    } else throw new Error(usage);
  }
  if (json && !retirements) throw new Error(`${usage}\n--json needs --retirements`);
  return {
    ...(now === undefined ? {} : { now }),
    ...(stage2 === undefined ? {} : { stage2 }),
    ...(retirements ? { retirements: json ? ("json" as const) : ("text" as const) } : {}),
  };
}

if (import.meta.main) {
  try {
    process.exit(await runContractCi(parseArguments(process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
