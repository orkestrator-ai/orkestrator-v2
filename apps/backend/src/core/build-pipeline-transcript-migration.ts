import type { PipelineTranscriptReference } from "@orkestrator/protocol/build-pipeline";
import type { PersistedBuildPipeline } from "./models.js";
import type {
  BuildPipelineTranscriptFaultStage,
  BuildPipelineTranscriptStore,
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
 * One-time move of legacy inline transcripts out of `build-pipelines.json`
 * (plan step 16).
 *
 * Per pipeline, idempotently:
 *
 * 1. Import every inline session transcript into the transcript store, tagged
 *    with the control revision it was read from. Chunks are content-addressed
 *    and an identical manifest is reused, so a retried import writes nothing.
 * 2. Verify the committed manifest by reading it back (chunk lengths,
 *    checksums and per-chunk message counts).
 * 3. Under the cross-process build-pipeline lock, replace the inline arrays
 *    with references — only if the record's revision still equals the one the
 *    import read. A concurrent supervisor write wins; that pipeline is retried
 *    on a later pass (and the new writer migrates it itself on its next save).
 *
 * The control revision is deliberately left unchanged: the workflow state is
 * identical and only its transcript representation moved, so a supervisor
 * pass holding the old representation still commits (its own save migrates
 * the same content idempotently) and renderer cursors stay valid. Control
 * writes are batched so a large legacy file is not rewritten once per
 * pipeline; each pipeline is still checked individually.
 *
 * A pipeline deleted while its import ran is fenced by the delete and its
 * freshly imported transcripts are removed here; a crash in between leaves
 * orphans for the startup sweep. The legacy inline copies in the control
 * file's rotating backups age out after five further control writes, and a
 * pipeline deletion scrubs them immediately.
 */
export interface BuildPipelineTranscriptMigrationReport {
  migrated: number;
  sessions: number;
  deferred: number;
  orphaned: number;
  remaining: number;
}

interface ImportedSession {
  sdkSessionId: string;
  count: number;
  reference?: PipelineTranscriptReference;
  fingerprint?: string;
  recoveredRequestId?: string;
}

interface ImportedPipeline {
  sourceRevision: number;
  sessions: Map<string, ImportedSession>;
}

export interface BuildPipelineTranscriptMigrationDeps {
  store: BuildPipelineTranscriptStore;
  load: () => Promise<Readonly<Record<string, PersistedBuildPipeline>>>;
  /** Runs under the build-pipeline lock; returns whether `pipelines` changed. */
  commitControl: (
    operation: (pipelines: Record<string, PersistedBuildPipeline>) => Promise<boolean>,
  ) => Promise<void>;
  fault: (stage: BuildPipelineTranscriptFaultStage, key: string) => Promise<void>;
  maxPipelinesPerBatch?: number;
  /** Checked between batches so shutdown is not held behind a large legacy file. */
  shouldContinue?: () => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function importPipeline(
  store: BuildPipelineTranscriptStore,
  record: PersistedBuildPipeline,
): Promise<ImportedPipeline | null> {
  const snapshot = record.snapshot as { sessions?: unknown };
  const sessions = new Map<string, ImportedSession>();
  for (const session of Array.isArray(snapshot.sessions) ? snapshot.sessions : []) {
    if (!isRecord(session) || !Array.isArray(session.messages)) continue;
    const { sessionKey, sdkSessionId, messages } = session;
    if (typeof sessionKey !== "string" || typeof sdkSessionId !== "string" || !sessionKey) {
      return null;
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
    const committed = await store.commit({
      pipelineId: record.id,
      sessionKey,
      sdkSessionId,
      messages,
      revision,
      fingerprint,
      sourceRevision: record.revision,
    });
    if (committed.status !== "committed") return null;
    const verified = await store.read(record.id, sessionKey, committed.reference);
    if (
      verified.status !== "found" ||
      verified.substituted ||
      verified.messageCount !== committed.reference.messageCount ||
      verified.messages.length !== committed.reference.messageCount
    ) {
      return null;
    }
    const recoveredRequestId =
      session.phase === "verify" && typeof session.structuredRequestId !== "string"
        ? structuredRequestIdFromMessages(messages)
        : undefined;
    sessions.set(sessionKey, {
      sdkSessionId,
      count: messages.length,
      reference: committed.reference,
      fingerprint: committed.fingerprint,
      ...(recoveredRequestId ? { recoveredRequestId } : {}),
    });
  }
  return { sourceRevision: record.revision, sessions };
}

function applyImport(snapshot: unknown, imported: ImportedPipeline): unknown {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.sessions)) return snapshot;
  return {
    ...snapshot,
    sessions: snapshot.sessions.map((session: unknown) => {
      if (!isRecord(session) || !Array.isArray(session.messages)) return session;
      const entry =
        typeof session.sessionKey === "string"
          ? imported.sessions.get(session.sessionKey)
          : undefined;
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
    const imported = new Map<string, ImportedPipeline>();
    for (const record of candidates.slice(0, batchSize)) {
      attempted.add(record.id);
      const result = await importPipeline(deps.store, record);
      if (result) imported.set(record.id, result);
      else report.deferred += 1;
    }
    await deps.fault("migration-after-import", "batch");
    const orphans: string[] = [];
    await deps.commitControl(async (pipelines) => {
      let changed = false;
      for (const [pipelineId, entry] of imported) {
        const current = pipelines[pipelineId];
        if (!current) {
          orphans.push(pipelineId);
          continue;
        }
        if (current.revision !== entry.sourceRevision) {
          report.deferred += 1;
          continue;
        }
        pipelines[pipelineId] = { ...current, snapshot: applyImport(current.snapshot, entry) };
        report.migrated += 1;
        report.sessions += [...entry.sessions.values()].filter(
          (session) => session.reference,
        ).length;
        changed = true;
      }
      return changed;
    });
    for (const pipelineId of orphans) {
      await deps.store.deletePipeline(pipelineId);
      report.orphaned += 1;
    }
  }
  report.remaining = Object.values(await deps.load()).filter((record) =>
    hasInlineTranscript(record.snapshot),
  ).length;
  return report;
}
