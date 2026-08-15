import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { AGENT_INTERACTION_LIMITS } from "@orkestrator/protocol/agent-interactions";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import {
  asRecord,
  assertSdkResponse,
  MAX_TRACKED_PROVIDER_INTERACTIONS,
  nonEmptyString,
  serializedByteLength,
  setBoundedMapEntry,
} from "./agent-provider-runtime.js";
import {
  boundedOpenCodeExistenceSnapshot,
  boundedOpenCodeStatusSnapshot,
  MAX_OPENCODE_EXISTENCE_SNAPSHOT_BYTES,
  MAX_OPENCODE_EXISTENCE_SNAPSHOT_SESSIONS,
  type OpenCodeExistenceProbe,
  type OpenCodeExistenceSnapshot,
  type OpenCodeSessionLifecycleState,
} from "./opencode-snapshots.js";

const OPENCODE_EXISTENCE_PROBE_CONCURRENCY = 8;

export class OpenCodeSessionLifecycle {
  readonly ownedSessions = new Set<string>();
  private readonly sessionExistenceCache = new Map<string, number>();
  private readonly sessionExistenceRetryAt = new Map<string, number>();
  private sessionListCache: {
    snapshot: OpenCodeExistenceSnapshot;
    expiresAt: number;
  } | null = null;
  private sessionListFailure: { error: unknown; expiresAt: number } | null = null;
  private sessionListRead: Promise<OpenCodeExistenceSnapshot> | null = null;
  private existenceProbeCursor = 0;

  constructor(
    private readonly client: OpencodeClient,
    private readonly directory: string | undefined,
    private readonly now: () => number,
    private readonly existenceCacheTtlMs: number,
    private readonly requestOptions: () => { signal: AbortSignal },
  ) {}

  own(sessionId: string): void {
    this.ownedSessions.add(sessionId);
  }

  /**
   * Combine OpenCode's incremental activity map with bounded, authoritative
   * existence reads for entries the activity map omits.
   *
   * A short-lived session-list snapshot is the cheap common path. OpenCode's
   * `start` query is a timestamp lower bound, not an offset, so a full page
   * cannot be paginated. Targets unresolved by that page are probed directly
   * with session.get instead; only a direct 404 may manufacture `missing`.
   */
  async readSessionLifecycle(
    sessionIds: readonly string[],
    tolerateExistenceFailure = false,
    strongExistenceRead = false,
  ): Promise<Map<string, OpenCodeSessionLifecycleState>> {
    const uniqueSessionIds = [...new Set(sessionIds)];
    for (const sessionId of uniqueSessionIds) {
      if (
        sessionId.length === 0
        || sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
      ) {
        throw new ProviderUnavailableError(
          "OpenCode lifecycle read contains a malformed identity",
        );
      }
    }
    const lifecycle = new Map<string, OpenCodeSessionLifecycleState>();
    if (uniqueSessionIds.length === 0) return lifecycle;

    const statusResponse = await this.client.session.status(
      { directory: this.directory },
      this.requestOptions(),
    );
    assertSdkResponse(statusResponse, "OpenCode status read");
    const statusSnapshot = boundedOpenCodeStatusSnapshot(
      statusResponse.data,
      new Set(uniqueSessionIds),
    );
    const omittedSessionIds: string[] = [];
    for (const sessionId of uniqueSessionIds) {
      const status = statusSnapshot[sessionId];
      if (!status) {
        omittedSessionIds.push(sessionId);
      } else if (status.type === "busy" || status.type === "retry") {
        lifecycle.set(sessionId, "running");
      } else if (status.type === "idle") {
        lifecycle.set(sessionId, "idle");
      } else {
        lifecycle.set(sessionId, "unknown");
      }
    }
    if (omittedSessionIds.length === 0) return lifecycle;

    const existence = await this.resolveSessionExistence(
      omittedSessionIds,
      strongExistenceRead,
    );
    for (const sessionId of omittedSessionIds) {
      const probe = existence.get(sessionId);
      if (probe?.state === "exists") {
        lifecycle.set(sessionId, "idle");
      } else if (probe?.state === "missing") {
        lifecycle.set(sessionId, "missing");
      } else if (tolerateExistenceFailure) {
        // An omitted status-map entry is not running. When existence cannot be
        // confirmed, retaining the durable mapping as idle is safer than
        // dropping it or withholding already-resolved busy sessions.
        lifecycle.set(sessionId, "unknown");
      } else {
        throw new ProviderUnavailableError(
          `OpenCode session existence is unavailable for ${sessionId}`,
          { cause: probe?.error },
        );
      }
    }
    return lifecycle;
  }

  private async resolveSessionExistence(
    sessionIds: readonly string[],
    strong: boolean,
  ): Promise<Map<string, OpenCodeExistenceProbe>> {
    const result = new Map<string, OpenCodeExistenceProbe>();
    const unresolved: string[] = [];
    const now = this.now();
    for (const sessionId of sessionIds) {
      if (strong) {
        unresolved.push(sessionId);
        continue;
      }
      const cached = this.sessionExistenceCache.get(sessionId);
      if (cached !== undefined && cached > now) {
        result.set(sessionId, { state: "exists" });
      } else if ((this.sessionExistenceRetryAt.get(sessionId) ?? 0) > now) {
        result.set(sessionId, { state: "unknown" });
      } else {
        if (cached !== undefined) this.sessionExistenceCache.delete(sessionId);
        this.sessionExistenceRetryAt.delete(sessionId);
        unresolved.push(sessionId);
      }
    }
    if (unresolved.length === 0) return result;

    let directlyProbed = unresolved;
    if (!strong) {
      try {
        const snapshot = await this.readCachedSessionList();
        directlyProbed = [];
        for (const sessionId of unresolved) {
          if (snapshot.sessionIds.has(sessionId)) {
            this.rememberExistingSession(sessionId);
            result.set(sessionId, { state: "exists" });
          } else {
            directlyProbed.push(sessionId);
          }
        }
      } catch {
        // A directory-wide optimization failing says nothing about any one
        // target. Exact reads below remain authoritative and isolated.
      }
    }

    const probeCount = strong
      ? directlyProbed.length
      : Math.min(OPENCODE_EXISTENCE_PROBE_CONCURRENCY, directlyProbed.length);
    const probeStart = directlyProbed.length === 0
      ? 0
      : this.existenceProbeCursor % directlyProbed.length;
    const scheduledProbes = Array.from(
      { length: probeCount },
      (_, index) => directlyProbed[(probeStart + index) % directlyProbed.length]!,
    );
    if (!strong && directlyProbed.length > 0) {
      this.existenceProbeCursor = (probeStart + probeCount) % directlyProbed.length;
      const scheduled = new Set(scheduledProbes);
      for (const sessionId of directlyProbed) {
        if (!scheduled.has(sessionId)) result.set(sessionId, { state: "unknown" });
      }
    }

    let nextSession = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const sessionId = scheduledProbes[nextSession++];
        if (!sessionId) return;
        const probe = await this.probeSessionExistence(sessionId);
        if (!strong && probe.state === "unknown") {
          setBoundedMapEntry(
            this.sessionExistenceRetryAt,
            sessionId,
            this.now() + this.existenceCacheTtlMs,
            MAX_TRACKED_PROVIDER_INTERACTIONS,
          );
        }
        result.set(sessionId, probe);
      }
    };
    await Promise.all(Array.from(
      {
        length: Math.min(
          OPENCODE_EXISTENCE_PROBE_CONCURRENCY,
          scheduledProbes.length,
        ),
      },
      () => worker(),
    ));
    return result;
  }

  private async readCachedSessionList(): Promise<OpenCodeExistenceSnapshot> {
    const now = this.now();
    if (this.sessionListCache && this.sessionListCache.expiresAt > now) {
      return this.sessionListCache.snapshot;
    }
    if (this.sessionListFailure && this.sessionListFailure.expiresAt > now) {
      throw this.sessionListFailure.error;
    }
    if (this.sessionListRead) return this.sessionListRead;

    const read = (async () => {
      try {
        const response = await this.client.session.list(
          {
            directory: this.directory,
            limit: MAX_OPENCODE_EXISTENCE_SNAPSHOT_SESSIONS,
          },
          this.requestOptions(),
        );
        assertSdkResponse(response, "OpenCode session list");
        const snapshot = boundedOpenCodeExistenceSnapshot(response.data);
        this.sessionListCache = {
          snapshot,
          expiresAt: this.now() + this.existenceCacheTtlMs,
        };
        this.sessionListFailure = null;
        return snapshot;
      } catch (error) {
        this.sessionListFailure = {
          error,
          expiresAt: this.now() + this.existenceCacheTtlMs,
        };
        throw error;
      }
    })().finally(() => {
      if (this.sessionListRead === read) this.sessionListRead = null;
    });
    this.sessionListRead = read;
    return read;
  }

  private async probeSessionExistence(
    sessionId: string,
  ): Promise<OpenCodeExistenceProbe> {
    try {
      const response = await this.client.session.get(
        { sessionID: sessionId, directory: this.directory },
        this.requestOptions(),
      );
      if (response.error) {
        if (response.response?.status === 404) {
          this.sessionExistenceCache.delete(sessionId);
          this.sessionExistenceRetryAt.delete(sessionId);
          this.sessionListCache?.snapshot.sessionIds.delete(sessionId);
          return { state: "missing" };
        }
        assertSdkResponse(response, "OpenCode session existence read");
      }
      const session = asRecord(response.data);
      if (
        nonEmptyString(session?.id) !== sessionId
        || (
          this.directory !== undefined
          && nonEmptyString(session?.directory) !== this.directory
        )
        || serializedByteLength(response.data) > MAX_OPENCODE_EXISTENCE_SNAPSHOT_BYTES
      ) {
        throw new ProviderUnavailableError(
          "OpenCode session existence read is malformed or oversized",
        );
      }
      this.rememberExistingSession(sessionId);
      return { state: "exists" };
    } catch (error) {
      return { state: "unknown", error };
    }
  }

  rememberExistingSession(sessionId: string): void {
    setBoundedMapEntry(
      this.sessionExistenceCache,
      sessionId,
      this.now() + this.existenceCacheTtlMs,
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    this.sessionExistenceRetryAt.delete(sessionId);
  }


  clear(): void {
    this.ownedSessions.clear();
    this.sessionExistenceCache.clear();
    this.sessionExistenceRetryAt.clear();
    this.sessionListCache = null;
    this.sessionListFailure = null;
  }
}
