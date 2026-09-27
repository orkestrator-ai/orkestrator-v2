import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

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

export const GITHUB_RANGES_FILE = "github-ranges.txt";
const REFRESH_AFTER_MS = 60 * 60_000;
const USABLE_FOR_MS = 7 * 24 * 60 * 60_000;
const MAX_RANGES = 4_096;
const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

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

type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/**
 * Returns the seed file's path when a usable seed exists (refreshing it when
 * older than an hour), or null. Never throws: without a seed the container
 * falls back to fetching the ranges itself.
 */
export async function githubRangesSeed(
  dataDir: string,
  options: { now?: () => number; fetcher?: Fetcher } = {},
): Promise<string | null> {
  const now = options.now ?? Date.now;
  const file = path.join(dataDir, GITHUB_RANGES_FILE);
  const age = await stat(file).then(
    (info) => now() - info.mtimeMs,
    () => Number.POSITIVE_INFINITY,
  );
  if (age < REFRESH_AFTER_MS) return file;
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
    await mkdir(dataDir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `# github-ranges ${new Date(now()).toISOString()}\n${ranges.join("\n")}\n`,
      { mode: 0o644 },
    );
    await rename(temporary, file);
    return file;
  } catch {
    // Keep serving the previous seed while it is still reasonably fresh.
    return age < USABLE_FOR_MS ? file : null;
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
