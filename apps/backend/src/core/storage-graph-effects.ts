import { createHash } from "node:crypto";
import { isGraphRunId } from "@orkestrator/protocol/graphs/run";
import {
  GRAPH_SYSTEM_ACTIONS,
  type GraphSystemAction,
} from "@orkestrator/protocol/graphs/template";
import { GraphStorageError } from "./graph-run-errors.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageRepositories } from "./storage-repositories.js";
import { isRecord, nowIso } from "./storage-shared.js";

export const GRAPH_EFFECT_FORMAT_VERSION = 1;
/** Longest effect key (`push:<branch>:<sha>` and the like). */
export const GRAPH_EFFECT_MAX_KEY_CHARS = 512;
/** Serialized bytes of an effect's replay data. */
export const GRAPH_EFFECT_MAX_DATA_BYTES = 64 * 1024;
const MAX_ERROR_CHARS = 2_000;

/**
 * `intended`: recorded before the effect, not yet known to have happened.
 * `done`: happened; its data is what a retry or restart replays. `failed`:
 * did not happen (the next attempt tries again). `simulated`: a mock run's
 * "would have run" record (item 213): the effect never happens, and its data
 * (`{ wouldRun }`, `GraphMockWouldRun`) says what it would have done.
 */
export type GraphEffectState = "intended" | "done" | "failed" | "simulated";

/** One side effect of a run's system nodes (item 207), journaled around the effect. */
export interface GraphEffectRecord {
  effectFormatVersion: typeof GRAPH_EFFECT_FORMAT_VERSION;
  /** `effect:<sha256 of the key>`: the row's id inside the run. */
  id: string;
  runId: string;
  key: string;
  action: GraphSystemAction;
  nodeId: string;
  /** The activation that recorded the current intent. */
  activation: string;
  state: GraphEffectState;
  /** Intents recorded: 1, plus one per retry or recovery that found it unfinished. */
  attempts: number;
  /** The backend process that recorded the current intent (`graph-node-system.ts`). */
  owner: string;
  intendedAt: string;
  settledAt?: string;
  /** Bounded JSON the action replays or recovers from: a URL, a commit, a run id. */
  data?: Record<string, unknown>;
  /** Why it failed, bounded and content-free. */
  error?: string;
}

export interface GraphEffectIntent {
  runId: string;
  key: string;
  action: GraphSystemAction;
  nodeId: string;
  activation: string;
  owner: string;
  /** Recorded with the intent (kept when an earlier intent recorded some). */
  data?: Record<string, unknown>;
}

/**
 * What {@link GraphEffectsRepository.beginGraphEffect} found before it
 * recorded the intent: nothing, a settled effect, or an unsettled intent
 * (`previous` names its state and `previousOwner` who recorded it).
 */
export interface GraphEffectBegin {
  record: GraphEffectRecord;
  previous: GraphEffectState | null;
  previousOwner?: string;
}

export function graphEffectRowId(key: string): string {
  return `effect:${createHash("sha256").update(key, "utf8").digest("hex")}`;
}

function effectRowKey(runId: string, key: string): string {
  return `${runId}/${graphEffectRowId(key)}`;
}

function checkKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.length > GRAPH_EFFECT_MAX_KEY_CHARS) {
    throw new GraphStorageError("invalid-artifact", "Invalid graph effect key");
  }
}

function checkData(data: Record<string, unknown> | undefined): void {
  if (data === undefined) return;
  const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (bytes > GRAPH_EFFECT_MAX_DATA_BYTES) {
    throw new GraphStorageError("value-bytes", "A graph effect's data is too large", {
      limit: GRAPH_EFFECT_MAX_DATA_BYTES,
      actual: bytes,
    });
  }
}

export function isGraphEffectRecord(value: unknown): value is GraphEffectRecord {
  return (
    isRecord(value) &&
    value.effectFormatVersion === GRAPH_EFFECT_FORMAT_VERSION &&
    typeof value.id === "string" &&
    typeof value.runId === "string" &&
    typeof value.key === "string" &&
    (GRAPH_SYSTEM_ACTIONS as readonly unknown[]).includes(value.action) &&
    typeof value.nodeId === "string" &&
    typeof value.activation === "string" &&
    (value.state === "intended" ||
      value.state === "done" ||
      value.state === "failed" ||
      value.state === "simulated") &&
    Number.isSafeInteger(value.attempts) &&
    typeof value.owner === "string" &&
    typeof value.intendedAt === "string" &&
    (value.data === undefined || isRecord(value.data))
  );
}

/**
 * The effect journal of graph system nodes (item 207): one row per side
 * effect, written before the effect (`intended`) and after it (`done` or
 * `failed`), keyed per run by the action's idempotency key. A retry or a
 * restart that finds `done` replays the recorded data instead of acting; one
 * that finds an unsettled intent asks the action whether the effect happened
 * before acting again.
 *
 * Rows live in the `graph-artifacts` record store beside the run's artifacts
 * (`<run>/effect:<sha256 of the key>`, owned by the run), so environment
 * deletion removes them with the run's artifact rows. They carry
 * `effectFormatVersion`, not the artifact `formatVersion`, so artifact reads
 * never see them. Writes share the graph runs' lease and refuse a run whose
 * environment is missing or being deleted.
 */
export class GraphEffectsRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly repos: StorageRepositories,
  ) {}

  private graphArtifactsFile(): string {
    return this.context.file("graph-artifacts.json");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    // The graph runs' lease: run, artifact and effect writes serialize with deletion.
    return this.context.serialize(
      this.context.file("graph-runs.json"),
      "graph run storage",
      operation,
    );
  }

  private async assertRunWritable(runId: string): Promise<void> {
    const run = await this.repos.graphRuns.getGraphRun(runId);
    if (!run) throw new GraphStorageError("run-not-found", "The graph run does not exist");
    if (run.environmentId === undefined) return;
    const environment = await this.repos.projects.getEnvironment(run.environmentId);
    if (!environment) {
      throw new GraphStorageError("environment-not-found", "The run's environment does not exist");
    }
    if (environment.deletionRequestedAt || environment.lifecycleOperation === "deleting") {
      throw new GraphStorageError("environment-deleting", "The run's environment is being deleted");
    }
  }

  private read(runId: string, key: string): GraphEffectRecord | null {
    const stored = this.context.loadStoreRow(this.graphArtifactsFile(), effectRowKey(runId, key));
    return isGraphEffectRecord(stored) && stored.runId === runId && stored.key === key
      ? stored
      : null;
  }

  /** One effect of a run; null when none was recorded. */
  async getGraphEffect(runId: string, key: string): Promise<GraphEffectRecord | null> {
    if (!isGraphRunId(runId)) return null;
    checkKey(key);
    return this.read(runId, key);
  }

  /** Every effect of a run, oldest first. */
  async listGraphEffects(runId: string): Promise<GraphEffectRecord[]> {
    if (!isGraphRunId(runId)) return [];
    return this.context
      .loadStoreRowsByOwner<unknown>(this.graphArtifactsFile(), runId)
      .filter((row): row is GraphEffectRecord => isGraphEffectRecord(row) && row.runId === runId)
      .sort(
        (left, right) =>
          left.intendedAt.localeCompare(right.intendedAt) || left.key.localeCompare(right.key),
      );
  }

  /**
   * Records the intent to perform an effect, unless it is already `done`
   * (returned as is). An unsettled or failed one is claimed again: its
   * activation and owner are replaced and `attempts` grows; data recorded
   * earlier is kept unless new data is given.
   */
  async beginGraphEffect(intent: GraphEffectIntent): Promise<GraphEffectBegin> {
    if (!isGraphRunId(intent.runId)) {
      throw new GraphStorageError("run-not-found", "Invalid run id");
    }
    checkKey(intent.key);
    checkData(intent.data);
    return this.enqueue(async () => {
      await this.assertRunWritable(intent.runId);
      return this.context.updateStoreRow<GraphEffectBegin>(
        this.graphArtifactsFile(),
        effectRowKey(intent.runId, intent.key),
        (current) => {
          const now = nowIso();
          if (isGraphEffectRecord(current) && current.key === intent.key) {
            if (current.state === "done") {
              return {
                result: { record: current, previous: "done", previousOwner: current.owner },
              };
            }
            const { error: _error, settledAt: _settledAt, ...kept } = current;
            const record: GraphEffectRecord = {
              ...kept,
              activation: intent.activation,
              nodeId: intent.nodeId,
              state: "intended",
              attempts: current.attempts + 1,
              owner: intent.owner,
              intendedAt: now,
              ...(intent.data ? { data: intent.data } : {}),
            };
            return {
              result: { record, previous: current.state, previousOwner: current.owner },
              value: record,
            };
          }
          const record: GraphEffectRecord = {
            effectFormatVersion: GRAPH_EFFECT_FORMAT_VERSION,
            id: graphEffectRowId(intent.key),
            runId: intent.runId,
            key: intent.key,
            action: intent.action,
            nodeId: intent.nodeId,
            activation: intent.activation,
            state: "intended",
            attempts: 1,
            owner: intent.owner,
            intendedAt: now,
            ...(intent.data ? { data: intent.data } : {}),
          };
          return { result: { record, previous: null }, value: record };
        },
      );
    });
  }

  /**
   * Records a mock run's "would have run" effect (state `simulated`, settled
   * at once). Idempotent per key: a record already there is returned as is,
   * so a restarted mock activation does not record twice. Refused for a run
   * that is not a mock run.
   */
  async recordSimulatedGraphEffect(
    intent: GraphEffectIntent & { data: Record<string, unknown> },
  ): Promise<GraphEffectRecord> {
    if (!isGraphRunId(intent.runId)) {
      throw new GraphStorageError("run-not-found", "Invalid run id");
    }
    checkKey(intent.key);
    checkData(intent.data);
    return this.enqueue(async () => {
      const run = await this.repos.graphRuns.getGraphRun(intent.runId);
      if (!run) throw new GraphStorageError("run-not-found", "The graph run does not exist");
      if (!run.mock) {
        throw new GraphStorageError("invalid-run", "Only a mock run records simulated effects");
      }
      await this.assertRunWritable(intent.runId);
      return this.context.updateStoreRow<GraphEffectRecord>(
        this.graphArtifactsFile(),
        effectRowKey(intent.runId, intent.key),
        (current) => {
          if (isGraphEffectRecord(current) && current.key === intent.key) {
            return { result: current };
          }
          const now = nowIso();
          const record: GraphEffectRecord = {
            effectFormatVersion: GRAPH_EFFECT_FORMAT_VERSION,
            id: graphEffectRowId(intent.key),
            runId: intent.runId,
            key: intent.key,
            action: intent.action,
            nodeId: intent.nodeId,
            activation: intent.activation,
            state: "simulated",
            attempts: 1,
            owner: intent.owner,
            intendedAt: now,
            settledAt: now,
            data: intent.data,
          };
          return { result: record, value: record };
        },
      );
    });
  }

  /**
   * Settles a recorded intent. `done` keeps `data` (merged over what the
   * intent recorded) for replays; `failed` keeps a bounded error. A `done`
   * effect never changes again.
   */
  async settleGraphEffect(
    runId: string,
    key: string,
    outcome: { state: "done"; data?: Record<string, unknown> } | { state: "failed"; error: string },
  ): Promise<GraphEffectRecord> {
    checkKey(key);
    if (outcome.state === "done") checkData(outcome.data);
    return this.enqueue(async () =>
      this.context.updateStoreRow<GraphEffectRecord>(
        this.graphArtifactsFile(),
        effectRowKey(runId, key),
        (current) => {
          if (!isGraphEffectRecord(current) || current.key !== key || current.runId !== runId) {
            throw new GraphStorageError("artifact-not-found", "The graph effect was not recorded");
          }
          if (current.state === "done") return { result: current };
          const settledAt = nowIso();
          const record: GraphEffectRecord =
            outcome.state === "done"
              ? {
                  ...current,
                  state: "done",
                  settledAt,
                  ...(outcome.data || current.data
                    ? { data: { ...current.data, ...outcome.data } }
                    : {}),
                }
              : {
                  ...current,
                  state: "failed",
                  settledAt,
                  error: outcome.error.slice(0, MAX_ERROR_CHARS),
                };
          checkData(record.data);
          return { result: record, value: record };
        },
      ),
    );
  }
}

/** The effect journal's entry points code outside the storage files calls. */
export type GraphEffectsStorage = Pick<
  GraphEffectsRepository,
  | "getGraphEffect"
  | "listGraphEffects"
  | "beginGraphEffect"
  | "settleGraphEffect"
  | "recordSimulatedGraphEffect"
>;
