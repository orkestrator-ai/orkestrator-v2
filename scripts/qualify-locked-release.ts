/**
 * Evidence that an installed standalone release came from its published
 * lockfile (to-do 5022 task 2), for `scripts/qualify-standalone-service.ts`.
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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
  /** Installed packages the lockfile does not list (the release package excepted). */
  extraneous: string[];
  /** Lockfile entries not installed that are limited to another os, cpu or libc. */
  otherPlatform: number;
  /** Lockfile entries not installed with no platform limit (optional dependencies). */
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

/** Top-level package names under a `node_modules` directory, scopes expanded. */
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

export function inspectLockedRelease(releaseDir: string): LockedReleaseEvidence {
  const evidence: LockedReleaseEvidence = {
    publishedRuntime: false,
    lockMatchesPublished: false,
    manifestMatchesPublished: false,
    lockSha256: null,
    lockEntries: 0,
    installedAtLockedVersion: 0,
    mismatched: [],
    extraneous: [],
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
  const nodeModules = path.join(releaseDir, "node_modules");
  const locked = new Set<string>();
  for (const [key, entry] of Object.entries(packages)) {
    evidence.lockEntries++;
    const spec = typeof entry[0] === "string" ? entry[0] : "";
    const at = spec.lastIndexOf("@");
    const version = at > 0 ? spec.slice(at + 1) : "";
    const segments = lockKeySegments(key);
    if (segments.length === 1) locked.add(segments[0]!);
    const directory = path.join(
      nodeModules,
      ...segments.flatMap((segment, index) =>
        index === 0 ? [segment] : ["node_modules", segment],
      ),
    );
    const installed = installedVersion(directory);
    if (installed === null) {
      const meta = (entry[2] ?? {}) as { os?: unknown; cpu?: unknown; libc?: unknown };
      if (meta.os !== undefined || meta.cpu !== undefined || meta.libc !== undefined)
        evidence.otherPlatform++;
      else evidence.notInstalled.push(key);
    } else if (installed === version) evidence.installedAtLockedVersion++;
    else evidence.mismatched.push({ name: key, locked: version, installed });
  }
  for (const name of installedNames(nodeModules)) {
    if (name !== STANDALONE_PACKAGE && !locked.has(name)) evidence.extraneous.push(name);
  }
  const dependencies = parsed.workspaces?.[""]?.dependencies ?? {};
  for (const name of Object.keys(dependencies)) {
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
export async function sharpLoads(bun: string, releaseDir: string): Promise<LoadEvidence> {
  const child = Bun.spawn([bun, "-e", SHARP_PROBE], {
    cwd: releasePackageRoot(releaseDir),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
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
  mkdirSync(scratch, { recursive: true });
  copyFileSync(path.join(releaseDir, "package.json"), path.join(scratch, "package.json"));
  const cache = path.join(scratch, ".cache");
  const child = Bun.spawn(
    [bun, "install", "--lockfile-only", "--ignore-scripts", "--no-progress", "--cache-dir", cache],
    {
      cwd: scratch,
      env: { ...process.env, BUN_INSTALL_CACHE_DIR: cache },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60_000);
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  if (code !== 0) return { error: stderr.trim().slice(-600) || `exit ${code}` };
  const version = (entry: unknown) => {
    const spec = Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : "";
    return spec.slice(spec.lastIndexOf("@") + 1);
  };
  const read = (file: string) =>
    ((Bun.JSONC.parse(readFileSync(file, "utf8")) as { packages?: Record<string, unknown> })
      .packages ?? {}) as Record<string, unknown>;
  const locked = read(path.join(releaseDir, "bun.lock"));
  const fresh = read(path.join(scratch, "bun.lock"));
  return Object.keys(locked)
    .filter((name) => fresh[name] !== undefined && version(fresh[name]) !== version(locked[name]))
    .map((name) => ({ name, locked: version(locked[name]), fresh: version(fresh[name]) }));
}
