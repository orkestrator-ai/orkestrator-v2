import type { PipelineTranscriptReference } from "@orkestrator/protocol/build-pipeline";
import type { PersistedBuildPipeline } from "./models.js";
import type {
  BuildPipelineTranscriptFaultStage,
  BuildPipelineTranscriptStore,
  StagedTranscript,
} from "./build-pipeline-transcript-store.js";
import {
  hasInlineTranscript,
  structuredRequestIdFromMessages,
} from "./build-pipeline-transcripts.js";
import {
  normalizeTranscriptFingerprint,
  transcriptFingerprint,
} from "./build-pipeline-service-helpers.js";

/**
 * One-time move of legacy inline transcripts out of the `build-pipelines`
 * control records (plan step 16).
 *
 * Per pipeline, idempotently:
 *
 * 1. Stage every inline session transcript: chunk files are written and
 *    fsynced, the manifest is held for the commit, tagged with the control
 *    revision it was read from. Chunks are content-addressed, so a retried
 *    import writes nothing new.
 * 2. Verify every staged manifest by reading its chunks back (lengths,
 *    checksums and per-chunk message counts).
 * 3. In ONE database transaction per batch (under the build-pipeline lease),
 *    for each pipeline whose control revision still equals the one the import
 *    read: commit its manifest rows and replace the inline arrays with
 *    references. A pipeline whose manifests cannot all commit (quota, a
 *    concurrent checkpoint) keeps its inline body and is retried later. A
 *    concurrent supervisor write wins; that pipeline is retried on a later
 *    pass (and the writer migrates it itself on its next save).
 *
 * The control revision is deliberately left unchanged: the workflow state is
 * identical and only its transcript representation moved, so a supervisor
 * pass holding the old representation still commits (its own save migrates
 * the same content idempotently) and renderer cursors stay valid. A pipeline
 * deleted while its import ran simply has no control row at commit time: its
 * staged chunks are unlinked, nothing is committed.
 */
export interface BuildPipelineTranscriptMigrationReport {
  migrated: number;
  sessions: number;
  deferred: number;
  orphaned: number;
  remaining: number;
  /** The background import of pre-database manifest files. */
  legacyManifests?: { imported: number; complete: boolean };
}

interface ImportedSession {
  sdkSessionId: string;
  count: number;
  reference?: PipelineTranscriptReference;
  fingerprint?: string;
  recoveredRequestId?: string;
}

export interface InlineImportBatchEntry {
  pipelineId: string;
  sourceRevision: number;
  /** Manifests to commit with the control row (sessions whose content was already committed have none). */
  staged: readonly StagedTranscript[];
  /** The snapshot with inline arrays replaced by references. */
  apply: (snapshot: unknown) => unknown;
}

export interface InlineImportBatchOutcome {
  migrated: string[];
  /** The control revision moved since the import read it. */
  conflicted: string[];
  /** The pipeline was deleted meanwhile. */
  missing: string[];
  /** A manifest could not commit (quota, a concurrent checkpoint). */
  refused: string[];
}

export interface BuildPipelineTranscriptMigrationDeps {
  store: BuildPipelineTranscriptStore;
  load: () => Promise<Readonly<Record<string, PersistedBuildPipeline>>>;
  /**
   * Commits a batch in one transaction under the build-pipeline lease, then
   * settles the committed manifests (unlinking chunks they replaced).
   */
  commitBatch: (entries: readonly InlineImportBatchEntry[]) => Promise<InlineImportBatchOutcome>;
  fault: (stage: BuildPipelineTranscriptFaultStage, key: string) => Promise<void>;
  maxPipelinesPerBatch?: number;
  /** Checked between batches so shutdown is not held behind a large legacy store. */
  shouldContinue?: () => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function importPipeline(
  store: BuildPipelineTranscriptStore,
  record: PersistedBuildPipeline,
): Promise<InlineImportBatchEntry | null> {
  const snapshot = record.snapshot as { sessions?: unknown };
  const sessions = new Map<string, ImportedSession>();
  const staged: StagedTranscript[] = [];
  const abandon = async () => {
    await store.discard(staged);
    return null;
  };
  for (const session of Array.isArray(snapshot.sessions) ? snapshot.sessions : []) {
    if (!isRecord(session) || !Array.isArray(session.messages)) continue;
    const { sessionKey, sdkSessionId, messages } = session;
    if (typeof sessionKey !== "string" || typeof sdkSessionId !== "string" || !sessionKey) {
      return abandon();
    }
    if (messages.length === 0) {
      sessions.set(sessionKey, { sdkSessionId, count: 0 });
      continue;
    }
    const storedFingerprint =
      typeof session.messagesFingerprint === "string" ? session.messagesFingerprint : undefined;
    const fingerprint =
      normalizeTranscriptFingerprint(storedFingerprint) ?? transcriptFingerprint(messages);
    const revision =
      typeof session.messageRevision === "number" && session.messageRevision > 0
        ? session.messageRevision
        : 1;
    const result = await store.stage({
      pipelineId: record.id,
      sessionKey,
      sdkSessionId,
      messages,
      revision,
      fingerprint,
      sourceRevision: record.revision,
    });
    // The legacy body is the last complete copy. Never discard it when
    // retention had to omit a message during import.
    if (result.status !== "staged" || !result.reference.complete) return abandon();
    if (result.staged) {
      staged.push(result.staged);
      if (!(await store.verifyStaged(result.staged))) return abandon();
    } else {
      // Identical content already committed (a retried import): verify that copy.
      const verified = await store.read(record.id, sessionKey, result.reference);
      if (
        verified.status !== "found" ||
        verified.substituted ||
        verified.messages.length !== result.reference.messageCount
      ) {
        return abandon();
      }
    }
    const recoveredRequestId =
      session.phase === "verify" && typeof session.structuredRequestId !== "string"
        ? structuredRequestIdFromMessages(messages)
        : undefined;
    sessions.set(sessionKey, {
      sdkSessionId,
      count: messages.length,
      reference: result.reference,
      fingerprint: result.fingerprint,
      ...(recoveredRequestId ? { recoveredRequestId } : {}),
    });
  }
  return {
    pipelineId: record.id,
    sourceRevision: record.revision,
    staged,
    apply: (current) => applyImport(current, sessions),
  };
}

function applyImport(snapshot: unknown, imported: ReadonlyMap<string, ImportedSession>): unknown {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.sessions)) return snapshot;
  return {
    ...snapshot,
    sessions: snapshot.sessions.map((session: unknown) => {
      if (!isRecord(session) || !Array.isArray(session.messages)) return session;
      const entry =
        typeof session.sessionKey === "string" ? imported.get(session.sessionKey) : undefined;
      if (
        !entry ||
        session.sdkSessionId !== entry.sdkSessionId ||
        session.messages.length !== entry.count
      ) {
        return session;
      }
      const { messages: _messages, ...rest } = session;
      if (!entry.reference) return rest;
      return {
        ...rest,
        transcript: entry.reference,
        messageRevision: entry.reference.revision,
        messagesFingerprint: entry.fingerprint,
        ...(entry.recoveredRequestId
          ? { legacyStructuredRequestId: entry.recoveredRequestId }
          : {}),
      };
    }),
  };
}

export async function migrateInlineBuildPipelineTranscripts(
  deps: BuildPipelineTranscriptMigrationDeps,
): Promise<BuildPipelineTranscriptMigrationReport> {
  const report: BuildPipelineTranscriptMigrationReport = {
    migrated: 0,
    sessions: 0,
    deferred: 0,
    orphaned: 0,
    remaining: 0,
  };
  const batchSize = Math.max(1, deps.maxPipelinesPerBatch ?? 8);
  const attempted = new Set<string>();
  while (deps.shouldContinue?.() ?? true) {
    const records = await deps.load();
    const candidates = Object.values(records).filter(
      (record) => !attempted.has(record.id) && hasInlineTranscript(record.snapshot),
    );
    if (candidates.length === 0) break;
    const entries: InlineImportBatchEntry[] = [];
    for (const record of candidates.slice(0, batchSize)) {
      attempted.add(record.id);
      const entry = await importPipeline(deps.store, record);
      if (entry) entries.push(entry);
      else report.deferred += 1;
    }
    // A throw here commits nothing of this batch. Its staged chunks stay on
    // disk for a retry to reuse; repair collects them if none comes.
    await deps.fault("migration-after-import", "batch");
    const outcome = await deps.commitBatch(entries);
    const committed = new Set(outcome.migrated);
    await deps.store.discard(
      entries.filter((entry) => !committed.has(entry.pipelineId)).flatMap((entry) => entry.staged),
    );
    report.migrated += outcome.migrated.length;
    report.deferred += outcome.conflicted.length + outcome.refused.length;
    report.orphaned += outcome.missing.length;
    for (const entry of entries) {
      if (!committed.has(entry.pipelineId)) continue;
      const snapshot = records[entry.pipelineId]?.snapshot as { sessions?: unknown } | undefined;
      const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
      report.sessions += sessions.filter(
        (session: unknown) =>
          isRecord(session) && Array.isArray(session.messages) && session.messages.length > 0,
      ).length;
    }
  }
  report.remaining = Object.values(await deps.load()).filter((record) =>
    hasInlineTranscript(record.snapshot),
  ).length;
  return report;
}
