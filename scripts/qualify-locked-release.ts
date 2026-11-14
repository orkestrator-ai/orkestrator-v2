/**
 * Evidence that an installed standalone release came from its published
 * lockfile, for `scripts/qualify-standalone-service.ts` (to-do 5022 task 2,
 * retired 2026-11-14; the run is in docs/architecture/host-updates.md).
 *
 * `installRelease` (`packages/protocol/src/node/standalone-service.ts`) copies
 * the package's `resources/release-runtime/{package.json,bun.lock}` into the
 * release directory and runs `bun install --frozen-lockfile --linker=hoisted`
 * there. So a release installed that way has, at its root, byte-for-byte the
 * manifest and lockfile the package published, and every package under its
 * `node_modules` has the version that lockfile names. A release that resolved
 * afresh (a release before the lockfile, or an updater without it) has a
 * generated manifest, no lockfile, and whatever versions npm served that day.
 *
 * The check reads only the release directory. Loading `sharp`, the one native
 * dependency, runs a separate Bun process in the release's package root.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  RELEASE_RUNTIME_PATH,
  releasePackageRoot,
  STANDALONE_PACKAGE,
} from "../packages/protocol/src/node/standalone-service";

export interface LockedReleaseEvidence {
  /** The package published `resources/release-runtime/` with a lockfile. */
  publishedRuntime: boolean;
  /** The release root's `bun.lock` is byte-for-byte the published one. */
  lockMatchesPublished: boolean;
  /** The release root's `package.json` is byte-for-byte the published one. */
  manifestMatchesPublished: boolean;
  lockSha256: string | null;
  /** Entries in the lockfile's `packages`. */
  lockEntries: number;
  /** Lockfile entries found installed, each at the version the lockfile names. */
  installedAtLockedVersion: number;
  /** Installed packages whose version is not the one the lockfile names. */
  mismatched: { name: string; locked: string; installed: string }[];
  /**
   * Installed packages, at any depth, whose `node_modules` path the lockfile
   * does not list (the release package itself excepted). A nested copy shadows
   * the hoisted one for the package above it, so it counts like a top-level one.
   */
  extraneous: string[];
  /** The host the absent entries were judged against. */
  host: ReleaseHost;
  /**
   * Absent lockfile entries that only a required dependency path reaches, with
   * no platform limit that excludes this host. A frozen install leaves none.
   */
  missingRequired: string[];
  /**
   * Absent lockfile entries whose os, cpu and libc limits all name this host.
   * Bun installs such an entry, required or optional, so a frozen install
   * leaves none.
   */
  missingForHost: string[];
  /** Absent lockfile entries whose os, cpu or libc limit excludes this host. */
  otherPlatform: number;
  /**
   * Absent lockfile entries with no platform limit that only optional
   * dependency edges reach (an optional dependency, or a dependency of one).
   */
  notInstalled: string[];
  /** The locked versions of the packages the release runtime depends on directly. */
  direct: Record<string, string>;
  error?: string;
}

export interface LoadEvidence {
  ok: boolean;
  sharp?: string;
  libvips?: string;
  format?: string;
  error?: string;
}

/** The platform a lockfile entry's `os`, `cpu` and `libc` limits are judged against. */
export interface ReleaseHost {
  os: string;
  cpu: string;
  /** `glibc` or `musl` on Linux; `null` elsewhere, where no entry is libc-limited. */
  libc: string | null;
}

/** The host this process runs on, which is the host the release was installed for. */
export function currentHost(): ReleaseHost {
  let libc: string | null = null;
  if (process.platform === "linux") {
    const report = process.report?.getReport?.() as
      { header?: { glibcVersionRuntime?: unknown } } | undefined;
    libc = typeof report?.header?.glibcVersionRuntime === "string" ? "glibc" : "musl";
  }
  return { os: process.platform, cpu: process.arch, libc };
}

/**
 * Whether one `os`/`cpu`/`libc` value admits `actual`, with npm's rules: a
 * string or a list, where `!name` excludes and a list of only exclusions
 * admits everything else. A limit on a host value that is unknown (`libc`
 * off Linux) does not admit it.
 */
function limitAdmits(limit: unknown, actual: string | null): boolean {
  if (limit === undefined) return true;
  const values = (Array.isArray(limit) ? limit : [limit]).filter(
    (value): value is string => typeof value === "string",
  );
  if (values.length === 0) return true;
  if (actual === null) return false;
  const excluded = values.filter((value) => value.startsWith("!")).map((value) => value.slice(1));
  const included = values.filter((value) => !value.startsWith("!"));
  if (excluded.includes(actual)) return false;
  return included.length === 0 || included.includes(actual);
}

interface EntryMeta {
  os?: unknown;
  cpu?: unknown;
  libc?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalPeers?: string[];
}

function entryMeta(entry: unknown[] | undefined): EntryMeta {
  const meta = entry?.[2];
  return meta !== null && typeof meta === "object" ? (meta as EntryMeta) : {};
}

function platformLimited(meta: EntryMeta): boolean {
  return meta.os !== undefined || meta.cpu !== undefined || meta.libc !== undefined;
}

function admitsHost(meta: EntryMeta, host: ReleaseHost): boolean {
  return (
    limitAdmits(meta.os, host.os) &&
    limitAdmits(meta.cpu, host.cpu) &&
    limitAdmits(meta.libc, host.libc)
  );
}

/**
 * The lockfile key `name` resolves to when required from the package at
 * `fromKey` (`""` for the release root): Node's walk up the `node_modules`
 * chain, as a hoisted lockfile records it.
 */
function resolveLockKey(
  packages: Record<string, unknown[]>,
  fromKey: string,
  name: string,
): string | null {
  const segments = fromKey === "" ? [] : lockKeySegments(fromKey);
  for (let depth = segments.length; depth >= 0; depth--) {
    const key = [...segments.slice(0, depth), name].join("/");
    if (packages[key] !== undefined) return key;
  }
  return null;
}

/**
 * Lockfile keys reached from the root through required edges only
 * (`dependencies`, and peers not marked optional), plus required names that
 * resolve to no entry at all.
 */
function requiredClosure(
  packages: Record<string, unknown[]>,
  rootDependencies: Record<string, string>,
): { required: Set<string>; unresolved: string[] } {
  const required = new Set<string>();
  const unresolved: string[] = [];
  const queue: { from: string; name: string; peer: boolean }[] = Object.keys(rootDependencies).map(
    (name) => ({ from: "", name, peer: false }),
  );
  while (queue.length > 0) {
    const { from, name, peer } = queue.shift()!;
    const key = resolveLockKey(packages, from, name);
    if (key === null) {
      // A peer may be satisfied by whatever the host provides; a dependency may not.
      if (!peer) unresolved.push(`${name} (required by ${from || "the release root"})`);
      continue;
    }
    if (required.has(key)) continue;
    required.add(key);
    const meta = entryMeta(packages[key]);
    for (const dependency of Object.keys(meta.dependencies ?? {})) {
      queue.push({ from: key, name: dependency, peer: false });
    }
    const optionalPeers = new Set(meta.optionalPeers ?? []);
    for (const dependency of Object.keys(meta.peerDependencies ?? {})) {
      if (!optionalPeers.has(dependency)) queue.push({ from: key, name: dependency, peer: true });
    }
  }
  return { required, unresolved };
}

/** True when the evidence shows a frozen install of the published lockfile. */
export function installedFromLockfile(evidence: LockedReleaseEvidence): boolean {
  return (
    evidence.error === undefined &&
    evidence.publishedRuntime &&
    evidence.lockMatchesPublished &&
    evidence.manifestMatchesPublished &&
    evidence.installedAtLockedVersion > 0 &&
    evidence.mismatched.length === 0 &&
    evidence.extraneous.length === 0 &&
    evidence.missingRequired.length === 0 &&
    evidence.missingForHost.length === 0 &&
    Object.keys(evidence.direct).length > 0
  );
}

function readOptional(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

/**
 * Splits a hoisted lockfile key (`a`, `@s/a`, `a/b`, `@s/a/@t/b`) into the
 * package names along its `node_modules` path.
 */
export function lockKeySegments(key: string): string[] {
  const parts = key.split("/");
  const segments: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part.startsWith("@") && index + 1 < parts.length) {
      segments.push(`${part}/${parts[++index]!}`);
    } else segments.push(part);
  }
  return segments;
}

/** Package names directly under a `node_modules` directory, scopes expanded. */
function installedNames(nodeModules: string): string[] {
  if (!existsSync(nodeModules)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const scoped of readdirSync(path.join(nodeModules, entry.name))) {
        if (!scoped.startsWith(".")) names.push(`${entry.name}/${scoped}`);
      }
    } else names.push(entry.name);
  }
  return names;
}

/**
 * Every installed package's lockfile key (`a`, `a/b`, `@s/a/@t/b`), walking
 * each package's own `node_modules` as well as the release's. Symbolic links
 * are listed but not followed.
 */
function installedKeys(nodeModules: string, parentKey = ""): string[] {
  const keys: string[] = [];
  for (const name of installedNames(nodeModules)) {
    const key = parentKey === "" ? name : `${parentKey}/${name}`;
    keys.push(key);
    const nested = path.join(nodeModules, name, "node_modules");
    let directory = false;
    try {
      directory = lstatSync(nested).isDirectory();
    } catch {
      directory = false;
    }
    if (directory) keys.push(...installedKeys(nested, key));
  }
  return keys;
}

function installedVersion(directory: string): string | null {
  const manifest = readOptional(path.join(directory, "package.json"));
  if (!manifest) return null;
  try {
    const version = (JSON.parse(manifest.toString("utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export function inspectLockedRelease(
  releaseDir: string,
  host: ReleaseHost = currentHost(),
): LockedReleaseEvidence {
  const evidence: LockedReleaseEvidence = {
    publishedRuntime: false,
    lockMatchesPublished: false,
    manifestMatchesPublished: false,
    lockSha256: null,
    lockEntries: 0,
    installedAtLockedVersion: 0,
    mismatched: [],
    extraneous: [],
    host,
    missingRequired: [],
    missingForHost: [],
    otherPlatform: 0,
    notInstalled: [],
    direct: {},
  };
  const runtime = path.join(releasePackageRoot(releaseDir), RELEASE_RUNTIME_PATH);
  const publishedLock = readOptional(path.join(runtime, "bun.lock"));
  const publishedManifest = readOptional(path.join(runtime, "package.json"));
  evidence.publishedRuntime = publishedLock !== null && publishedManifest !== null;
  const lock = readOptional(path.join(releaseDir, "bun.lock"));
  const manifest = readOptional(path.join(releaseDir, "package.json"));
  evidence.lockMatchesPublished =
    lock !== null && publishedLock !== null && lock.equals(publishedLock);
  evidence.manifestMatchesPublished =
    manifest !== null && publishedManifest !== null && manifest.equals(publishedManifest);
  if (!lock) {
    evidence.error = "the release directory has no bun.lock";
    return evidence;
  }
  evidence.lockSha256 = createHash("sha256").update(lock).digest("hex");
  let parsed: {
    workspaces?: Record<string, { dependencies?: Record<string, string> }>;
    packages?: Record<string, unknown[]>;
  };
  try {
    parsed = Bun.JSONC.parse(lock.toString("utf8")) as typeof parsed;
  } catch (error) {
    evidence.error = `bun.lock does not parse: ${String(error)}`;
    return evidence;
  }
  const packages = parsed.packages ?? {};
  const rootDependencies = parsed.workspaces?.[""]?.dependencies ?? {};
  const { required, unresolved } = requiredClosure(packages, rootDependencies);
  evidence.missingRequired.push(...unresolved);
  const nodeModules = path.join(releaseDir, "node_modules");
  for (const [key, entry] of Object.entries(packages)) {
    evidence.lockEntries++;
    const spec = typeof entry[0] === "string" ? entry[0] : "";
    const at = spec.lastIndexOf("@");
    const version = at > 0 ? spec.slice(at + 1) : "";
    const segments = lockKeySegments(key);
    const directory = path.join(
      nodeModules,
      ...segments.flatMap((segment, index) =>
        index === 0 ? [segment] : ["node_modules", segment],
      ),
    );
    const installed = installedVersion(directory);
    if (installed === null) {
      const meta = entryMeta(entry);
      if (!admitsHost(meta, host)) evidence.otherPlatform++;
      else if (platformLimited(meta)) evidence.missingForHost.push(key);
      else if (required.has(key)) evidence.missingRequired.push(key);
      else evidence.notInstalled.push(key);
    } else if (installed === version) evidence.installedAtLockedVersion++;
    else evidence.mismatched.push({ name: key, locked: version, installed });
  }
  for (const key of installedKeys(nodeModules)) {
    if (packages[key] !== undefined || key === STANDALONE_PACKAGE) continue;
    evidence.extraneous.push(key);
  }
  for (const name of Object.keys(rootDependencies)) {
    const spec = packages[name]?.[0];
    if (typeof spec === "string") evidence.direct[name] = spec.slice(spec.lastIndexOf("@") + 1);
  }
  return evidence;
}

/** Script run in the release's package root: load sharp and encode an image. */
export const SHARP_PROBE = `
const sharp = require("sharp");
const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
const meta = await sharp(png).metadata();
console.log(JSON.stringify({ sharp: sharp.versions?.sharp, libvips: sharp.versions?.vips, format: meta.format }));
`;

/** Loads `sharp` the way the release resolves it, from its package root. */
export async function sharpLoads(
  bun: string,
  releaseDir: string,
  timeoutMs = 60_000,
): Promise<LoadEvidence> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([bun, "-e", SHARP_PROBE], {
      cwd: releasePackageRoot(releaseDir),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    // A release with no package root, or no bun, cannot load sharp.
    return { ok: false, error: `could not run ${bun}: ${String(error)}` };
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) return { ok: false, error: stderr.trim().slice(-600) || `exit ${code}` };
  try {
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as LoadEvidence;
    return { ...result, ok: result.format === "png" };
  } catch {
    return { ok: false, error: `unexpected output: ${stdout.slice(-300)}` };
  }
}

/**
 * Lockfile entries a fresh resolution of the release's own manifest would
 * give another version today (`bun install --lockfile-only` in `scratch`,
 * which must be an empty directory). An entry listed here whose installed
 * version is the locked one shows the lockfile, not the registry, decided it.
 */
export async function freshResolveDifferences(
  bun: string,
  releaseDir: string,
  scratch: string,
): Promise<{ name: string; locked: string; fresh: string }[] | { error: string }> {
  const read = (file: string): { packages: Record<string, unknown> } | { error: string } => {
    try {
      const parsed = Bun.JSONC.parse(readFileSync(file, "utf8")) as {
        packages?: Record<string, unknown>;
      } | null;
      return { packages: parsed?.packages ?? {} };
    } catch (error) {
      return { error: `${path.basename(path.dirname(file))}/bun.lock: ${String(error)}` };
    }
  };
  const lockedRead = read(path.join(releaseDir, "bun.lock"));
  if ("error" in lockedRead) return lockedRead;
  const locked = lockedRead.packages;
  try {
    mkdirSync(scratch, { recursive: true });
    copyFileSync(path.join(releaseDir, "package.json"), path.join(scratch, "package.json"));
  } catch (error) {
    return { error: `could not prepare the fresh resolution: ${String(error)}` };
  }
  const cache = path.join(scratch, ".cache");
  let child: Bun.Subprocess<"ignore", "ignore", "pipe">;
  try {
    child = Bun.spawn(
      [
        bun,
        "install",
        "--lockfile-only",
        "--ignore-scripts",
        "--no-progress",
        "--cache-dir",
        cache,
      ],
      {
        cwd: scratch,
        env: { ...process.env, BUN_INSTALL_CACHE_DIR: cache },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      },
    );
  } catch (error) {
    return { error: `could not run ${bun}: ${String(error)}` };
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60_000);
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  if (code !== 0) return { error: stderr.trim().slice(-600) || `exit ${code}` };
  const freshRead = read(path.join(scratch, "bun.lock"));
  if ("error" in freshRead) return freshRead;
  const fresh = freshRead.packages;
  const version = (entry: unknown) => {
    const spec = Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : "";
    return spec.slice(spec.lastIndexOf("@") + 1);
  };
  return Object.keys(locked)
    .filter((name) => fresh[name] !== undefined && version(fresh[name]) !== version(locked[name]))
    .map((name) => ({ name, locked: version(locked[name]), fresh: version(fresh[name]) }));
}
