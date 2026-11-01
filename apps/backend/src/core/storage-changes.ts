import { RESOURCE_MANIFEST_KINDS, createHash, fs } from "./storage-shared.js";
import type {
  ConditionalResourceSnapshot,
  ResourceChange,
  ResourceChangeListener,
  ResourceKind,
  ResourceManifestKind,
  ResourceRevisionManifest,
  ResourceRevisionMap,
  ResourceSnapshotRevision,
  ScopedResourceRevisionManifest,
} from "./storage-shared.js";
import type { StorageContext } from "./storage-context.js";
import type { EnvironmentAttentionEvent } from "@orkestrator/protocol/environment-attention";

/** The store (or, for `config`, the file) each manifest resource is revised by. */
export const RESOURCE_MANIFEST_FILES: Readonly<Record<ResourceManifestKind, string>> = {
  project: "projects.json",
  environment: "environments.json",
  session: "sessions.json",
  config: "config.json",
  kanban: "kanban.json",
  "project-notes": "project-notes.json",
  "feature-plan": "feature-plans.json",
  "pane-layout": "pane-layouts.json",
  "multi-review": "multi-reviews.json",
  "build-pipeline": "build-pipelines.json",
  "prompt-queue": "prompt-queues.json",
  "agent-mail-summary": "agent-mail.json",
};

type JournalEntry = {
  change: ResourceChange;
  snapshotRevision?: Promise<ResourceSnapshotRevision | undefined>;
};

/**
 * Resource change announcements and the revision manifests clients
 * reconcile against: the gateway's broadcast sink, backend observers, the
 * bounded journal of recent changes the scoped manifest replays, and the
 * per-resource snapshot revisions. Part of {@link StorageContext}.
 */
export class StorageChanges {
  /** The gateway's broadcast sink. */
  private listener: ResourceChangeListener | null = null;
  private readonly observers = new Set<ResourceChangeListener>();
  private readonly attentionListeners = new Set<(event: EnvironmentAttentionEvent) => void>();
  /** Revision of the latest announced change; the scoped manifest's cursor. */
  private revision = 0;
  private readonly journal: JournalEntry[] = [];
  private journalBytes = 0;

  constructor(private readonly context: StorageContext) {}

  /**
   * Installs the sink that broadcasts persistent mutations to connected
   * clients. Kept as a setter rather than a constructor argument because the
   * gateway that ultimately delivers these does not exist yet when the backend
   * builds its storage service.
   */
  setResourceChangeListener(listener: ResourceChangeListener | null): void {
    this.listener = listener;
  }

  /** Subscribe backend services without replacing the gateway's broadcast sink. */
  addResourceChangeListener(listener: ResourceChangeListener): () => void {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }

  /** Observe environments the backend has just marked as needing attention. */
  addEnvironmentAttentionListener(
    listener: (event: EnvironmentAttentionEvent) => void,
  ): () => void {
    this.attentionListeners.add(listener);
    return () => this.attentionListeners.delete(listener);
  }

  /**
   * Publishes one attention edge after its write committed (see
   * `@orkestrator/protocol/environment-attention`). Like `announce`, a
   * listener that throws never fails the committed mutation.
   */
  notifyEnvironmentAttention(event: EnvironmentAttentionEvent): void {
    if (this.context.deferUntilCommit(() => this.notifyEnvironmentAttention(event))) return;
    for (const listener of this.attentionListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[Storage] Environment attention listener threw:", error);
      }
    }
  }

  /**
   * Announces a committed mutation. Called only after the write has landed, so
   * a client that refetches in response is guaranteed to observe the new value
   * rather than race the write it was told about.
   */
  announce(
    resource: ResourceKind,
    id: string,
    projectId?: string,
    scope_?: { agent: string; logicalSessionKey: string },
    deleted = false,
  ): void {
    // Announce-after-commit: an open atomic scope commits first, then replays these.
    if (
      this.context.deferUntilCommit(() => this.announce(resource, id, projectId, scope_, deleted))
    ) {
      return;
    }
    this.revision += 1;
    const change: ResourceChange = {
      resource,
      id,
      revision: this.revision,
      ...(projectId ? { projectId } : {}),
      ...(scope_ ? scope_ : {}),
      ...(deleted ? { deleted: true } : {}),
    };
    const journalEntry = {
      change,
      ...(RESOURCE_MANIFEST_KINDS.includes(resource as ResourceManifestKind)
        ? {
            snapshotRevision: this.getResourceSnapshotRevision(
              resource as ResourceManifestKind,
            ).catch(() => undefined),
          }
        : {}),
    };
    this.journal.push(journalEntry);
    this.journalBytes += Buffer.byteLength(JSON.stringify(change));
    while (this.journal.length > 4_096 || this.journalBytes > 2 * 1024 * 1024) {
      const removed = this.journal.shift();
      if (!removed) break;
      this.journalBytes -= Buffer.byteLength(JSON.stringify(removed.change));
    }
    const listener = this.listener;
    for (const subscriber of [listener, ...this.observers]) {
      if (!subscriber) continue;
      try {
        subscriber(change);
      } catch (error) {
        // A broken client transport/service observer must never fail a committed mutation.
        console.error("[Storage] Resource change listener threw:", error);
      }
    }
  }

  /**
   * Returns an opaque, content-free revision for one authoritative store.
   *
   * A database store's committed revision moves on every write by any backend
   * sharing the data directory; the database identity keeps two databases'
   * revisions apart. The configuration stays a file, fingerprinted by inode,
   * size and timestamps (the writer renames a fresh inode into place), which
   * also detects the desktop process's writes without reading user content.
   */
  async getResourceSnapshotRevision(
    resource: ResourceManifestKind,
  ): Promise<ResourceSnapshotRevision> {
    const filePath = this.context.file(RESOURCE_MANIFEST_FILES[resource]);
    const store = this.context.storeForFile(filePath);
    let fingerprint: string;
    if (store !== null) {
      const revision = this.context.database.storeRevision(store);
      fingerprint =
        revision === null
          ? `${resource}:missing`
          : [resource, this.context.database.instanceId, revision].join(":");
    } else {
      try {
        const stat = await fs.stat(filePath, { bigint: true });
        fingerprint = [resource, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        fingerprint = `${resource}:missing`;
      }
    }
    return createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
  }

  getResourceGeneration(): string {
    return this.context.resourceGeneration;
  }

  async getResourceRevisionManifest(
    knownGeneration?: string,
    knownRevisions: Partial<ResourceRevisionMap> = {},
  ): Promise<ResourceRevisionManifest> {
    const entries = await Promise.all(
      RESOURCE_MANIFEST_KINDS.map(
        async (resource) => [resource, await this.getResourceSnapshotRevision(resource)] as const,
      ),
    );
    const current = Object.fromEntries(entries) as ResourceRevisionMap;
    const reset = knownGeneration !== this.context.resourceGeneration;
    const revisions: Partial<ResourceRevisionMap> = {};
    for (const resource of RESOURCE_MANIFEST_KINDS) {
      if (reset || knownRevisions[resource] !== current[resource]) {
        revisions[resource] = current[resource];
      }
    }
    return { generation: this.context.resourceGeneration, reset, revisions };
  }

  async getScopedResourceRevisionManifest(
    knownGeneration: string | undefined,
    cursor: number,
    knownRevisions: Partial<ResourceRevisionMap> = {},
    requestedHighWater?: number,
  ): Promise<ScopedResourceRevisionManifest> {
    const highWater = Math.min(requestedHighWater ?? this.revision, this.revision);
    if (knownGeneration !== this.context.resourceGeneration) {
      const broad = await this.getResourceRevisionManifest(undefined, knownRevisions);
      return {
        generation: this.context.resourceGeneration,
        cursor: highWater,
        highWater,
        reset: true,
        resetResources: [...RESOURCE_MANIFEST_KINDS],
        changes: [],
        revisions: broad.revisions,
        hasMore: false,
      };
    }
    const oldest = this.journal[0]?.change.revision ?? highWater + 1;
    if (cursor < oldest - 1 || cursor > highWater) {
      const broad = await this.getResourceRevisionManifest(undefined, knownRevisions);
      return {
        generation: this.context.resourceGeneration,
        cursor: highWater,
        highWater,
        reset: true,
        resetResources: [...RESOURCE_MANIFEST_KINDS],
        changes: [],
        revisions: broad.revisions,
        hasMore: false,
      };
    }
    const pending: JournalEntry[] = [];
    let pageBytes = 0;
    for (const entry of this.journal) {
      if (entry.change.revision <= cursor || entry.change.revision > highWater) continue;
      const entryBytes = Buffer.byteLength(JSON.stringify(entry.change));
      if (pending.length >= 256 || (pending.length > 0 && pageBytes + entryBytes > 64 * 1024)) {
        break;
      }
      pending.push(entry);
      pageBytes += entryBytes;
    }
    const lastCursor = pending.at(-1)?.change.revision ?? cursor;
    const hasMore = lastCursor < highWater;
    if (hasMore) {
      const latestByResource = new Map<ResourceManifestKind, (typeof pending)[number]>();
      for (const entry of pending) {
        if (RESOURCE_MANIFEST_KINDS.includes(entry.change.resource as ResourceManifestKind)) {
          latestByResource.set(entry.change.resource as ResourceManifestKind, entry);
        }
      }
      const revisions: Partial<ResourceRevisionMap> = {};
      await Promise.all(
        Array.from(latestByResource.entries()).map(async ([resource, entry]) => {
          const revision = await entry.snapshotRevision?.catch(() => undefined);
          if (revision) revisions[resource] = revision;
        }),
      );
      return {
        generation: this.context.resourceGeneration,
        cursor: lastCursor,
        highWater,
        reset: false,
        resetResources: [],
        changes: pending.map((entry) => entry.change),
        revisions,
        hasMore: true,
      };
    }
    const current = await this.getResourceRevisionManifest(
      this.context.resourceGeneration,
      knownRevisions,
    );
    const resetResources: ResourceManifestKind[] = [];
    for (const resource of Object.keys(current.revisions) as ResourceManifestKind[]) {
      // These two collections establish the owner hierarchy for every scoped
      // read. Refresh them authoritatively before replaying dependent records.
      if (resource === "project" || resource === "environment") {
        resetResources.push(resource);
        continue;
      }
      const latestAccounted = Array.from(pending)
        .reverse()
        .find((entry) => entry.change.resource === resource);
      const accountedRevision = latestAccounted?.snapshotRevision
        ? await latestAccounted.snapshotRevision.catch(() => undefined)
        : undefined;
      if (!accountedRevision || accountedRevision !== current.revisions[resource]) {
        resetResources.push(resource);
      }
    }
    return {
      generation: this.context.resourceGeneration,
      cursor: lastCursor,
      highWater,
      reset: false,
      resetResources,
      changes: pending.map((entry) => entry.change),
      revisions: current.revisions,
      hasMore: false,
    };
  }

  /**
   * Revision-aware wrapper for existing snapshot commands. Their legacy shape
   * remains unchanged unless the caller supplies manifest knowledge.
   */
  async readConditionalResourceSnapshot<T>(
    resource: ResourceManifestKind,
    knownGeneration: string,
    knownRevision: ResourceSnapshotRevision,
    load: () => Promise<T> | T,
  ): Promise<ConditionalResourceSnapshot<T>> {
    const revision = await this.getResourceSnapshotRevision(resource);
    if (knownGeneration === this.context.resourceGeneration && knownRevision === revision) {
      return {
        status: "unchanged",
        generation: this.context.resourceGeneration,
        revision,
      };
    }
    const snapshot = await load();
    // Deliberately publish the pre-read revision. If a concurrent writer lands
    // during the read, the next event/manifest comparison still sees a mismatch
    // instead of incorrectly blessing a potentially older body as current.
    return {
      status: "changed",
      generation: this.context.resourceGeneration,
      revision,
      snapshot,
    };
  }
}
