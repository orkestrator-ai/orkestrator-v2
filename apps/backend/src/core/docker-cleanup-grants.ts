const TOKEN_TTL_MS = 10 * 60_000;
const MAX_TOKENS = 8;

/** The eligible set one cleanup preview bound to its selection token. */
export interface DockerCleanupGrant {
  owner: string;
  expiresAt: number;
  containers: Map<string, { sizeBytes: number | null; state: string }>;
  volumes: Set<string>;
  networks: Set<string>;
}

/**
 * The reviewed-cleanup selection tokens of one backend
 * (`docker-cleanup-preview.ts`): at most eight, each valid for ten minutes and
 * consumed by the execution that uses it. Owned by `BackendRuntime` as
 * `dockerCleanupGrants` and reached through `context.runtime` at call time.
 */
export class DockerCleanupGrants {
  private readonly grants = new Map<string, DockerCleanupGrant>();

  /** When a grant issued now expires. */
  expiryFrom(now: number): number {
    return now + TOKEN_TTL_MS;
  }

  /** Keeps a preview's grant, dropping expired ones and the oldest beyond the cap. */
  record(selectionToken: string, grant: DockerCleanupGrant, now: number): void {
    this.prune(now);
    this.grants.set(selectionToken, grant);
    while (this.grants.size > MAX_TOKENS) {
      const oldest = this.grants.keys().next().value;
      if (oldest === undefined) break;
      this.grants.delete(oldest);
    }
  }

  /**
   * Consumes an unexpired grant issued to `owner`. A token of another owner is
   * left in place and reported as absent.
   */
  take(selectionToken: string, owner: string, now: number): DockerCleanupGrant | undefined {
    this.prune(now);
    const grant = this.grants.get(selectionToken);
    if (!grant || grant.owner !== owner) return undefined;
    this.grants.delete(selectionToken);
    return grant;
  }

  private prune(now: number): void {
    for (const [token, grant] of Array.from(this.grants)) {
      if (grant.expiresAt <= now) this.grants.delete(token);
    }
  }
}
