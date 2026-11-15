import {
  copyFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  copyIntoContainer,
  isDockerCopyBusyError,
  isDockerCopyRefusedError,
} from "./docker-copy-refusal.js";
import { runCommand } from "./shell.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { classifyCommandFailure } from "@orkestrator/protocol/node/command-failure-reason";

const log = createLogger("docker");

/**
 * GitHub's published web/api/git IPv4 ranges, fetched by the backend at most
 * once an hour and handed to restricted-mode containers as a read-only seed.
 *
 * Without it every restricted boot (and restart) calls
 * `https://api.github.com/meta` itself; that endpoint allows 60 unauthenticated
 * requests an hour per address, and the fail-closed firewall then refuses to
 * boot. The seed only ever names GitHub's own published ranges, validated as
 * CIDRs, so a stale copy can at worst block a new GitHub address — never widen
 * access beyond GitHub.
 */

/**
 * The seed lives alone in its own directory under the data directory, and
 * restricted runtimes and egress gateways bind that directory read-only at
 * {@link GITHUB_RANGES_SEED_DIRECTORY} (to-do 7549 task 2). A directory bind
 * shows the container whatever file the directory holds at each boot, so a
 * seed the backend replaces by rename reaches every later restart, and no
 * `docker cp` into a container that is not running is needed.
 */
export const GITHUB_RANGES_SEED_DIRNAME = "github-ranges-seed";
/** The seed's file name, the same on the host and in the container. */
export const GITHUB_RANGES_SEED_FILENAME = "github-ranges";
/** Where backends before the directory bind kept the seed; moved on first use. */
export const LEGACY_GITHUB_RANGES_FILE = "github-ranges.txt";
const REFRESH_AFTER_MS = 60 * 60_000;
const USABLE_FOR_MS = 7 * 24 * 60 * 60_000;
/** After a failed fetch, starts and creates serve the old seed this long without asking again. */
export const GITHUB_RANGES_RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const MAX_RANGES = 4_096;
const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

export function githubRangesSeedDirectory(dataDir: string): string {
  return path.join(dataDir, GITHUB_RANGES_SEED_DIRNAME);
}

export function githubRangesSeedFile(dataDir: string): string {
  return path.join(githubRangesSeedDirectory(dataDir), GITHUB_RANGES_SEED_FILENAME);
}

export function validIpv4Cidr(value: string): boolean {
  const match = CIDR.exec(value);
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  return octets.every((octet) => octet <= 255) && Number(match[5]) <= 32;
}

/** Extracts the IPv4 web/api/git ranges from a `/meta` answer, or null. */
export function parseGithubMeta(text: string): string[] | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const ranges: string[] = [];
  for (const key of ["web", "api", "git"]) {
    const list = value[key];
    if (!Array.isArray(list)) return null;
    for (const entry of list) {
      if (typeof entry === "string" && validIpv4Cidr(entry)) ranges.push(entry);
    }
  }
  const unique = [...new Set(ranges)].slice(0, MAX_RANGES);
  return unique.length > 0 ? unique : null;
}

/** A seed file's contents: a dated header line, then one range per line. */
export function formatGithubRangesSeed(ranges: readonly string[], fetchedAt: number): string {
  return `# github-ranges ${new Date(fetchedAt).toISOString()}\n${ranges.join("\n")}\n`;
}

type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/**
 * Creates the seed directory (world-readable: the container's root reads it,
 * which a rootless daemon maps to the backend's user and a rootful one to
 * host root) and moves a seed an older backend kept at the data directory's
 * top level into it. Returns the directory, or null when it cannot be made,
 * in which case containers are created without the bind and fetch the ranges
 * themselves.
 */
export async function ensureGithubRangesSeedDirectory(dataDir: string): Promise<string | null> {
  const directory = githubRangesSeedDirectory(dataDir);
  try {
    await mkdir(directory, { recursive: true, mode: 0o755 });
    await chmod(directory, 0o755);
  } catch {
    return null;
  }
  const file = githubRangesSeedFile(dataDir);
  const present = await stat(file).then(
    () => true,
    () => false,
  );
  if (!present) {
    // A rename keeps the old seed's mtime, so its age still decides whether
    // it is refreshed.
    await rename(path.join(dataDir, LEGACY_GITHUB_RANGES_FILE), file).catch(() => undefined);
  }
  return directory;
}

// One fetch per seed file at a time, and none for a while after one failed:
// several creates and starts at once share one request to GitHub's
// anonymous, per-address allowance instead of each spending one.
const inFlight = new Map<string, Promise<string | null>>();
const lastFailedFetch = new Map<string, number>();

/**
 * Returns the seed file's path when a usable seed exists (refreshing it when
 * older than an hour), or null. Never throws: without a seed the container
 * falls back to fetching the ranges itself.
 */
export function githubRangesSeed(
  dataDir: string,
  options: { now?: () => number; fetcher?: Fetcher } = {},
): Promise<string | null> {
  const file = githubRangesSeedFile(dataDir);
  const pending = inFlight.get(file);
  if (pending) return pending;
  const work = refreshGithubRangesSeed(dataDir, file, options).finally(() => {
    inFlight.delete(file);
  });
  inFlight.set(file, work);
  return work;
}

async function refreshGithubRangesSeed(
  dataDir: string,
  file: string,
  options: { now?: () => number; fetcher?: Fetcher },
): Promise<string | null> {
  const now = options.now ?? Date.now;
  if (!(await ensureGithubRangesSeedDirectory(dataDir))) return null;
  const age = await stat(file).then(
    (info) => now() - info.mtimeMs,
    () => Number.POSITIVE_INFINITY,
  );
  if (age < REFRESH_AFTER_MS) return file;
  // Keep serving the previous seed while it is still reasonably fresh.
  const fallback = age < USABLE_FOR_MS ? file : null;
  const failedAt = lastFailedFetch.get(file);
  if (failedAt !== undefined) {
    const since = now() - failedAt;
    if (since >= 0 && since < GITHUB_RANGES_RETRY_AFTER_FAILURE_MS) return fallback;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let text: string;
    try {
      const response = await (options.fetcher ?? fetch)("https://api.github.com/meta", {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      text = await response.text();
    } finally {
      clearTimeout(timer);
    }
    const ranges = parseGithubMeta(text.slice(0, 1024 * 1024));
    if (!ranges) throw new Error("malformed");
    // Written beside the bound directory, not in it, so a container never
    // sees a partial file; the rename into it is atomic on one filesystem.
    const temporary = path.join(dataDir, `.${GITHUB_RANGES_SEED_FILENAME}.${process.pid}.tmp`);
    await writeFile(temporary, formatGithubRangesSeed(ranges, now()), { mode: 0o644 });
    await chmod(temporary, 0o644);
    await rename(temporary, file);
    lastFailedFetch.delete(file);
    return file;
  } catch {
    lastFailedFetch.set(file, now());
    return fallback;
  }
}

/**
 * Docker arguments binding the seed directory read-only where the firewall
 * reads it. `--mount` fails on a missing source rather than creating one.
 */
export function githubRangesSeedMountArguments(directory: string): string[] {
  return ["--mount", `type=bind,src=${directory},dst=${GITHUB_RANGES_SEED_DIRECTORY},readonly`];
}

/**
 * Prepares a new restricted runtime's or gateway's seed: refreshes it (at
 * most hourly) and returns the directory to bind, or null when the directory
 * cannot be made. The directory is bound even when no seed could be fetched,
 * so a later start that refreshes it reaches the container.
 */
export async function prepareGithubRangesSeedBind(
  dataDir: string,
  options: { now?: () => number; fetcher?: Fetcher } = {},
): Promise<string | null> {
  await githubRangesSeed(dataDir, options);
  return ensureGithubRangesSeedDirectory(dataDir);
}

/** The directory the firewall reads the seed from (`docker/firewall-domains.sh`). */
export const GITHUB_RANGES_SEED_DIRECTORY = "/etc/orkestrator-seed";

/**
 * Copies the seed into a container that does not bind the seed directory:
 * one created before the bind (to-do 7549 task 2), until it is rebuilt.
 * Best effort: a container without a seed fetches the ranges itself. The
 * copy goes through the daemon's archive path, which a rootless daemon may
 * refuse (a read-only bind on a `nosuid`/`nodev` filesystem, or a busy
 * snapshot of a container that is not running); new containers avoid it.
 */
export async function copyGithubRangesSeed(
  containerId: string,
  seedFile: string,
  run: typeof runCommand = runCommand,
  sleep?: (ms: number) => Promise<void>,
): Promise<boolean> {
  const staging = await mkdtemp(path.join(os.tmpdir(), "orkestrator-github-seed-"));
  try {
    await chmod(staging, 0o755);
    const staged = path.join(staging, "github-ranges");
    await copyFile(seedFile, staged);
    await chmod(staged, 0o644);
    await copyIntoContainer(
      containerId,
      ["cp", `${staging}${path.sep}.`, `${containerId}:${GITHUB_RANGES_SEED_DIRECTORY}`],
      { timeoutMs: 30_000 },
      "the GitHub ranges seed",
      { run, sleep },
    );
    return true;
  } catch (error) {
    // A refused copy (a read-only bind on a nosuid/nodev filesystem under
    // rootless Docker) or one the daemon kept refusing as busy is named, not
    // left unclassified: every boot of such a container then fetches GitHub's
    // ranges itself.
    const refusal = isDockerCopyRefusedError(error)
      ? "read-only-bind-remount"
      : isDockerCopyBusyError(error)
        ? "snapshot-busy"
        : null;
    log.warn("github-ranges.seed-not-copied", {
      containerId: containerId.slice(0, 12),
      ...classifyCommandFailure(error, { tools: ["docker"] }),
      ...(refusal ? { refusal } : {}),
      error: formatLogError(error),
    });
    return false;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Reads a seed back (for tests and diagnostics): its time and ranges. */
export async function readGithubRangesSeed(
  file: string,
): Promise<{ fetchedAt: string; ranges: string[] } | null> {
  const text = await readFile(file, "utf8").catch(() => "");
  const [header = "", ...lines] = text.trim().split("\n");
  const match = /^# github-ranges (\S+)$/.exec(header);
  if (!match) return null;
  return { fetchedAt: match[1]!, ranges: lines.filter(validIpv4Cidr) };
}
