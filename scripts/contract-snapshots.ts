/**
 * Release contract snapshots (plan item 1007, docs/reports/unified-federation.md
 * §11.3 step 2): what each published release's command surface was, so the
 * contract CI job (plan item 1008) has something to compare the current tree
 * against.
 *
 * Layout under `packages/protocol/contracts/`:
 *
 * - `releases/<version>.json`: one per release. It names, for each domain, the
 *   blob holding that domain's commands (`file`, `digest`), plus the derived
 *   totals, the channel and whether the release is pre-contract.
 * - `domains/<domain>-<hex16>.json`: one domain's commands at some release,
 *   shared by every release whose domain is byte-identical, so storage grows
 *   with domain changes rather than with releases. The digest is the SHA-256
 *   of the blob's text; `<hex16>` is its first 16 hex digits. Commands of an
 *   old release that the current domain map does not place go in an
 *   `unmapped-<hex16>.json` blob (`domain: null`).
 * - `releases/index.json`: every snapshotted release with its channel and
 *   GitHub publication time (`null` until it is published), sorted by
 *   version, so the CI job computes the support floor without `git tag`.
 *
 * A release from before the contract (every published release up to the one
 * that advertises `domains` in its hello) has no `defineCommand` and no domain
 * map. Its snapshot is its registered command names, each `{ untyped: true }`
 * with `read` from its own routing classifier when the release has one
 * (`isNodeReadCommand`, from v2.26.1-alpha), placed in domains by the domain
 * map of the tree that ran the backfill, and is marked `preContract: true`.
 *
 * Only Node built-ins are imported: `scripts/set-version.ts` uses this module
 * and the repository root does not depend on `effect`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  hostUpdateChannelOfVersion,
  type HostUpdateChannel,
} from "../packages/protocol/src/host-maintenance.js";
import type { ContractManifest, DefinedCommandEntry } from "./generate-contract-manifest.ts";

/** The contracts directory, relative to the repository root. */
export const CONTRACTS_DIRECTORY = "packages/protocol/contracts";
/** The release index, relative to the contracts directory. */
export const RELEASE_INDEX_FILE = "releases/index.json";
/** The snapshot file formats; a reader refuses a version it does not know. */
export const RELEASE_SNAPSHOT_SCHEMA_VERSION = 1;
/** The first published release (docs/architecture/version-compatibility.md). */
export const FIRST_PUBLISHED_RELEASE = "2.21.0";
/** The GitHub repository whose non-draft releases are the published ones. */
export const RELEASE_REPOSITORY = "orkestrator-ai/orkestrator-v2";
/** `bun fmt`'s print width (`bunfig.toml`), so every file is already formatted. */
const PRINT_WIDTH = 100;
const DIGEST_FILE_CHARS = 16;

/** A command in a domain blob: its manifest entry without the domain, which the blob carries. */
export type SnapshotCommandEntry =
  Omit<DefinedCommandEntry, "domain"> | { readonly untyped: true; readonly read?: boolean };

/** One domain's commands at some release (`domains/<domain>-<hex16>.json`). */
export interface DomainBlob {
  readonly schemaVersion: typeof RELEASE_SNAPSHOT_SCHEMA_VERSION;
  /** `null` for the commands the domain map does not place (`unmapped-<hex16>.json`). */
  readonly domain: string | null;
  /** The domain's version and the oldest it accepts, when it has a defined command. */
  readonly version?: number;
  readonly min?: number;
  readonly commands: { readonly [command: string]: SnapshotCommandEntry };
}

/** A release file's reference to a blob. */
export interface DomainBlobReference {
  /** Relative to the contracts directory. */
  readonly file: string;
  /** `sha256:<hex>` of the blob's text. */
  readonly digest: string;
  readonly commands: number;
  readonly version?: number;
  readonly min?: number;
}

/** `releases/<version>.json`. */
export interface ReleaseSnapshotFile {
  readonly schemaVersion: typeof RELEASE_SNAPSHOT_SCHEMA_VERSION;
  readonly version: string;
  readonly channel: HostUpdateChannel;
  /** The release's hello advertises no `domains`; every command is untyped. */
  readonly preContract: boolean;
  /**
   * `manifest`: split from the release's committed contract manifest.
   * `registry`: enumerated from the release's command registry, domains from
   * the current domain map (pre-contract releases).
   */
  readonly source: "manifest" | "registry";
  /** The tagged commit, for a backfilled release. */
  readonly commit?: string;
  /** Every untyped entry carries `read` (false when the release had no classifier). */
  readonly readClassified: boolean;
  readonly counts: {
    readonly commands: number;
    readonly defined: number;
    readonly untyped: number;
    readonly unmapped: number;
  };
  readonly domains: { readonly [domain: string]: DomainBlobReference };
  /** Present when some command has no domain in the map. */
  readonly unmapped?: DomainBlobReference;
  /** Typed events (plan item 7011), copied from the manifest. */
  readonly events: { readonly [event: string]: unknown };
}

export interface ReleaseIndexEntry {
  readonly version: string;
  readonly channel: HostUpdateChannel;
  /** When the GitHub release was published; `null` while it is not (yet). */
  readonly publishedAt: string | null;
}

/** `releases/index.json`. */
export interface ReleaseIndex {
  readonly schemaVersion: typeof RELEASE_SNAPSHOT_SCHEMA_VERSION;
  readonly generatedBy: string;
  /** Sorted by version. */
  readonly releases: readonly ReleaseIndexEntry[];
}

/** What a snapshot is built from. */
export interface ReleaseContractInput {
  readonly version: string;
  readonly preContract: boolean;
  readonly source: ReleaseSnapshotFile["source"];
  readonly commit?: string;
  /** Every registered command: its domain (`null` when unmapped) and entry. */
  readonly commands: Iterable<
    readonly [string, { readonly domain: string | null; readonly entry: SnapshotCommandEntry }]
  >;
  /** Each defined domain's range. */
  readonly domains?: {
    readonly [domain: string]: { readonly version: number; readonly min: number };
  };
  readonly events?: { readonly [event: string]: unknown };
}

/** A release's commands reassembled from its file and blobs, digests verified. */
export interface ReleaseContract {
  readonly version: string;
  readonly channel: HostUpdateChannel;
  readonly preContract: boolean;
  readonly readClassified: boolean;
  readonly domains: {
    readonly [domain: string]: { readonly version: number; readonly min: number };
  };
  readonly commands: {
    readonly [command: string]: SnapshotCommandEntry & { readonly domain: string | null };
  };
  readonly events: { readonly [event: string]: unknown };
}

/** A non-draft GitHub release in the support window's range. */
export interface PublishedRelease {
  readonly version: string;
  readonly tag: string;
  readonly publishedAt: string;
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

function fail(message: string): never {
  throw new Error(message);
}

function byKey<T>(entries: Iterable<readonly [string, T]>): { [key: string]: T } {
  const record: { [key: string]: T } = {};
  for (const [key, value] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    record[key] = value;
  }
  return record;
}

/** The channel a release version ships on; throws for a version no channel ships. */
export function releaseChannel(version: string): HostUpdateChannel {
  return hostUpdateChannelOfVersion(version) ?? fail(`${version} is not a release version.`);
}

export function compareVersions(a: string, b: string): number {
  return Bun.semver.order(a, b);
}

/** `sha256:<hex>` of `text`. */
export function textDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** The blob file for a domain (`null`: the unmapped commands) and digest. */
export function domainBlobFile(domain: string | null, digest: string): string {
  const hex = /^sha256:([0-9a-f]{64})$/u.exec(digest)?.[1] ?? fail(`bad digest ${digest}`);
  return `domains/${domain ?? "unmapped"}-${hex.slice(0, DIGEST_FILE_CHARS)}.json`;
}

export function releaseSnapshotFile(version: string): string {
  return `releases/${version}.json`;
}

/**
 * JSON with two-space indentation in the shape `bun fmt` keeps (the same
 * rules as `serializeContractManifest`): objects expanded, an empty one as
 * `{}`, and an array of scalars on one line when the line fits the print
 * width, one element per line otherwise.
 */
export function formatSnapshotJson(value: unknown): string {
  return `${formatJson(value as Json, "", "", 0)}\n`;
}

function formatJson(value: Json, indent: string, prefix: string, suffix: number): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((item) => item === null || typeof item !== "object")) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
      if (indent.length + prefix.length + inline.length + suffix <= PRINT_WIDTH) return inline;
    }
    const items = value.map(
      (item, index) => `${inner}${formatJson(item, inner, "", index < value.length - 1 ? 1 : 0)}`,
    );
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  const record = value as { readonly [key: string]: Json };
  // `undefined` members are not written, as in JSON.stringify.
  const keys = Object.keys(record).filter((key) => record[key] !== undefined);
  if (keys.length === 0) return "{}";
  const lines = keys.map((key, index) => {
    const keyText = `${JSON.stringify(key)}: `;
    const comma = index < keys.length - 1 ? 1 : 0;
    return `${inner}${keyText}${formatJson(record[key] as Json, inner, keyText, comma)}`;
  });
  return `{\n${lines.join(",\n")}\n${indent}}`;
}

/** The snapshot input of a release whose tree commits a contract manifest. */
export function releaseInputFromManifest(
  version: string,
  manifest: ContractManifest,
  options: { readonly commit?: string } = {},
): ReleaseContractInput {
  if (manifest.schemaVersion !== 1) {
    fail(`Unknown contract manifest schemaVersion ${String(manifest.schemaVersion)}.`);
  }
  return {
    version,
    // A tree with a manifest advertises `domains` in its hello (plan item 1004).
    preContract: false,
    source: "manifest",
    ...(options.commit === undefined ? {} : { commit: options.commit }),
    commands: Object.entries(manifest.commands).map(([name, { domain, ...entry }]) => [
      name,
      { domain, entry },
    ]),
    domains: manifest.domains,
    events: manifest.events,
  };
}

/**
 * The snapshot input of a pre-contract release: its command names, `read`
 * from its own classifier when it has one, domains from `domainOf`.
 */
export function releaseInputFromRegistry(input: {
  readonly version: string;
  readonly commit?: string;
  readonly names: Iterable<string>;
  readonly isRead?: ((command: string) => boolean) | undefined;
  readonly domainOf: ReadonlyMap<string, string>;
}): ReleaseContractInput {
  const isRead = input.isRead;
  return {
    version: input.version,
    preContract: true,
    source: "registry",
    ...(input.commit === undefined ? {} : { commit: input.commit }),
    commands: [...new Set(input.names)].map((name) => [
      name,
      {
        domain: input.domainOf.get(name) ?? null,
        entry: isRead ? { untyped: true, read: isRead(name) } : { untyped: true },
      },
    ]),
  };
}

/** The release file and every blob it references (path relative to the contracts directory → text). */
export function buildReleaseSnapshot(input: ReleaseContractInput): {
  readonly release: ReleaseSnapshotFile;
  readonly releaseText: string;
  readonly blobs: ReadonlyMap<string, string>;
} {
  const channel = releaseChannel(input.version);
  const byDomain = new Map<string | null, Array<readonly [string, SnapshotCommandEntry]>>();
  let defined = 0;
  let untyped = 0;
  let unclassified = 0;
  for (const [name, { domain, entry }] of input.commands) {
    const list = byDomain.get(domain) ?? [];
    list.push([name, entry]);
    byDomain.set(domain, list);
    if ("untyped" in entry) {
      untyped += 1;
      if (entry.read === undefined) unclassified += 1;
    } else defined += 1;
  }
  const ranges = input.domains ?? {};
  for (const domain of Object.keys(ranges)) {
    if (!byDomain.has(domain)) fail(`Domain ${domain} has a range but no command.`);
  }
  const blobs = new Map<string, string>();
  const references = new Map<string | null, DomainBlobReference>();
  for (const [domain, commands] of byDomain) {
    const range = domain === null ? undefined : ranges[domain];
    const blob: DomainBlob = {
      schemaVersion: RELEASE_SNAPSHOT_SCHEMA_VERSION,
      domain,
      ...(range ? { version: range.version, min: range.min } : {}),
      commands: byKey(commands),
    };
    const text = formatSnapshotJson(blob);
    const digest = textDigest(text);
    const file = domainBlobFile(domain, digest);
    blobs.set(file, text);
    references.set(domain, {
      file,
      digest,
      commands: commands.length,
      ...(range ? { version: range.version, min: range.min } : {}),
    });
  }
  const unmapped = references.get(null);
  references.delete(null);
  const release: ReleaseSnapshotFile = {
    schemaVersion: RELEASE_SNAPSHOT_SCHEMA_VERSION,
    version: input.version,
    channel,
    preContract: input.preContract,
    source: input.source,
    ...(input.commit === undefined ? {} : { commit: input.commit }),
    readClassified: unclassified === 0,
    counts: {
      commands: defined + untyped,
      defined,
      untyped,
      unmapped: unmapped?.commands ?? 0,
    },
    domains: byKey([...references] as Array<readonly [string, DomainBlobReference]>),
    ...(unmapped ? { unmapped } : {}),
    events: byKey(Object.entries(input.events ?? {})),
  };
  return { release, releaseText: formatSnapshotJson(release), blobs };
}

/**
 * Writes the release file and any blob not already present. A present blob
 * must be byte-identical (a different text under the same name is a 64-bit
 * prefix collision or a hand edit, and is refused). Returns the files
 * written, relative to the contracts directory.
 */
export function writeReleaseSnapshot(
  contractsDirectory: string,
  input: ReleaseContractInput,
): { readonly release: ReleaseSnapshotFile; readonly written: readonly string[] } {
  const { release, releaseText, blobs } = buildReleaseSnapshot(input);
  const written: string[] = [];
  const pending: Array<readonly [string, string]> = [];
  for (const [file, text] of blobs) {
    const target = path.join(contractsDirectory, file);
    if (existsSync(target)) {
      if (readFileSync(target, "utf8") !== text) {
        fail(`${file} exists with different contents; refusing to overwrite a shared blob.`);
      }
      continue;
    }
    pending.push([file, text]);
  }
  pending.push([releaseSnapshotFile(release.version), releaseText]);
  for (const [file, text] of pending) {
    const target = path.join(contractsDirectory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    if (existsSync(target) && readFileSync(target, "utf8") === text) continue;
    writeFileSync(target, text);
    written.push(file);
  }
  return { release, written };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Reads a release's snapshot and its blobs, verifying each blob's digest,
 * domain and command count against the release file.
 */
export function readReleaseSnapshot(contractsDirectory: string, version: string): ReleaseContract {
  const file = path.join(contractsDirectory, releaseSnapshotFile(version));
  const release = readJson(file) as ReleaseSnapshotFile;
  if (release.schemaVersion !== RELEASE_SNAPSHOT_SCHEMA_VERSION) {
    fail(`${file}: unknown schemaVersion ${String(release.schemaVersion)}.`);
  }
  if (release.version !== version) fail(`${file} describes ${release.version}.`);
  const commands: { [command: string]: SnapshotCommandEntry & { domain: string | null } } = {};
  const domains: { [domain: string]: { version: number; min: number } } = {};
  const load = (domain: string | null, reference: DomainBlobReference) => {
    if (reference.file !== domainBlobFile(domain, reference.digest)) {
      fail(`${file}: ${reference.file} does not match its domain and digest.`);
    }
    const text = readFileSync(path.join(contractsDirectory, reference.file), "utf8");
    if (textDigest(text) !== reference.digest) fail(`${reference.file} does not match its digest.`);
    const blob = JSON.parse(text) as DomainBlob;
    if (blob.domain !== domain) fail(`${reference.file} holds domain ${String(blob.domain)}.`);
    const names = Object.keys(blob.commands);
    if (names.length !== reference.commands) {
      fail(`${reference.file} holds ${names.length} commands, ${file} says ${reference.commands}.`);
    }
    if (domain !== null && blob.version !== undefined && blob.min !== undefined) {
      domains[domain] = { version: blob.version, min: blob.min };
    }
    for (const name of names) {
      if (Object.hasOwn(commands, name)) fail(`${name} appears in two domains of ${file}.`);
      commands[name] = { ...blob.commands[name]!, domain };
    }
  };
  for (const [domain, reference] of Object.entries(release.domains)) load(domain, reference);
  if (release.unmapped) load(null, release.unmapped);
  if (Object.keys(commands).length !== release.counts.commands) {
    fail(`${file}: counts.commands does not match its blobs.`);
  }
  return {
    version: release.version,
    channel: release.channel,
    preContract: release.preContract,
    readClassified: release.readClassified,
    domains,
    commands: byKey(Object.entries(commands)),
    events: release.events,
  };
}

const INDEX_GENERATED_BY =
  "scripts/set-version.ts (mise run release:version) and scripts/backfill-contract-snapshots.ts (mise run contract:backfill)";

export function emptyReleaseIndex(): ReleaseIndex {
  return {
    schemaVersion: RELEASE_SNAPSHOT_SCHEMA_VERSION,
    generatedBy: INDEX_GENERATED_BY,
    releases: [],
  };
}

/** The committed index, or an empty one when there is none. */
export function readReleaseIndex(contractsDirectory: string): ReleaseIndex {
  const file = path.join(contractsDirectory, RELEASE_INDEX_FILE);
  if (!existsSync(file)) return emptyReleaseIndex();
  const index = readJson(file) as ReleaseIndex;
  if (index.schemaVersion !== RELEASE_SNAPSHOT_SCHEMA_VERSION) {
    fail(`${file}: unknown schemaVersion ${String(index.schemaVersion)}.`);
  }
  return index;
}

/**
 * Adds or updates entries, sorted by version. A known publication time is
 * never replaced by `null`, so recording a version again before its release
 * is published keeps the date a later refresh found.
 */
export function withReleaseIndexEntries(
  index: ReleaseIndex,
  entries: Iterable<{ readonly version: string; readonly publishedAt: string | null }>,
): ReleaseIndex {
  const byVersion = new Map(index.releases.map((entry) => [entry.version, entry]));
  for (const { version, publishedAt } of entries) {
    const known = byVersion.get(version);
    byVersion.set(version, {
      version,
      channel: releaseChannel(version),
      publishedAt: publishedAt ?? known?.publishedAt ?? null,
    });
  }
  return {
    schemaVersion: RELEASE_SNAPSHOT_SCHEMA_VERSION,
    generatedBy: INDEX_GENERATED_BY,
    releases: [...byVersion.values()].sort((a, b) => compareVersions(a.version, b.version)),
  };
}

/** Writes the index when it changed; returns whether it did. */
export function writeReleaseIndex(contractsDirectory: string, index: ReleaseIndex): boolean {
  const file = path.join(contractsDirectory, RELEASE_INDEX_FILE);
  const text = formatSnapshotJson(index);
  if (existsSync(file) && readFileSync(file, "utf8") === text) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return true;
}

/**
 * The published releases from `gh release list --json tagName,isDraft,publishedAt`:
 * non-draft, a release version at or after {@link FIRST_PUBLISHED_RELEASE},
 * sorted by version. Drafts (v2.24.0-alpha to v2.26.1-alpha, v2.35.2-beta) are
 * not published, whatever npm carries.
 */
export function parseGitHubReleases(json: string): PublishedRelease[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) fail("gh release list did not return an array.");
  const releases: PublishedRelease[] = [];
  for (const item of parsed as Array<Record<string, unknown>>) {
    const tag = item.tagName;
    const publishedAt = item.publishedAt;
    if (item.isDraft !== false || typeof tag !== "string" || typeof publishedAt !== "string") {
      continue;
    }
    if (!/^v\d/u.test(tag) || Number.isNaN(Date.parse(publishedAt))) continue;
    const version = tag.slice(1);
    if (!hostUpdateChannelOfVersion(version)) continue;
    if (compareVersions(version, FIRST_PUBLISHED_RELEASE) < 0) continue;
    releases.push({ version, tag, publishedAt });
  }
  return releases.sort((a, b) => compareVersions(a.version, b.version));
}

/** The `gh` command that lists releases (read-only). */
export const GH_RELEASE_LIST_COMMAND = [
  "gh",
  "release",
  "list",
  "--repo",
  RELEASE_REPOSITORY,
  "--limit",
  "1000",
  "--json",
  "tagName,isDraft,publishedAt",
] as const;
