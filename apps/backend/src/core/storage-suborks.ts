import type { PipelineTranscriptReference } from "@orkestrator/protocol/build-pipeline";
import type { SuborkDeliveryState, SuborkReadOnlyTier } from "@orkestrator/protocol/suborks";
import type { AgentBranchRecord } from "./agent-branch-types.js";
import type { TranscriptRead, TranscriptReadWindow } from "./build-pipeline-transcript-store.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageRepositories } from "./storage-repositories.js";
import { isRecord, nowIso } from "./storage-shared.js";

export const SUBORK_BATCH_VERSION = 1;

/**
 * One subork as stored: the shared branch runner's record, which is durable
 * because the turn it describes outlives this process, plus what the subork is.
 */
export interface PersistedSuborkBranch extends AgentBranchRecord {
  name: string;
  modelLabel?: string;
  /** Exactly what the caller wrote for this target. */
  prompt: string;
  /** Its place among the call's targets. */
  position: number;
  /** The response, within `SUBORK_LIMITS.storedAnswerMaxBytes`. */
  answer?: string;
  /** The response's full size, when `answer` keeps only its start. */
  answerBytes?: number;
  latestAction?: string;
  transcript?: PipelineTranscriptReference;
  readOnly?: SuborkReadOnlyTier;
}

/** A target that never started: unknown, ambiguous, disabled or over a limit. */
export interface PersistedSuborkRefusal {
  id: string;
  name: string;
  position: number;
  error: string;
}

/** One `ask_agents` call. Everything a later process needs is on this row. */
export interface PersistedSuborkBatch {
  version: typeof SUBORK_BATCH_VERSION;
  id: string;
  environmentId: string;
  projectId: string;
  /** The caller's native session storage key. */
  sessionKey: string;
  tabId: string;
  status: "running" | "settled" | "stopped";
  suborks: PersistedSuborkBranch[];
  refused: PersistedSuborkRefusal[];
  delivery: SuborkDeliveryState;
  deliveryDetail?: string;
  /** The delivered mail, so a Stop can still withdraw it before it wakes the caller. */
  deliveryMessageId?: string;
  /** Suborks this session had started once this call was admitted. */
  sessionStartedTotal: number;
  /** Compare-and-swap revision; 1 on the first save. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  settledAt?: string;
}

/** A refused write: the stored call moved on, usually because a person stopped it. */
export class SuborkStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuborkStorageError";
  }
}

function isPersistedSuborkBatch(value: unknown): value is PersistedSuborkBatch {
  return (
    isRecord(value) &&
    value.version === SUBORK_BATCH_VERSION &&
    typeof value.id === "string" &&
    typeof value.environmentId === "string" &&
    typeof value.sessionKey === "string" &&
    Array.isArray(value.suborks) &&
    Array.isArray(value.refused) &&
    Number.isSafeInteger(value.revision)
  );
}

/** A batch's transcripts share one owner in the content-addressed transcript store. */
function transcriptOwner(batchId: string): string {
  return `subork:${batchId}`;
}

/**
 * The `native-agent-suborks` store: one row per `ask_agents` call, owned by its
 * environment. Every write is one `updateStoreRow` transaction, and a pass's
 * save checks the revision it read, so a Stop committed while a pass is running
 * fences that pass rather than being overwritten by it.
 */
export class SuborksRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly repos: StorageRepositories,
  ) {}

  private file(): string {
    return this.context.file("native-agent-suborks.json");
  }

  getSuborkBatch(batchId: string): PersistedSuborkBatch | null {
    const stored = this.context.loadStoreRow(this.file(), batchId);
    return isPersistedSuborkBatch(stored) ? stored : null;
  }

  /** Every readable call (startup recovery). */
  async listSuborkBatches(): Promise<PersistedSuborkBatch[]> {
    const stored = await this.context.loadJson<Record<string, unknown>>(this.file(), () => ({}));
    return Object.values(stored).filter(isPersistedSuborkBatch);
  }

  /** Stores a new call at revision 1. A row already there is returned untouched. */
  createSuborkBatch(batch: PersistedSuborkBatch): PersistedSuborkBatch {
    return this.context.updateStoreRow<PersistedSuborkBatch>(this.file(), batch.id, (current) => {
      if (isPersistedSuborkBatch(current)) return { result: current };
      const now = nowIso();
      const next: PersistedSuborkBatch = { ...batch, revision: 1, createdAt: now, updatedAt: now };
      return { result: next, value: next };
    });
  }

  /** Saves `batch` when the stored row is still at `batch.revision`. */
  saveSuborkBatch(batch: PersistedSuborkBatch): PersistedSuborkBatch {
    return this.context.updateStoreRow<PersistedSuborkBatch>(this.file(), batch.id, (current) => {
      if (!isPersistedSuborkBatch(current) || current.revision !== batch.revision) {
        throw new SuborkStorageError("The subork call changed since it was read");
      }
      const next: PersistedSuborkBatch = {
        ...batch,
        revision: batch.revision + 1,
        updatedAt: nowIso(),
      };
      return { result: next, value: next };
    });
  }

  /** Reads, changes and writes one row; `undefined` from `change` leaves it alone. */
  updateSuborkBatch(
    batchId: string,
    change: (batch: PersistedSuborkBatch) => PersistedSuborkBatch | undefined,
  ): PersistedSuborkBatch | null {
    return this.context.updateStoreRow<PersistedSuborkBatch | null>(
      this.file(),
      batchId,
      (current) => {
        if (!isPersistedSuborkBatch(current)) return { result: null };
        const changed = change(current);
        if (!changed) return { result: current };
        const next: PersistedSuborkBatch = {
          ...changed,
          revision: current.revision + 1,
          updatedAt: nowIso(),
        };
        return { result: next, value: next };
      },
    );
  }

  /** Removes one call with its transcripts. */
  async deleteSuborkBatch(batchId: string): Promise<void> {
    this.context.updateStoreRow<boolean>(this.file(), batchId, (current) =>
      current === undefined ? { result: false } : { result: true, delete: true },
    );
    await this.repos.buildPipelines
      .deleteGraphRunTranscripts(transcriptOwner(batchId))
      .catch(() => undefined);
  }

  /** Environment deletion: removes every call it owned. */
  async deleteSuborkBatchesByEnvironment(environmentId: string): Promise<void> {
    for (const batch of await this.listSuborkBatches()) {
      if (batch.environmentId === environmentId) await this.deleteSuborkBatch(batch.id);
    }
  }

  commitSuborkTranscript(input: {
    batchId: string;
    suborkId: string;
    sdkSessionId: string;
    messages: readonly unknown[];
    revision: number;
    fingerprint: string;
  }): Promise<PipelineTranscriptReference | null> {
    const { batchId, suborkId, ...rest } = input;
    return this.repos.buildPipelines.commitGraphRunTranscript({
      runId: transcriptOwner(batchId),
      activationKey: suborkId,
      ...rest,
    });
  }

  describeSuborkTranscript(
    batchId: string,
    suborkId: string,
  ): Promise<{ reference: PipelineTranscriptReference; fingerprint: string } | null> {
    return this.repos.buildPipelines.describeGraphRunTranscript(transcriptOwner(batchId), suborkId);
  }

  readSuborkTranscript(
    batchId: string,
    suborkId: string,
    reference: PipelineTranscriptReference,
    window: TranscriptReadWindow = {},
  ): Promise<TranscriptRead> {
    return this.repos.buildPipelines.readGraphRunTranscript(
      transcriptOwner(batchId),
      suborkId,
      reference,
      window,
    );
  }
}

/** What callers reach as `storage.suborks`. */
export type SuborksStorage = Pick<
  SuborksRepository,
  | "getSuborkBatch"
  | "listSuborkBatches"
  | "createSuborkBatch"
  | "saveSuborkBatch"
  | "updateSuborkBatch"
  | "deleteSuborkBatch"
  | "deleteSuborkBatchesByEnvironment"
  | "commitSuborkTranscript"
  | "describeSuborkTranscript"
  | "readSuborkTranscript"
>;
