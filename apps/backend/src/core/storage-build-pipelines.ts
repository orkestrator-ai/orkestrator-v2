import type {
  PipelineSession,
  PipelineTranscriptReference,
} from "@orkestrator/protocol/build-pipeline";
import * as shared from "./storage-shared.js";
import {
  activeBuildAdmissionKey,
  activeGitHubBuildReservation,
  isNonBlankString,
  isNonNegativeInteger,
  isPersistedBuildPipeline,
  isPositiveInteger,
  isRecord,
  nowIso,
} from "./storage-shared.js";
import {
  BUILD_PIPELINE_TRANSCRIPT_DIRECTORY,
  BuildPipelineTranscriptStore,
  transcriptPipelineTag,
  transcriptSessionKey,
  type BuildPipelineTranscriptFaultStage,
  type BuildPipelineTranscriptFaults,
  type BuildPipelineTranscriptLimits,
  type BuildPipelineTranscriptStats,
  type StagedTranscript,
  type TranscriptCommitInput,
  type TranscriptCommitResult,
  type TranscriptRead,
  type TranscriptReadWindow,
} from "./build-pipeline-transcript-store.js";
import {
  LEGACY_BUILD_PIPELINE_SNAPSHOT_LIMIT_BYTES,
  readInlineTranscript,
} from "./build-pipeline-transcripts.js";
import {
  migrateInlineBuildPipelineTranscripts,
  type BuildPipelineTranscriptMigrationReport,
  type InlineImportBatchEntry,
  type InlineImportBatchOutcome,
} from "./build-pipeline-transcript-migration.js";
import { StoreCorruptError } from "./storage-database.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import type { StorageRepositories } from "./storage-repositories.js";
type PersistedBuildPipeline = shared.PersistedBuildPipeline;

/**
 * The transcript-store owner of a graph run's activation transcripts (item
 * 211): its own namespace, so no build pipeline id (a UUID) can collide with
 * it. Each activation's transcript is one session, keyed by activation key.
 */
export function graphRunTranscriptOwner(runId: string): string {
  return `graph-run:${runId}`;
}

/** Committed control records and the store revision they were read at. */
interface LoadedBuildPipelines {
  records: Readonly<Record<string, PersistedBuildPipeline>>;
  revision: number | null;
}

/** The session fields that describe which transcript a control record references. */
const TRANSCRIPT_FIELDS = [
  "transcript",
  "messages",
  "messageRevision",
  "messagesFingerprint",
] as const;

interface RevertedSession {
  sessionKey: string;
  fields: Partial<Record<(typeof TRANSCRIPT_FIELDS)[number], unknown>>;
  reason: string;
}

interface ControlCommit {
  committed: StagedTranscript[];
  refused: StagedTranscript[];
  /** Per written pipeline: sessions restored to their previous transcript. */
  reverted: Map<string, RevertedSession[]>;
  /** Chunk files of deleted transcripts, to unlink after the commit. */
  deletedChunks: string[];
}

class RefusedImport extends Error {}

function sessionsOf(snapshot: unknown): Array<Record<string, unknown>> {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.sessions)) return [];
  return (snapshot.sessions as unknown[]).filter(
    (session): session is Record<string, unknown> =>
      isRecord(session) && typeof session.sessionKey === "string" && session.sessionKey !== "",
  );
}

function sameReference(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Build-pipeline workflow storage (plan step 16).
 *
 * Control records live in the `build-pipelines` record store under the
 * cross-process build-pipeline lease, which is also the admission lock that
 * keeps project/GitHub build reservations unique. Display transcripts are
 * manifest rows plus immutable chunk files (see `BuildPipelineTranscriptStore`):
 * the control record carries only a small versioned reference.
 *
 * Every control write is one database transaction that also commits the
 * transcript manifests its sessions newly reference (staged by the
 * checkpoint just before), after re-checking inside that transaction the
 * control revision the caller read and each manifest's base revision. So a
 * control record and the transcripts it names always change together: no
 * fences, retained generations or orphan windows. A manifest that cannot
 * commit (quota, a concurrent checkpoint, a vanished chunk) never blocks the
 * control write: that session keeps its previous reference, with a
 * content-free `transcriptCheckpointError`, and the caller's snapshot object
 * is updated to match so its next checkpoint retries.
 *
 * Reads are served from a revision-validated decoded cache.
 */
export class BuildPipelinesRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
    private readonly repos: StorageRepositories,
  ) {}

  /**
   * Serializes build pipeline writes across backend processes sharing this data
   * directory. The cross-process lease matters more here than the in-process
   * queue: two renderers driving the same pipeline is precisely the race the
   * compare-and-swap revision exists to reject, and it can only reject it if the
   * read-modify-write is atomic.
   */
  private enqueueBuildPipelineMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(
      this.files.buildPipelinesFile(),
      "build pipeline storage",
      operation,
    );
  }

  private buildPipelineReadCache: {
    fingerprint: string;
    records: Readonly<Record<string, PersistedBuildPipeline>>;
  } | null = null;
  private buildPipelineTranscriptStoreInstance: BuildPipelineTranscriptStore | null = null;
  private buildPipelineTranscriptFaultHooks: BuildPipelineTranscriptFaults | null = null;
  private buildPipelineTranscriptLimitOverrides: Partial<BuildPipelineTranscriptLimits> | null =
    null;
  private liveBuildPipelineTagCache: { revision: number | null; tags: Set<string> } | null = null;
  private liveGraphRunTagCache: { revision: number | null; tags: Set<string> } | null = null;

  /** Constructed lazily: storage that never runs a build never creates the chunk directory. */
  private buildPipelineTranscriptStore(): BuildPipelineTranscriptStore {
    this.buildPipelineTranscriptStoreInstance ??= new BuildPipelineTranscriptStore({
      directory: this.context.file(BUILD_PIPELINE_TRANSCRIPT_DIRECTORY),
      database: () => this.context.database,
      isLivePipeline: (pipelineTag) => {
        const pipelines = this.liveBuildPipelineTags();
        if (!pipelines) return true;
        if (pipelines.has(pipelineTag)) return true;
        // Graph runs keep their activation transcripts here too (item 211).
        return this.liveGraphRunTags()?.has(pipelineTag) ?? true;
      },
      faults: () => this.buildPipelineTranscriptFaultHooks,
      ...(this.buildPipelineTranscriptLimitOverrides
        ? { limits: this.buildPipelineTranscriptLimitOverrides }
        : {}),
    });
    return this.buildPipelineTranscriptStoreInstance;
  }

  /** Test-only: injects crash points into transcript, migration and deletion paths. */
  setBuildPipelineTranscriptFaults(faults: BuildPipelineTranscriptFaults | null): void {
    this.buildPipelineTranscriptFaultHooks = faults;
  }

  /** Test-only: smaller transcript bounds; must be set before first use. */
  setBuildPipelineTranscriptLimits(limits: Partial<BuildPipelineTranscriptLimits>): void {
    if (this.buildPipelineTranscriptStoreInstance) {
      throw new Error("Build pipeline transcript limits must be set before first use");
    }
    this.buildPipelineTranscriptLimitOverrides = limits;
  }

  async buildPipelineTranscriptFault(
    stage: BuildPipelineTranscriptFaultStage,
    key: string,
  ): Promise<void> {
    await this.buildPipelineTranscriptFaultHooks?.at?.(stage, { key });
  }

  buildPipelineTranscriptStats(): BuildPipelineTranscriptStats {
    return this.buildPipelineTranscriptStore().stats();
  }

  private buildPipelineStore(): string {
    return this.context.storeForFile(this.files.buildPipelinesFile())!;
  }

  /**
   * One committed control record, read inside a transaction. A store
   * imported from an unreadable legacy file reads as empty, exactly as
   * `loadBuildPipelines` treats it; the next write replaces it.
   */
  private committedBuildPipeline(id: string): PersistedBuildPipeline | null {
    let current: unknown;
    try {
      current = this.context.database.readStoreRow(this.buildPipelineStore(), id);
    } catch (error) {
      if (error instanceof StoreCorruptError) return null;
      throw error;
    }
    return isPersistedBuildPipeline(current, id) ? current : null;
  }

  /**
   * Pipeline tags that have a control record, revalidated against the store
   * revision. Synchronous so it can run inside a transaction. `null` when the
   * store is unreadable: nothing may be treated as orphaned then.
   */
  private liveBuildPipelineTags(): Set<string> | null {
    const store = this.buildPipelineStore();
    const revision = this.context.database.storeRevision(store);
    if (this.liveBuildPipelineTagCache?.revision === revision) {
      recurringWorkMetrics.work("storage-stat");
      return this.liveBuildPipelineTagCache.tags;
    }
    let value: unknown;
    try {
      value = this.context.database.readStore(store)?.value ?? {};
    } catch {
      return null;
    }
    const tags = new Set(Object.keys(isRecord(value) ? value : {}).map(transcriptPipelineTag));
    this.liveBuildPipelineTagCache = { revision, tags };
    return tags;
  }

  /**
   * Transcript owner tags of the graph runs that exist, revalidated against
   * the `graph-runs` store revision; row keys only, never the records.
   * Synchronous (it runs inside transactions). `null` when the store cannot
   * be read: nothing may be treated as orphaned then.
   */
  private liveGraphRunTags(): Set<string> | null {
    const store = this.context.storeForFile(this.context.file("graph-runs.json"));
    if (!store) return null;
    const revision = this.context.database.storeRevision(store);
    if (this.liveGraphRunTagCache?.revision === revision) {
      recurringWorkMetrics.work("storage-stat");
      return this.liveGraphRunTagCache.tags;
    }
    let keys: string[];
    try {
      keys =
        revision === null
          ? []
          : this.context.database
              .rows(store)
              .list({ values: false })
              .map((entry) => entry.key);
    } catch {
      return null;
    }
    const tags = new Set(
      keys.map((runId) => transcriptPipelineTag(graphRunTranscriptOwner(runId))),
    );
    this.liveGraphRunTagCache = { revision, tags };
    return tags;
  }

  /**
   * Decoded control records. The returned map and its records are shared with
   * the cache: callers must treat them as read-only and clone before mutating.
   * A hit costs one revision lookup and is charged as a `storage-stat`.
   *
   * The revision is read before the rows, so a foreign write landing in
   * between caches fresh content under a stale revision — one extra re-read
   * later, never a stale answer.
   */
  private async loadBuildPipelineState(): Promise<LoadedBuildPipelines> {
    const revision = this.context.database.storeRevision(this.buildPipelineStore());
    const fingerprint = revision === null ? "missing" : `revision:${revision}`;
    const cached = this.buildPipelineReadCache;
    if (cached && cached.fingerprint === fingerprint) {
      recurringWorkMetrics.work("storage-stat");
      return { records: cached.records, revision };
    }
    const stored = await this.context.loadJson<Record<string, PersistedBuildPipeline>>(
      this.files.buildPipelinesFile(),
      () => ({}),
    );
    const records = Object.fromEntries(
      Object.entries(isRecord(stored) ? stored : {}).filter(([storedId, pipeline]) =>
        isPersistedBuildPipeline(pipeline, storedId),
      ),
    ) as Record<string, PersistedBuildPipeline>;
    this.buildPipelineReadCache = { fingerprint, records };
    return { records, revision };
  }

  private async loadBuildPipelines(): Promise<Readonly<Record<string, PersistedBuildPipeline>>> {
    return (await this.loadBuildPipelineState()).records;
  }

  /**
   * The one write path for control records: puts and deletes rows, commits
   * the staged manifests the written records newly reference, and deletes
   * the transcripts of removed pipelines — all in ONE transaction. Callers
   * hold the build-pipeline lease; the revision each touched row had when
   * `loaded` was read is re-checked inside the transaction anyway, so a
   * write that raced another process fails instead of overwriting it.
   *
   * `put` records may be adjusted in place: a session whose staged manifest
   * cannot commit is restored to its previous transcript fields.
   */
  private commitBuildPipelineChanges(
    loaded: LoadedBuildPipelines,
    changes: {
      put?: readonly PersistedBuildPipeline[];
      remove?: readonly string[];
      /** Pipeline ids whose transcripts are deleted without a control row (never created). */
      removeTranscripts?: readonly string[];
    },
  ): ControlCommit {
    const store = this.buildPipelineStore();
    const transcripts = this.buildPipelineTranscriptStore();
    const result: ControlCommit = {
      committed: [],
      refused: [],
      reverted: new Map(),
      deletedChunks: [],
    };
    const touchesControl = (changes.put?.length ?? 0) + (changes.remove?.length ?? 0) > 0;
    let primed: Record<string, PersistedBuildPipeline> | null = touchesControl
      ? { ...loaded.records }
      : null;
    const fingerprint = this.context.database.transaction(() => {
      if (this.context.database.storeRevision(store) !== loaded.revision) primed = null;
      for (const id of [
        ...(changes.put ?? []).map((record) => record.id),
        ...(changes.remove ?? []),
      ]) {
        const currentRevision = this.committedBuildPipeline(id)?.revision ?? null;
        if (currentRevision !== (loaded.records[id]?.revision ?? null)) {
          throw new Error("Build pipeline revision conflict");
        }
      }
      for (const id of [...(changes.remove ?? []), ...(changes.removeTranscripts ?? [])]) {
        result.deletedChunks.push(...transcripts.deletePipelineInTransaction(id).chunks);
      }
      for (const id of changes.remove ?? []) {
        this.context.database.updateStoreRow(store, id, () => ({
          result: undefined,
          delete: true,
        }));
        if (primed) delete primed[id];
      }
      for (const record of changes.put ?? []) {
        const reverted = this.commitSessionTranscripts(record, loaded.records[record.id], result);
        if (reverted.length > 0) result.reverted.set(record.id, reverted);
        this.context.database.updateStoreRow(store, record.id, () => ({
          result: undefined,
          value: record,
        }));
        if (primed) primed[record.id] = record;
      }
      const revision = this.context.database.storeRevision(store);
      return revision === null ? "missing" : `revision:${revision}`;
    });
    if (touchesControl) {
      this.buildPipelineReadCache = primed ? { fingerprint, records: primed } : null;
    }
    return result;
  }

  /**
   * Inside the control transaction: commits each staged manifest `record`'s
   * sessions reference. A session whose new reference cannot be committed —
   * refused, or staged too long ago to still be held — gets its previous
   * transcript fields back.
   */
  private commitSessionTranscripts(
    record: PersistedBuildPipeline,
    previous: PersistedBuildPipeline | undefined,
    result: ControlCommit,
  ): RevertedSession[] {
    const transcripts = this.buildPipelineTranscriptStore();
    const previousSessions = new Map(
      sessionsOf(previous?.snapshot).map((session) => [session.sessionKey as string, session]),
    );
    const reverted: RevertedSession[] = [];
    for (const session of sessionsOf(record.snapshot)) {
      const sessionKey = session.sessionKey as string;
      const reference = session.transcript as PipelineSession["transcript"];
      const before = previousSessions.get(sessionKey);
      if (!reference || sameReference(reference, before?.transcript)) continue;
      const staged = transcripts.stagedFor(record.id, sessionKey, reference);
      let reason: string | null = null;
      if (staged) {
        const outcome = transcripts.commitStagedInTransaction(staged);
        if (outcome.ok) {
          result.committed.push(staged);
          continue;
        }
        result.refused.push(staged);
        reason = outcome.reason;
      } else {
        const committed = transcripts.committedReference(record.id, sessionKey);
        if (
          !committed ||
          !sameReference(reference, transcripts.reference(committed)) ||
          (session.messagesFingerprint !== undefined &&
            session.messagesFingerprint !== committed.fingerprint)
        ) {
          reason = "stage-expired";
        } else {
          session.messagesFingerprint = committed.fingerprint;
        }
      }
      if (reason === null) continue;
      const fields: RevertedSession["fields"] = {};
      for (const field of TRANSCRIPT_FIELDS) {
        if (before && field in before) fields[field] = structuredClone(before[field]);
      }
      for (const field of TRANSCRIPT_FIELDS) delete session[field];
      Object.assign(session, structuredClone(fields));
      session.transcriptCheckpointError = reason.slice(0, 128);
      reverted.push({ sessionKey, fields, reason });
    }
    return reverted;
  }

  /** After a commit: settles staged manifests and unlinks chunks nothing references any more. */
  private async settleControlCommit(commit: ControlCommit, key: string): Promise<void> {
    const transcripts = this.buildPipelineTranscriptStoreInstance;
    if (!transcripts) return;
    if (commit.committed.length > 0 || commit.deletedChunks.length > 0) {
      await this.buildPipelineTranscriptFault("after-commit", key);
    }
    await transcripts.settleCommitted(commit.committed, commit.refused);
    if (commit.deletedChunks.length > 0) await transcripts.unlinkUnreferenced(commit.deletedChunks);
  }

  async getBuildPipeline(pipelineId: string): Promise<PersistedBuildPipeline | null> {
    if (!isNonBlankString(pipelineId)) {
      throw new Error("Build pipeline ID must not be blank");
    }
    const record = (await this.loadBuildPipelines())[pipelineId];
    return record ? structuredClone(record) : null;
  }

  /**
   * The records of one environment in one project. Only those are copied, so
   * a caller that asks for every agent tool request stays cheap when the
   * environment has none.
   */
  async listBuildPipelinesForEnvironment(
    projectId: string,
    environmentId: string,
  ): Promise<PersistedBuildPipeline[]> {
    return Object.values(await this.loadBuildPipelines())
      .filter(
        (pipeline) => pipeline.projectId === projectId && pipeline.environmentId === environmentId,
      )
      .map((record) => structuredClone(record));
  }

  async listBuildPipelines(projectId: string): Promise<PersistedBuildPipeline[]> {
    if (!isNonBlankString(projectId)) {
      throw new Error("Build pipeline project ID must not be blank");
    }
    return Object.values(await this.loadBuildPipelines())
      .filter((pipeline) => pipeline.projectId === projectId)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((record) => structuredClone(record));
  }

  /** Backend supervisors use this to re-arm every active pipeline on startup. */
  async listAllBuildPipelines(): Promise<PersistedBuildPipeline[]> {
    return Object.values(await this.loadBuildPipelines())
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((record) => structuredClone(record));
  }

  /**
   * Writes one control record and, in the same transaction, the transcript
   * manifests staged for the references its sessions carry. When a staged
   * manifest cannot commit, that session keeps its previous transcript in
   * the stored record, and `snapshot`'s matching session is updated in place
   * to agree with it.
   */
  async saveBuildPipeline(
    pipelineId: string,
    projectId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
    expectedRevision?: number,
  ): Promise<PersistedBuildPipeline> {
    if (!isNonBlankString(pipelineId)) {
      throw new Error("Build pipeline ID must not be blank");
    }
    if (!isNonBlankString(projectId)) {
      throw new Error("Build pipeline project ID must not be blank");
    }
    if (typeof environmentId !== "string") {
      throw new Error("Build pipeline environment ID must be a string");
    }
    if (!isPositiveInteger(version)) {
      throw new Error("Build pipeline version must be a positive integer");
    }
    if (!isRecord(snapshot)) {
      throw new Error("Build pipeline snapshot must be a JSON object");
    }
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Build pipeline expected revision must be a non-negative integer");
    }
    let serializedSnapshot: string | undefined;
    try {
      serializedSnapshot = JSON.stringify(snapshot);
    } catch {
      throw new Error("Build pipeline snapshot must be JSON serializable");
    }
    if (serializedSnapshot === undefined) {
      throw new Error("Build pipeline snapshot must be JSON serializable");
    }
    // Task snapshots embed base64 attachment data and structured review reports
    // retain full findings. Reject an over-sized snapshot rather than truncating
    // it: a silently trimmed task is a pipeline that builds the wrong thing.
    // Display transcripts no longer count against this bound (they are stored
    // separately); only an unmigrated legacy record still carries them inline.
    if (
      Buffer.byteLength(serializedSnapshot, "utf8") > LEGACY_BUILD_PIPELINE_SNAPSHOT_LIMIT_BYTES
    ) {
      throw new Error("Build pipeline snapshot exceeds the 32 MB limit");
    }
    // Stored as parsed JSON so the cached decoded record never aliases the
    // caller's live object.
    const storedSnapshot = JSON.parse(serializedSnapshot) as Record<string, unknown>;

    const saved = await this.enqueueBuildPipelineMutation(async () => {
      if (environmentId) {
        await this.repos.nativeAgentSessions.assertEnvironmentAcceptsBackgroundState(
          environmentId,
          "Build pipeline",
        );
      }
      const loaded = await this.loadBuildPipelineState();
      const pipelines = loaded.records;
      const previous = pipelines[pipelineId];
      if (previous && previous.projectId !== projectId) {
        throw new Error("Build pipeline belongs to another project");
      }
      if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) {
        throw new Error("Build pipeline revision conflict");
      }
      // Admission and reservation uniqueness are checked against every control
      // record under this cross-pipeline lock, so two concurrent admissions can
      // never both commit one reservation.
      const admissionKey = activeBuildAdmissionKey(storedSnapshot);
      if (!previous && expectedRevision === 0 && admissionKey) {
        const admitted = Object.values(pipelines).find(
          (pipeline) => activeBuildAdmissionKey(pipeline.snapshot) === admissionKey,
        );
        if (admitted) return { record: structuredClone(admitted), commit: null };
      }
      const reservation = activeGitHubBuildReservation(storedSnapshot);
      if (
        reservation &&
        Object.values(pipelines).some(
          (pipeline) =>
            pipeline.id !== pipelineId &&
            activeGitHubBuildReservation(pipeline.snapshot) === reservation,
        )
      ) {
        throw new Error(`An active build already exists for ${reservation}`);
      }
      const record: PersistedBuildPipeline = {
        version,
        id: pipelineId,
        projectId,
        environmentId,
        snapshot: storedSnapshot,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      await this.buildPipelineTranscriptStore().ensureReferencesImported(
        pipelineId,
        sessionsOf(storedSnapshot) as Array<{
          sessionKey: string;
          transcript?: PipelineSession["transcript"];
        }>,
      );
      const commit = this.commitBuildPipelineChanges(loaded, { put: [record] });
      this.context.changes.announce("build-pipeline", pipelineId, projectId);
      return { record: structuredClone(record), commit };
    });
    if (saved.commit) {
      const reverted = saved.commit.reverted.get(pipelineId) ?? [];
      for (const entry of reverted) {
        console.warn(
          `[build-pipeline] Transcript checkpoint not committed for ${pipelineId}: ${entry.reason}`,
        );
        const live = sessionsOf(snapshot).find(
          (session) => session.sessionKey === entry.sessionKey,
        );
        if (!live) continue;
        for (const field of TRANSCRIPT_FIELDS) delete live[field];
        Object.assign(live, structuredClone(entry.fields));
        live.transcriptCheckpointError = entry.reason.slice(0, 128);
      }
      await this.settleControlCommit(saved.commit, pipelineId);
    }
    return saved.record;
  }

  async deleteBuildPipeline(pipelineId: string): Promise<void> {
    if (!isNonBlankString(pipelineId)) {
      throw new Error("Build pipeline ID must not be blank");
    }
    const commit = await this.enqueueBuildPipelineMutation(async () => {
      const loaded = await this.loadBuildPipelineState();
      const record = loaded.records[pipelineId];
      await this.importTranscriptsBeforeDelete(record ? [record] : []);
      const removed = record ? [pipelineId] : [];
      const commit = this.commitBuildPipelineChanges(loaded, {
        remove: removed,
        removeTranscripts: record ? [] : [pipelineId],
      });
      if (record) {
        this.context.changes.announce(
          "build-pipeline",
          pipelineId,
          record.projectId,
          undefined,
          true,
        );
      }
      await this.context.scrubSensitiveJsonBackups(
        this.files.buildPipelinesFile(),
        (storedId, pipeline) =>
          storedId !== pipelineId && isPersistedBuildPipeline(pipeline, storedId),
      );
      return commit;
    });
    await this.finishTranscriptDeletion([pipelineId], commit);
  }

  async deleteBuildPipelinesByEnvironment(
    environmentId: string,
    linkedPipelineId?: string,
  ): Promise<string[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Build pipeline environment ID must not be blank");
    }
    if (
      linkedPipelineId !== undefined &&
      linkedPipelineId !== "" &&
      !isNonBlankString(linkedPipelineId)
    ) {
      throw new Error("Linked build pipeline ID must not be blank");
    }
    const { removedIds, transcriptOwners, commit } = await this.enqueueBuildPipelineMutation(
      async () => {
        const loaded = await this.loadBuildPipelineState();
        const requestedLinkedId = isNonBlankString(linkedPipelineId) ? linkedPipelineId : null;
        // The link alone decides only while the pipeline is unowned: a newly
        // created pipeline has a blank environmentId until create_environment
        // links it. A pipeline owned by another environment stays, record and
        // transcripts: a sidebar fork copies its source's buildPipelineId.
        const linkedRecord = requestedLinkedId ? loaded.records[requestedLinkedId] : undefined;
        const linkedId =
          requestedLinkedId &&
          (!linkedRecord ||
            !linkedRecord.environmentId ||
            linkedRecord.environmentId === environmentId)
            ? requestedLinkedId
            : null;
        const removedPipelines = Object.values(loaded.records).filter(
          (pipeline) => pipeline.environmentId === environmentId || pipeline.id === linkedId,
        );
        const removedIds = removedPipelines.map((pipeline) => pipeline.id);
        const removedIdSet = new Set(removedIds);
        const transcriptOnly = linkedId && !removedIdSet.has(linkedId) ? [linkedId] : [];
        await this.importTranscriptsBeforeDelete(removedPipelines);
        const commit = this.commitBuildPipelineChanges(loaded, {
          remove: removedIds,
          removeTranscripts: transcriptOnly,
        });
        for (const removed of removedPipelines) {
          this.context.changes.announce(
            "build-pipeline",
            removed.id,
            removed.projectId,
            undefined,
            true,
          );
        }
        if (linkedId) removedIdSet.add(linkedId);
        // Task snapshots embed base64 attachments and full review findings, so
        // the deleting commit is scrubbed from free pages and the WAL. Check
        // both ownership forms because a newly-created pipeline deliberately
        // has a blank environmentId until create_environment links it.
        await this.context.scrubSensitiveJsonBackups(
          this.files.buildPipelinesFile(),
          (storedId, pipeline) =>
            isPersistedBuildPipeline(pipeline, storedId) &&
            pipeline.environmentId !== environmentId &&
            !removedIdSet.has(storedId),
        );
        return { removedIds, transcriptOwners: [...removedIdSet], commit };
      },
    );
    await this.finishTranscriptDeletion(transcriptOwners, commit);
    return removedIds;
  }

  /**
   * A pipeline deleted while the pre-database manifests are still being
   * imported: import its sessions' manifests first so their rows, and the
   * chunks they name, are deleted with it instead of lingering on disk.
   */
  private async importTranscriptsBeforeDelete(
    records: readonly PersistedBuildPipeline[],
  ): Promise<void> {
    for (const record of records) {
      const sessionKeys = sessionsOf(record.snapshot).map(
        (session) => session.sessionKey as string,
      );
      await this.buildPipelineTranscriptStore().ensureSessionsImported(record.id, sessionKeys);
    }
  }

  /**
   * After the deleting transaction (control rows and manifest rows together)
   * and its scrub: drops staged checkpoints of the removed pipelines and
   * unlinks their chunk files. A crash before the unlinks leaves only
   * unreferenced chunks, which repair removes.
   */
  private async finishTranscriptDeletion(
    pipelineIds: readonly string[],
    commit: ControlCommit,
  ): Promise<void> {
    for (const pipelineId of pipelineIds) {
      await this.buildPipelineTranscriptFault("delete-after-control", pipelineId);
    }
    const transcripts = this.buildPipelineTranscriptStoreInstance;
    if (!transcripts) return;
    for (const pipelineId of pipelineIds) await transcripts.discardStaged(pipelineId);
    if (commit.deletedChunks.length > 0) await transcripts.unlinkUnreferenced(commit.deletedChunks);
  }

  /** Removes transcripts staged or committed for a pipeline id whose control record was never created. */
  async deleteBuildPipelineTranscriptsFor(pipelineId: string): Promise<void> {
    if (!isNonBlankString(pipelineId)) return;
    const commit = await this.enqueueBuildPipelineMutation(async () => {
      const loaded = await this.loadBuildPipelineState();
      if (loaded.records[pipelineId]) return null;
      const commit = this.commitBuildPipelineChanges(loaded, { removeTranscripts: [pipelineId] });
      if (commit.deletedChunks.length > 0) this.context.scrubDeletedDatabaseContent();
      return commit;
    });
    if (commit) await this.finishTranscriptDeletion([pipelineId], commit);
  }

  /**
   * Stages one session's display transcript (chunk files written and
   * fsynced) for the control write that will reference it; that write
   * commits the manifest.
   */
  commitBuildPipelineTranscript(input: TranscriptCommitInput): Promise<TranscriptCommitResult> {
    return this.buildPipelineTranscriptStore().stage(input);
  }

  /**
   * Reads messages `[fromIndex, toIndex)` of a session's committed transcript:
   * the referenced chunks for a migrated session, the inline array for a legacy
   * one, and an empty transcript for a session that has none yet.
   */
  async readBuildPipelineTranscript(
    pipelineId: string,
    session: Pick<PipelineSession, "sessionKey" | "transcript" | "messages" | "messageRevision">,
    window: TranscriptReadWindow = {},
  ): Promise<TranscriptRead> {
    if (session.transcript) {
      return this.buildPipelineTranscriptStore().read(
        pipelineId,
        session.sessionKey,
        session.transcript,
        window,
      );
    }
    return readInlineTranscript(session, window);
  }

  /**
   * Stores one graph activation's display transcript (item 211): stages the
   * chunks, then commits the manifest in its own transaction. A graph run's
   * record is saved separately, so the manifest commits first and the
   * record's reference never names uncommitted data; a run save that loses
   * its race leaves the committed manifest, which a later read substitutes.
   * Returns the committed reference, or null when the store refused it.
   */
  async commitGraphRunTranscript(input: {
    runId: string;
    activationKey: string;
    sdkSessionId: string;
    messages: readonly unknown[];
    revision: number;
    fingerprint: string;
  }): Promise<PipelineTranscriptReference | null> {
    const store = this.buildPipelineTranscriptStore();
    const result = await store.stage({
      pipelineId: graphRunTranscriptOwner(input.runId),
      sessionKey: input.activationKey,
      sdkSessionId: input.sdkSessionId,
      messages: input.messages,
      revision: input.revision,
      fingerprint: input.fingerprint,
    });
    if (result.status === "rejected") return null;
    const staged = result.staged;
    if (!result.written || !staged) return result.reference;
    const outcome = this.context.database.transaction(() =>
      store.commitStagedInTransaction(staged),
    );
    if (!outcome.ok) {
      await store.settleCommitted([], [staged]);
      await store.discard([staged]);
      return null;
    }
    await store.settleCommitted([staged]);
    return result.reference;
  }

  /** The committed manifest and fingerprint of a graph activation's transcript, if any. */
  describeGraphRunTranscript(
    runId: string,
    activationKey: string,
  ): Promise<{ reference: PipelineTranscriptReference; fingerprint: string } | null> {
    return this.buildPipelineTranscriptStore().describe(
      graphRunTranscriptOwner(runId),
      activationKey,
    );
  }

  /** Reads messages `[fromIndex, toIndex)` of a graph activation's stored transcript. */
  readGraphRunTranscript(
    runId: string,
    activationKey: string,
    reference: PipelineTranscriptReference,
    window: TranscriptReadWindow = {},
  ): Promise<TranscriptRead> {
    return this.buildPipelineTranscriptStore().read(
      graphRunTranscriptOwner(runId),
      activationKey,
      reference,
      window,
    );
  }

  /** Removes a deleted graph run's activation transcripts (manifests and chunks). */
  async deleteGraphRunTranscripts(runId: string): Promise<void> {
    await this.deleteBuildPipelineTranscriptsFor(graphRunTranscriptOwner(runId));
  }

  /**
   * Background transcript migration: first the pre-database manifest files
   * (batched, resumable), then legacy inline transcripts out of the control
   * records. See `migrateInlineBuildPipelineTranscripts`.
   */
  async migrateBuildPipelineTranscripts(
    options: { maxPipelinesPerBatch?: number; shouldContinue?: () => boolean } = {},
  ): Promise<BuildPipelineTranscriptMigrationReport> {
    const store = this.buildPipelineTranscriptStore();
    const referenced = new Map<string, number>();
    for (const record of Object.values(await this.loadBuildPipelines())) {
      for (const session of sessionsOf(record.snapshot)) {
        const reference = session.transcript as PipelineSession["transcript"];
        if (reference) {
          referenced.set(
            transcriptSessionKey(record.id, session.sessionKey as string),
            reference.manifestRevision,
          );
        }
      }
    }
    const legacy = await store.migrateLegacyManifests({
      ...(options.shouldContinue ? { shouldContinue: options.shouldContinue } : {}),
      preferRevision: (key) => referenced.get(key),
    });
    const report = await migrateInlineBuildPipelineTranscripts({
      store,
      load: () => this.loadBuildPipelines(),
      commitBatch: (entries) => this.commitInlineImportBatch(entries),
      fault: (stage, key) => this.buildPipelineTranscriptFault(stage, key),
      ...options,
    });
    return { ...report, legacyManifests: { imported: legacy.imported, complete: legacy.complete } };
  }

  /** One transaction for a batch of inline-transcript imports; see the migration module. */
  private async commitInlineImportBatch(
    entries: readonly InlineImportBatchEntry[],
  ): Promise<InlineImportBatchOutcome> {
    const outcome: InlineImportBatchOutcome = {
      migrated: [],
      conflicted: [],
      missing: [],
      refused: [],
    };
    if (entries.length === 0) return outcome;
    const transcripts = this.buildPipelineTranscriptStore();
    const store = this.buildPipelineStore();
    const settled = await this.enqueueBuildPipelineMutation(async () => {
      await this.buildPipelineTranscriptFault("migration-before-control-commit", "control");
      const committed: StagedTranscript[] = [];
      const refused: StagedTranscript[] = [];
      this.buildPipelineReadCache = null;
      this.context.database.transaction(() => {
        for (const entry of entries) {
          const current = this.committedBuildPipeline(entry.pipelineId);
          if (!current) {
            outcome.missing.push(entry.pipelineId);
            continue;
          }
          if (current.revision !== entry.sourceRevision) {
            outcome.conflicted.push(entry.pipelineId);
            continue;
          }
          try {
            // A savepoint per pipeline: all of its manifests and its control
            // row, or none of them.
            this.context.database.transaction(() => {
              for (const staged of entry.staged) {
                const result = transcripts.commitStagedInTransaction(staged);
                if (!result.ok) throw new RefusedImport(result.reason);
              }
              this.context.database.updateStoreRow(store, entry.pipelineId, () => ({
                result: undefined,
                value: { ...current, snapshot: entry.apply(current.snapshot) },
              }));
            });
            committed.push(...entry.staged);
            outcome.migrated.push(entry.pipelineId);
          } catch (error) {
            if (!(error instanceof RefusedImport)) throw error;
            refused.push(...entry.staged);
            outcome.refused.push(entry.pipelineId);
          }
        }
      });
      return { committed, refused };
    });
    await transcripts.settleCommitted(settled.committed, settled.refused);
    return outcome;
  }

  /**
   * Startup repair: removes manifest rows no control record owns (after the
   * grace window; a defensive check, since commits and deletes are atomic
   * with the control record) and chunk files no manifest references.
   */
  async sweepBuildPipelineTranscripts(
    options: { graceMs?: number } = {},
  ): Promise<{ orphans: number; removedChunks: number; complete: boolean }> {
    const store = this.buildPipelineTranscriptStore();
    const orphans = this.liveBuildPipelineTags() ? await store.sweepOrphans(options.graceMs) : 0;
    const repair = await store.repair(options.graceMs);
    return { orphans, removedChunks: repair.removedChunks, complete: repair.complete };
  }
}
