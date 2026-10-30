/**
 * Whether the credential an environment merges with may merge into a
 * repository, for the "ready to merge" shimmer.
 *
 * The PR monitor's `gh pr view/list --json` lookup has no viewer permission
 * field, and asking on every 20 s poll would add a repository query per
 * environment. The answer changes rarely, so it is cached per credential scope
 * and repository for an hour and filled through the environment's own `gh`
 * runner: the runner Merge uses. A merge that fails with a permission error
 * clears its entry, so the next check asks again.
 *
 * "May merge" means push, maintain or admin in REST `permissions`, the rule
 * the pull-request viewer already uses (`loadViewerIdentity`). It does not
 * prove a ruleset lets this user merge; GitHub's `mergeStateStatus` covers
 * required reviews and checks.
 */

import type { PrMonitorTarget } from "./pr-monitor.js";

/** How long a known answer is trusted. A revoked permission shimmers this long. */
export const PR_VIEWER_PERMISSION_TTL_MS = 60 * 60_000;
/** A failed lookup is unknown (never blocks); ask again after this long. */
export const PR_VIEWER_PERMISSION_RETRY_MS = 10 * 60_000;
export const PR_VIEWER_PERMISSION_TIMEOUT_MS = 10_000;

export interface PrViewerRepository {
  host: string;
  owner: string;
  repo: string;
}

/**
 * The repository of a github.com PR URL, or null. Other hosts are not looked
 * up: Merge itself only accepts github.com URLs (`parseGitHubPullRequestUrl`).
 */
export function prViewerRepository(prUrl: string | null | undefined): PrViewerRepository | null {
  if (!prUrl) return null;
  let url: URL;
  try {
    url = new URL(prUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
  const [owner, repo, pull] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo || pull !== "pull") return null;
  const segment = /^[A-Za-z0-9_.-]+$/;
  if (!segment.test(owner) || !segment.test(repo)) return null;
  return { host: url.hostname, owner, repo };
}

/**
 * Names the credential a target's `gh` calls use, or null when unknown. Local
 * environments share the host's single `gh` login per GitHub host; each
 * container sources its own runtime credential, so a container is its own
 * scope (a restart gets a new container id and asks again).
 */
export function prViewerPermissionScope(target: PrMonitorTarget): string | null {
  if (target.kind === "local") return "local-gh";
  return target.containerId ? `container:${target.containerId}` : null;
}

/** `gh api` arguments that print the repository's `permissions` object. */
export function prViewerPermissionArgs(repository: PrViewerRepository): string[] {
  return [
    "api",
    "--hostname",
    repository.host,
    `repos/${repository.owner}/${repository.repo}`,
    "--jq",
    ".permissions",
  ];
}

/**
 * Parses `--jq .permissions` output. Throws when GitHub did not report
 * permissions (for example an unauthenticated read), so the caller records
 * "unknown" rather than "may not merge".
 */
export function parsePrViewerPermission(stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Failed to parse repository permissions");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("GitHub did not report repository permissions");
  }
  const permissions = parsed as Record<string, unknown>;
  return permissions.admin === true || permissions.maintain === true || permissions.push === true;
}

/**
 * A merge error that suggests the credential may not merge. Broad on purpose:
 * a false match only clears one cache entry, which the next check refills.
 */
export function isMergePermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 403|does not have the correct permissions|not accessible by|must have (?:write|push|admin|maintain)|permission to merge/i.test(
    message,
  );
}

interface CachedPermission {
  canMerge: boolean | null;
  expiresAt: number;
}

export class PrViewerPermissionCache {
  private readonly entries = new Map<string, CachedPermission>();
  private readonly inFlight = new Map<string, Promise<boolean | null>>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The cached answer, or one lookup through `fetch` when there is none or it
   * expired. Concurrent callers for one key share the lookup. A failed lookup
   * resolves to null (unknown) and is retried after
   * {@link PR_VIEWER_PERMISSION_RETRY_MS}.
   */
  async resolve(
    scope: string,
    repository: PrViewerRepository,
    fetch: () => Promise<boolean>,
  ): Promise<boolean | null> {
    const key = cacheKey(scope, repository);
    const now = this.now();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) return cached.canMerge;
    const running = this.inFlight.get(key);
    if (running) return running;
    this.prune(now);
    // Stored only while still the current lookup: one that `invalidate`
    // superseded may have read the permission before it changed.
    const lookup: Promise<boolean | null> = Promise.resolve()
      .then(fetch)
      .then(
        (canMerge) => {
          if (this.inFlight.get(key) === lookup) {
            this.store(key, canMerge, PR_VIEWER_PERMISSION_TTL_MS);
          }
          return canMerge;
        },
        () => {
          if (this.inFlight.get(key) === lookup) {
            this.store(key, null, PR_VIEWER_PERMISSION_RETRY_MS);
          }
          return null;
        },
      );
    this.inFlight.set(key, lookup);
    try {
      return await lookup;
    } finally {
      if (this.inFlight.get(key) === lookup) this.inFlight.delete(key);
    }
  }

  /** Forgets one answer, e.g. after a merge failed with a permission error. */
  invalidate(scope: string, repository: PrViewerRepository): void {
    const key = cacheKey(scope, repository);
    this.entries.delete(key);
    // A lookup already running may have started before the permission change.
    this.inFlight.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  /** Number of cached answers (tests and diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  private store(key: string, canMerge: boolean | null, ttlMs: number): void {
    this.entries.set(key, { canMerge, expiresAt: this.now() + ttlMs });
  }

  /** Containers come and go; their expired scopes are dropped on the next miss. */
  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

function cacheKey(scope: string, repository: PrViewerRepository): string {
  return [scope, repository.host, repository.owner, repository.repo].join("\0").toLowerCase();
}
