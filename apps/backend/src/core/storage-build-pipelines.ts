import type { PipelineSession } from "@orkestrator/protocol/build-pipeline";
import * as shared from "./storage-shared.js";
import {
  activeBuildAdmissionKey,
  activeGitHubBuildReservation,
  exists,
  fs,
  isMissingFileError,
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
  type BuildPipelineTranscriptFaultStage,
  type BuildPipelineTranscriptFaults,
  type BuildPipelineTranscriptLimits,
  type BuildPipelineTranscriptStats,
  type TranscriptCommitInput,
  type TranscriptCommitResult,
  type TranscriptRead,
} from "./build-pipeline-transcript-store.js";
import {
  LEGACY_BUILD_PIPELINE_SNAPSHOT_LIMIT_BYTES,
  readInlineTranscript,
} from "./build-pipeline-transcripts.js";
import {
  migrateInlineBuildPipelineTranscripts,
  type BuildPipelineTranscriptMigrationReport,
} from "./build-pipeline-transcript-migration.js";
import { StoragePrompts } from "./storage-prompts.ts";
type PersistedBuildPipeline = shared.PersistedBuildPipeline;

export type BuildPipelineDowngradeExport =
  | { status: "exported"; record: PersistedBuildPipeline; bytes: number }
  | { status: "incompatible"; reason: "too-large" | "transcript-unavailable"; bytes?: number }
  | { status: "missing" };

/**
 * Build-pipeline workflow storage (plan step 16).
 *
 * Control records stay in the shared `build-pipelines.json` under the
 * cross-process build-pipeline lock, which is also the admission lock that
 * keeps project/GitHub build reservations unique. Display transcripts live in
 * `build-pipeline-transcripts/` (see `BuildPipelineTranscriptStore`): the
 * control record carries only a small versioned reference, so a phase, queue,
 * cancel or lease update rewrites control state rather than every pipeline's
 * history, and can no longer fail the 32 MiB snapshot bound because of display
 * data.
 *
 * Reads are served from a stat-validated decoded cache: an unchanged file
 * costs one `stat` per read instead of a full read, parse and validation.
 */
export abstract class StorageBuildPipelines extends StoragePrompts {
  private buildPipelineReadCache: {
    fingerprint: string;
    records: Readonly<Record<string, PersistedBuildPipeline>>;
  } | null = null;
  private buildPipelineTranscriptStoreInstance: BuildPipelineTranscriptStore | null = null;
  private buildPipelineTranscriptFaultHooks: BuildPipelineTranscriptFaults | null = null;
  private buildPipelineTranscriptLimitOverrides: Partial<BuildPipelineTranscriptLimits> | null =
    null;

  /** Constructed lazily: storage that never runs a build never creates the namespace. */
  protected buildPipelineTranscriptStore(): BuildPipelineTranscriptStore {
    this.buildPipelineTranscriptStoreInstance ??= new BuildPipelineTranscriptStore({
      directory: this.file(BUILD_PIPELINE_TRANSCRIPT_DIRECTORY),
      lock: (target) => this.acquireMutationLock(target, "build pipeline transcript storage"),
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

  private async buildPipelineFileFingerprint(): Promise<string> {
    try {
      const stat = await fs.stat(this.buildPipelinesFile(), { bigint: true });
      return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) {
      if (isMissingFileError(error)) return "missing";
      // Not evidence of an empty store: take the uncached path, which falls
      // back to the backups or surfaces the failure.
      return `unreadable:${Date.now()}:${Math.random()}`;
    }
  }

  /**
   * Decoded control records. The returned map and its records are shared with
   * the cache: callers must treat them as read-only and clone before mutating.
   *
   * The stat precedes the read, so a foreign write landing in between caches
   * fresh content under a stale fingerprint — one extra re-read later, never a
   * stale answer.
   */
  protected async loadBuildPipelines(): Promise<Readonly<Record<string, PersistedBuildPipeline>>> {
    const fingerprint = await this.buildPipelineFileFingerprint();
    const cached = this.buildPipelineReadCache;
    if (cached && cached.fingerprint === fingerprint) return cached.records;
    const stored = await this.loadJson<Record<string, PersistedBuildPipeline>>(
      this.buildPipelinesFile(),
      () => ({}),
    );
    const records = Object.fromEntries(
      Object.entries(isRecord(stored) ? stored : {}).filter(([storedId, pipeline]) =>
        isPersistedBuildPipeline(pipeline, storedId),
      ),
    ) as Record<string, PersistedBuildPipeline>;
    this.buildPipelineReadCache = fingerprint.startsWith("unreadable:")
      ? null
      : { fingerprint, records };
    return records;
  }

  /**
   * Writes the control file and primes the cache. Callers hold the
   * build-pipeline mutation lock, so no other writer can land between the
   * write and the stat that fingerprints it.
   */
  protected async writeBuildPipelines(
    pipelines: Record<string, PersistedBuildPipeline>,
  ): Promise<void> {
    this.buildPipelineReadCache = null;
    await this.saveSensitiveJson(this.buildPipelinesFile(), pipelines);
    const fingerprint = await this.buildPipelineFileFingerprint();
    if (!fingerprint.startsWith("unreadable:") && fingerprint !== "missing") {
      this.buildPipelineReadCache = { fingerprint, records: pipelines };
    }
  }

  async getBuildPipeline(pipelineId: string): Promise<PersistedBuildPipeline | null> {
    if (!isNonBlankString(pipelineId)) {
      throw new Error("Build pipeline ID must not be blank");
    }
    const record = (await this.loadBuildPipelines())[pipelineId];
    return record ? structuredClone(record) : null;
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
        await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Build pipeline");
      }
      const pipelines = { ...(await this.loadBuildPipelines()) };
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
        if (admitted) return { record: structuredClone(admitted), created: false };
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
      pipelines[pipelineId] = record;
      await this.writeBuildPipelines(pipelines);
      this.announce("build-pipeline", pipelineId, projectId);
      return { record: structuredClone(record), created: !previous };
    });
    // An id written again after a delete (legacy re-import) may own transcripts again.
    if (saved.created) this.buildPipelineTranscriptStoreInstance?.unfence(pipelineId);
    return saved.record;
  }

  async deleteBuildPipeline(pipelineId: string): Promise<void> {
    if (!isNonBlankString(pipelineId)) {
      throw new Error("Build pipeline ID must not be blank");
    }
    await this.enqueueBuildPipelineMutation(async () => {
      const pipelines = { ...(await this.loadBuildPipelines()) };
      if (pipelineId in pipelines) {
        const removedProjectId = pipelines[pipelineId]?.projectId;
        delete pipelines[pipelineId];
        await this.writeBuildPipelines(pipelines);
        this.announce("build-pipeline", pipelineId, removedProjectId, undefined, true);
      }
      await this.scrubSensitiveJsonBackups(
        this.buildPipelinesFile(),
        (storedId, pipeline) =>
          storedId !== pipelineId && isPersistedBuildPipeline(pipeline, storedId),
      );
    });
    await this.deleteBuildPipelineTranscripts([pipelineId]);
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
    const { removedIds, transcriptOwners } = await this.enqueueBuildPipelineMutation(async () => {
      const pipelines = { ...(await this.loadBuildPipelines()) };
      const linkedId = isNonBlankString(linkedPipelineId) ? linkedPipelineId : null;
      const removedPipelines = Object.values(pipelines).filter(
        (pipeline) => pipeline.environmentId === environmentId || pipeline.id === linkedId,
      );
      const removedIds = removedPipelines.map((pipeline) => pipeline.id);
      if (removedIds.length > 0) {
        for (const removedId of removedIds) delete pipelines[removedId];
        await this.writeBuildPipelines(pipelines);
        for (const removed of removedPipelines) {
          this.announce("build-pipeline", removed.id, removed.projectId, undefined, true);
        }
      }
      const removedIdSet = new Set(removedIds);
      if (linkedId) removedIdSet.add(linkedId);

      // Task snapshots embed base64 attachments and full review findings, so
      // the same backup scrub the looped review path performs applies here.
      // Check both ownership forms because a newly-created pipeline deliberately
      // has a blank environmentId until create_environment links it.
      await this.scrubSensitiveJsonBackups(
        this.buildPipelinesFile(),
        (storedId, pipeline) =>
          isPersistedBuildPipeline(pipeline, storedId) &&
          pipeline.environmentId !== environmentId &&
          !removedIdSet.has(storedId),
      );
      return { removedIds, transcriptOwners: [...removedIdSet] };
    });
    await this.deleteBuildPipelineTranscripts(transcriptOwners);
    return removedIds;
  }

  /**
   * Transcript deletion runs after the control record and its legacy backups
   * are gone, outside the control lock. The store fences later checkpoints
   * for these pipelines; a crash in between leaves orphans the startup sweep
   * removes, never a transcript a live record still references.
   */
  private async deleteBuildPipelineTranscripts(pipelineIds: readonly string[]): Promise<void> {
    if (pipelineIds.length === 0) return;
    // Storage that never stored a transcript has nothing to delete; do not
    // create the namespace just to find that out. The fence still applies.
    const present = await exists(this.file(BUILD_PIPELINE_TRANSCRIPT_DIRECTORY));
    for (const pipelineId of pipelineIds) {
      await this.buildPipelineTranscriptFault("delete-after-control", pipelineId);
      if (present) await this.buildPipelineTranscriptStore().deletePipeline(pipelineId);
      else this.buildPipelineTranscriptStoreInstance?.fencePipeline(pipelineId);
    }
  }

  /** Removes transcripts committed for a pipeline id whose control record was never created. */
  async deleteBuildPipelineTranscriptsFor(pipelineId: string): Promise<void> {
    if (!isNonBlankString(pipelineId)) return;
    if ((await this.loadBuildPipelines())[pipelineId]) return;
    await this.deleteBuildPipelineTranscripts([pipelineId]);
  }

  /** Commits one session's display transcript ahead of the workflow record that will reference it. */
  commitBuildPipelineTranscript(input: TranscriptCommitInput): Promise<TranscriptCommitResult> {
    return this.buildPipelineTranscriptStore().commit(input);
  }

  /**
   * Reads messages `[fromIndex, toIndex)` of a session's committed transcript:
   * the referenced chunks for a migrated session, the inline array for a legacy
   * one, and an empty transcript for a session that has none yet.
   */
  async readBuildPipelineTranscript(
    pipelineId: string,
    session: Pick<PipelineSession, "sessionKey" | "transcript" | "messages" | "messageRevision">,
    window: { fromIndex?: number; toIndex?: number } = {},
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
   * Moves legacy inline transcripts out of the control file. See
   * `migrateInlineBuildPipelineTranscripts` for the per-pipeline CAS protocol.
   */
  migrateBuildPipelineTranscripts(
    options: { maxPipelinesPerBatch?: number; shouldContinue?: () => boolean } = {},
  ): Promise<BuildPipelineTranscriptMigrationReport> {
    return migrateInlineBuildPipelineTranscripts({
      store: this.buildPipelineTranscriptStore(),
      load: () => this.loadBuildPipelines(),
      commitControl: (operation) =>
        this.enqueueBuildPipelineMutation(async () => {
          const pipelines = { ...(await this.loadBuildPipelines()) };
          const changed = await operation(pipelines);
          await this.buildPipelineTranscriptFault("migration-before-control-commit", "control");
          if (changed) await this.writeBuildPipelines(pipelines);
        }),
      fault: (stage, key) => this.buildPipelineTranscriptFault(stage, key),
      ...options,
    });
  }

  /**
   * Startup repair: removes transcripts no control record owns (after the
   * grace window) and chunks no manifest references.
   */
  async sweepBuildPipelineTranscripts(
    options: { graceMs?: number } = {},
  ): Promise<{ orphans: number; removedChunks: number; complete: boolean }> {
    // Nothing to collect before the first transcript, and sweeping must not
    // create the namespace for storage that never ran a build.
    if (!(await exists(this.file(BUILD_PIPELINE_TRANSCRIPT_DIRECTORY)))) {
      return { orphans: 0, removedChunks: 0, complete: true };
    }
    const store = this.buildPipelineTranscriptStore();
    const live = Object.keys(await this.loadBuildPipelines());
    const orphans = await store.sweepOrphans(live, options.graceMs);
    const repair = await store.repair();
    return { orphans, removedChunks: repair.removedChunks, complete: repair.complete };
  }

  /**
   * Explicit, bounded export of one pipeline in the pre-split schema (inline
   * transcripts, no references) for a downgrade. A record that cannot fit the
   * old 32 MiB snapshot bound is reported incompatible instead of truncated;
   * the current format stays authoritative either way. This does not modify
   * storage, and running an older binary against this data directory is not a
   * supported downgrade by itself.
   */
  async exportBuildPipelineForDowngrade(pipelineId: string): Promise<BuildPipelineDowngradeExport> {
    const record = await this.getBuildPipeline(pipelineId);
    if (!record) return { status: "missing" };
    const snapshot = record.snapshot as { sessions?: unknown };
    const sessions = Array.isArray(snapshot.sessions)
      ? (snapshot.sessions as PipelineSession[])
      : [];
    let bytes = Buffer.byteLength(JSON.stringify(record.snapshot), "utf8");
    const exported: PipelineSession[] = [];
    for (const session of sessions) {
      if (bytes > LEGACY_BUILD_PIPELINE_SNAPSHOT_LIMIT_BYTES) {
        return { status: "incompatible", reason: "too-large", bytes };
      }
      const { transcript, legacyStructuredRequestId: _recovered, ...legacy } = session;
      if (!transcript) {
        exported.push(legacy);
        continue;
      }
      const read = await this.readBuildPipelineTranscript(pipelineId, session);
      if (read.status !== "found") {
        return { status: "incompatible", reason: "transcript-unavailable" };
      }
      bytes += Buffer.byteLength(JSON.stringify(read.messages), "utf8");
      exported.push({ ...legacy, messages: read.messages });
    }
    if (bytes > LEGACY_BUILD_PIPELINE_SNAPSHOT_LIMIT_BYTES) {
      return { status: "incompatible", reason: "too-large", bytes };
    }
    return {
      status: "exported",
      record: { ...record, snapshot: { ...(record.snapshot as object), sessions: exported } },
      bytes,
    };
  }
}
