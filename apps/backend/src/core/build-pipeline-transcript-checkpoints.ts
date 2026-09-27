import type { BuildPipeline, PipelineSession } from "@orkestrator/protocol/build-pipeline";
import type {
  TranscriptCommitInput,
  TranscriptCommitResult,
} from "./build-pipeline-transcript-store.js";
import type { TranscriptRead } from "./build-pipeline-transcript-store.js";
import { structuredRequestIdFromMessages } from "./build-pipeline-transcripts.js";
import {
  normalizeTranscriptFingerprint,
  transcriptFingerprint,
} from "./build-pipeline-service-helpers.js";

/** Storage surface the supervisor's transcript checkpoints need. */
export interface BuildPipelineTranscriptStorage {
  commitBuildPipelineTranscript(input: TranscriptCommitInput): Promise<TranscriptCommitResult>;
  readBuildPipelineTranscript(
    pipelineId: string,
    session: Pick<PipelineSession, "sessionKey" | "transcript" | "messages" | "messageRevision">,
    window?: { fromIndex?: number; toIndex?: number },
  ): Promise<TranscriptRead>;
}

interface PendingTranscript {
  sdkSessionId: string;
  messages: readonly unknown[];
  fingerprint: string;
}

/**
 * Newest provider transcripts observed since their last durable checkpoint.
 *
 * Bounded by the number of sessions that changed since their last checkpoint,
 * which is at most the running sessions; the cap only guards pathological
 * fan-in. An evicted entry is not lost: the committed fingerprint still
 * differs from the provider, so the next observation re-detects the change.
 */
const MAX_PENDING_TRANSCRIPTS = 256;
/** Stored messages scanned when a legacy session's request identity must be recovered. */
const RECOVERY_TAIL_MESSAGES = 64;

export interface TranscriptCheckpoint {
  /** Drops the pending copies this checkpoint committed, once the control record referencing them is durable. */
  settle(): void;
}

/**
 * Checkpoints build-pipeline display transcripts ahead of the control record.
 *
 * The supervisor observes provider transcripts every tick but keeps them here
 * rather than on the snapshot it saves. At the save boundary, `prepare`
 * commits every changed transcript (chunks, then manifest) and stamps the
 * session with its new reference, so the control record written afterwards
 * only ever points at committed data. A checkpoint that fails leaves the
 * previous reference in place, keeps the pending copy for the next save, and
 * never blocks the control write: phase transitions, queues, leases and
 * dispatch evidence do not depend on display data. Structured results never
 * came from the display transcript and keep their own durable path.
 */
export class BuildPipelineTranscriptCheckpoints {
  private readonly pending = new Map<string, PendingTranscript>();

  constructor(private readonly storage: BuildPipelineTranscriptStorage) {}

  private key(session: Pick<PipelineSession, "sessionKey" | "sdkSessionId">): string {
    return `${session.sessionKey}\0${session.sdkSessionId}`;
  }

  /** The fingerprint of the committed transcript (legacy forms normalized). */
  committedFingerprint(session: PipelineSession): string | undefined {
    return (
      normalizeTranscriptFingerprint(session.messagesFingerprint) ??
      (Array.isArray(session.messages) ? transcriptFingerprint(session.messages) : undefined)
    );
  }

  /**
   * Records the provider's current transcript. Returns whether it differs from
   * the committed copy — the same "changed since persisted" signal the throttle
   * and stall clock have always used.
   */
  observe(session: PipelineSession, messages: readonly unknown[]): boolean {
    const fingerprint = transcriptFingerprint(messages);
    const key = this.key(session);
    if (fingerprint === this.committedFingerprint(session)) {
      this.pending.delete(key);
      return false;
    }
    this.pending.delete(key);
    this.pending.set(key, { sdkSessionId: session.sdkSessionId, messages, fingerprint });
    while (this.pending.size > MAX_PENDING_TRANSCRIPTS) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    return true;
  }

  /** Newest observed body for a session, when it is newer than the committed one. */
  pendingMessages(session: PipelineSession): readonly unknown[] | undefined {
    return this.pending.get(this.key(session))?.messages;
  }

  /**
   * Request identity for a legacy session that predates `structuredRequestId`,
   * from the newest observed transcript, the unmigrated inline array, or a
   * bounded tail of the stored transcript — in that order. Callers consult
   * the persisted `legacyStructuredRequestId` first; this is only the fallback
   * for a session whose transcript has not been checkpointed with it yet.
   */
  async recoverStructuredRequestId(
    pipelineId: string,
    session: PipelineSession,
  ): Promise<string | undefined> {
    const observed =
      structuredRequestIdFromMessages(this.pendingMessages(session)) ??
      structuredRequestIdFromMessages(session.messages);
    if (observed || !session.transcript) return observed;
    const count = session.transcript.messageCount;
    const tail = await this.storage.readBuildPipelineTranscript(pipelineId, session, {
      fromIndex: Math.max(0, count - RECOVERY_TAIL_MESSAGES),
    });
    return tail.status === "found" ? structuredRequestIdFromMessages(tail.messages) : undefined;
  }

  forget(sessions: readonly Pick<PipelineSession, "sessionKey" | "sdkSessionId">[]): void {
    for (const session of sessions) this.pending.delete(this.key(session));
  }

  /**
   * Commits pending and legacy inline transcripts for `pipeline` and points its
   * sessions at them. Must run before the control record is written.
   */
  async prepare(pipeline: BuildPipeline): Promise<TranscriptCheckpoint> {
    const committed: Array<[string, PendingTranscript]> = [];
    for (const session of pipeline.sessions) {
      const key = this.key(session);
      const pending = this.pending.get(key);
      // Before the body leaves the snapshot, persist the one semantic fact a
      // legacy verification session used to recover from it.
      if (
        session.phase === "verify" &&
        session.structuredRequestId === undefined &&
        session.legacyStructuredRequestId === undefined
      ) {
        const recovered =
          structuredRequestIdFromMessages(pending?.messages) ??
          structuredRequestIdFromMessages(session.messages);
        if (recovered) session.legacyStructuredRequestId = recovered;
      }
      if (pending) {
        if (pending.fingerprint === this.committedFingerprint(session) && session.transcript) {
          committed.push([key, pending]);
          delete session.messages;
          continue;
        }
        const result = await this.commit(pipeline, session, pending.messages, pending.fingerprint);
        if (result.status === "committed") {
          this.apply(session, result);
          committed.push([key, pending]);
        } else if (result.status === "fenced") {
          committed.push([key, pending]);
        } else {
          // Explicit, content-free state: the referenced transcript is behind
          // the provider's. Identifiers only in the log, never transcript text.
          session.transcriptCheckpointError = result.reason.slice(0, 128);
          console.warn(
            `[build-pipeline] Transcript checkpoint deferred for ${pipeline.id}: ${result.reason}`,
          );
        }
        continue;
      }
      if (!Array.isArray(session.messages)) continue;
      // Legacy record read before migration: move its inline body now so the
      // control record this save writes no longer carries it.
      if (session.messages.length === 0 && !session.transcript) {
        delete session.messages;
        continue;
      }
      const messages = session.messages;
      const result = await this.commit(
        pipeline,
        session,
        messages,
        this.committedFingerprint(session) ?? transcriptFingerprint(messages),
        Math.max(session.messageRevision ?? 0, 1),
      );
      if (result.status === "committed") {
        this.apply(session, result);
      } else {
        // Keep the inline body: the legacy format stays readable and bounded
        // by the old snapshot limit until the move succeeds.
        console.warn(
          `[build-pipeline] Legacy transcript move deferred for ${pipeline.id}: ${
            result.status === "fenced" ? "fenced" : result.reason
          }`,
        );
      }
    }
    return {
      settle: () => {
        for (const [key, entry] of committed) {
          if (this.pending.get(key) === entry) this.pending.delete(key);
        }
      },
    };
  }

  private async commit(
    pipeline: BuildPipeline,
    session: PipelineSession,
    messages: readonly unknown[],
    fingerprint: string,
    revision = (session.messageRevision ?? 0) + 1,
  ): Promise<TranscriptCommitResult> {
    try {
      return await this.storage.commitBuildPipelineTranscript({
        pipelineId: pipeline.id,
        sessionKey: session.sessionKey,
        sdkSessionId: session.sdkSessionId,
        messages,
        revision,
        fingerprint,
      });
    } catch (error) {
      // Filesystem errors carry paths; report only a content-free code.
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return {
        status: "rejected",
        reason: typeof code === "string" ? `commit-failed:${code}` : "commit-failed",
      };
    }
  }

  private apply(
    session: PipelineSession,
    result: Extract<TranscriptCommitResult, { status: "committed" }>,
  ): void {
    session.transcript = result.reference;
    session.messageRevision = result.reference.revision;
    session.messagesFingerprint = result.fingerprint;
    delete session.messages;
    delete session.transcriptCheckpointError;
  }

  /**
   * Bounded, explicit transcript input for consumers that need message bodies
   * (the address-issues handoff): the first message plus the newest
   * `tailMessages`, from the newest observed copy when one is pending, else
   * the committed transcript. Never reads more than those two windows.
   */
  async window(
    pipelineId: string,
    session: PipelineSession,
    tailMessages: number,
  ): Promise<{ entries: Array<{ index: number; message: unknown }>; total: number }> {
    const pending = this.pendingMessages(session);
    if (pending) return windowOf(pending, tailMessages);
    const head = await this.storage.readBuildPipelineTranscript(pipelineId, session, {
      fromIndex: 0,
      toIndex: 1,
    });
    if (head.status !== "found") return { entries: [], total: 0 };
    const total = head.messageCount;
    const tailStart = Math.max(1, total - tailMessages);
    const tail =
      tailStart < total
        ? await this.storage.readBuildPipelineTranscript(pipelineId, session, {
            fromIndex: tailStart,
            toIndex: total,
          })
        : null;
    const entries = head.messages.map((message, offset) => ({
      index: head.startIndex + offset,
      message,
    }));
    if (tail?.status === "found") {
      entries.push(
        ...tail.messages.map((message, offset) => ({ index: tail.startIndex + offset, message })),
      );
    }
    return { entries, total };
  }
}

function windowOf(
  messages: readonly unknown[],
  tailMessages: number,
): { entries: Array<{ index: number; message: unknown }>; total: number } {
  const total = messages.length;
  const tailStart = Math.max(1, total - tailMessages);
  const entries: Array<{ index: number; message: unknown }> = [];
  if (total > 0) entries.push({ index: 0, message: messages[0] });
  for (let index = tailStart; index < total; index += 1) {
    entries.push({ index, message: messages[index] });
  }
  return { entries, total };
}
