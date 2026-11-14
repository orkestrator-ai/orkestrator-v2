import { isDeepStrictEqual } from "node:util";
import {
  DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
  applyNativeAgentTranscriptDelta,
  type NativeAgentTranscriptUpdate,
  type NativeAgentTranscriptView,
} from "@orkestrator/protocol/native-agent";

export type Row = { id?: unknown; role?: unknown; content?: unknown; parts?: unknown };
type UpdateStatus = "snapshot" | "delta" | "unchanged" | "missing" | "unavailable";
export type BackgroundTask = { id: string; status: string; toolUseId?: string; summary?: string };
type StateUpdate = {
  status: UpdateStatus;
  token?: string;
  value?: { turn: { phase: string; error?: string }; backgroundTasks?: BackgroundTask[] };
};
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Identity = { environmentId: string; agent: "claude"; logicalSessionKey: string };
const TRANSCRIPT_COMMAND = "get_native_agent_transcript_update";
const STATE_COMMAND = "get_native_agent_session_state_update";
const TOOL_DETAILS_COMMAND = "get_native_agent_tool_details";
/** Shape records kept per reader; later changes are counted, not kept. */
export const LAUNCH_ROW_SHAPE_LIMIT = 200;
/** Distinct detail references resolved per row; later ones record no length. */
export const LAUNCH_ROW_DETAIL_REF_LIMIT = 32;

/**
 * The content-free shape of one background task's launching tool row, written
 * each time it changes (5040). It separates a row that never receives the
 * final output from a detail reference that still resolves to the launch
 * placeholder, and from a notification that carries less than it used to.
 * Tasks are numbered in the order the reader first saw them; no task id, tool
 * id, detail reference, output or summary text is kept, only lengths.
 */
export type LaunchRowShape = {
  /** Milliseconds since the reader's first shape record. */
  atMs: number;
  /** 1-based, in the order the reader first saw the task. */
  task: number;
  taskStatus: string;
  phase?: string;
  row: "present" | "absent";
  toolName?: string;
  toolState?: string;
  hasDetailRef: boolean;
  /** How many distinct detail references this row has carried so far. */
  detailRefs: number;
  /** Length of the row's output, inline or behind its reference; null when unreadable. */
  outputLength: number | null;
  summaryLength: number;
};

/** What `expectTaskOutput` compared, without the compared text. */
export type LaunchRowCheck = {
  task: number | null;
  row: "present" | "absent";
  toolState?: string;
  hasDetailRef: boolean;
  outputLength: number | null;
  containsOutput: boolean;
  containsSummary: boolean;
  summaryLength: number;
};

/** The content-free launching-row evidence the live spec writes as one annotation. */
export type LaunchRowEvidence = {
  shapes: LaunchRowShape[];
  droppedShapes: number;
  check: LaunchRowCheck | null;
};

type LaunchRowTrack = {
  ordinal: number;
  detailRefs: Map<string, number | null>;
  last?: string;
};

// Failures deliberately report no transcript, tool output, tokens or task ids.
function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function rowText(row: Row): string {
  if (typeof row.content === "string" && row.content) return row.content;
  if (!Array.isArray(row.parts)) return "";
  return row.parts
    .map((part) => {
      const { text, content } = (part ?? {}) as {
        text?: unknown;
        content?: unknown;
      };
      return typeof text === "string" ? text : typeof content === "string" ? content : "";
    })
    .join("");
}

/** The conditional view is authoritative for qualification; forced reads never repair it. */
export class TokenReader {
  transcriptToken: string | undefined;
  transcript: NativeAgentTranscriptView<Row> | undefined;
  stateToken: string | undefined;
  phase: string | undefined;
  tasks: BackgroundTask[] = [];
  readonly log: Array<{
    at: number;
    transcript: UpdateStatus;
    state: UpdateStatus;
    phase?: string;
    tasks: string;
  }> = [];
  /** Content-free launching-row history, one record per change (5040). */
  readonly launchRowShapes: LaunchRowShape[] = [];
  /** Changes past `LAUNCH_ROW_SHAPE_LIMIT`, counted rather than kept. */
  droppedLaunchRowShapes = 0;
  /** The last `expectTaskOutput` comparison, kept even when it fails. */
  lastLaunchRowCheck: LaunchRowCheck | undefined;
  private readonly launchRows = new Map<string, LaunchRowTrack>();
  private shapesStartedAt: number | undefined;

  constructor(
    private readonly invoke: Invoke,
    private readonly identity: Identity,
  ) {}

  get rows(): Row[] {
    return this.transcript?.messages ?? [];
  }

  async read() {
    const transcript = await this.invoke<NativeAgentTranscriptUpdate<Row>>(TRANSCRIPT_COMMAND, {
      ...this.identity,
      viewVersion: 1,
      liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
      ...(this.transcriptToken ? { knownToken: this.transcriptToken } : {}),
    });
    if (transcript.status === "snapshot") {
      this.transcript = transcript.value;
    } else if (transcript.status === "delta") {
      requireEvidence(
        this.transcript && transcript.baseToken === this.transcriptToken,
        "Conditional transcript delta has no matching base",
      );
      const next = applyNativeAgentTranscriptDelta(this.transcript, transcript.delta);
      requireEvidence(next, "Conditional transcript delta could not be applied");
      this.transcript = next;
    } else {
      requireEvidence(transcript.status === "unchanged", "Conditional transcript is unavailable");
      requireEvidence(
        this.transcript && transcript.token === this.transcriptToken,
        "Unchanged transcript has no matching retained view",
      );
    }
    this.transcriptToken = transcript.token;
    const state = await this.invoke<StateUpdate>(STATE_COMMAND, {
      ...this.identity,
      viewVersion: 1,
      ...(this.stateToken ? { knownToken: this.stateToken } : {}),
    });
    requireEvidence(
      state.status === "snapshot" || state.status === "unchanged",
      "Session state is unavailable",
    );
    if (state.status === "snapshot") {
      requireEvidence(state.value, "Session state snapshot has no value");
      this.phase = state.value.turn.phase;
      requireEvidence(this.phase !== "error", "Claude turn failed");
      this.tasks = state.value.backgroundTasks ?? [];
    } else {
      requireEvidence(
        this.phase && state.token === this.stateToken,
        "Unchanged state has no matching retained view",
      );
    }
    this.stateToken = state.token;
    await this.recordLaunchRows();
    const entry = {
      at: Date.now(),
      transcript: transcript.status,
      state: state.status,
      phase: this.phase,
      tasks: this.tasks.map((task) => task.status).join(","),
    };
    this.log.push(entry);
    return entry;
  }

  async forcedRows(): Promise<Row[]> {
    const update = await this.invoke<NativeAgentTranscriptUpdate<Row>>(TRANSCRIPT_COMMAND, {
      ...this.identity,
      viewVersion: 1,
      liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
      forceSnapshot: true,
    });
    requireEvidence(update.status === "snapshot", "Forced transcript is not a snapshot");
    return update.value.messages;
  }

  async expectForcedComparison() {
    const forced = await this.forcedRows();
    requireEvidence(
      isDeepStrictEqual(this.rows, forced),
      "Conditional transcript differs from independent forced snapshot",
    );
  }

  async expectTaskOutput(task: BackgroundTask, toolName: string, output: string) {
    const part = toolPart(this.rows, task.toolUseId);
    const ordinal = this.launchRows.get(task.id)?.ordinal ?? null;
    const summaryLength = task.summary?.length ?? 0;
    this.lastLaunchRowCheck = {
      task: ordinal,
      row: part ? "present" : "absent",
      ...(typeof part?.toolState === "string" ? { toolState: part.toolState } : {}),
      hasDetailRef: typeof part?.detailRef === "string",
      outputLength: null,
      containsOutput: false,
      containsSummary: false,
      summaryLength,
    };
    requireEvidence(
      part?.toolName === toolName && part.toolState === "success",
      "Conditional transcript lacks the settled launching tool row",
    );
    // The projection defers output behind a content-addressed detail reference.
    // Resolve the reference from the retained row, never from a forced snapshot.
    const details =
      typeof part.detailRef === "string"
        ? await this.invoke<{ toolOutput?: string }>(TOOL_DETAILS_COMMAND, {
            ...this.identity,
            detailRef: part.detailRef,
          })
        : part;
    const toolOutput = typeof details.toolOutput === "string" ? details.toolOutput : undefined;
    const containsOutput = toolOutput !== undefined && toolOutput.includes(output);
    const containsSummary =
      toolOutput !== undefined && Boolean(task.summary) && toolOutput.includes(task.summary!);
    this.lastLaunchRowCheck = {
      ...this.lastLaunchRowCheck,
      outputLength: toolOutput?.length ?? null,
      containsOutput,
      containsSummary,
    };
    // Bash notifications may carry only the terminal summary; agent reports
    // carry their result. Either must replace the launch placeholder.
    requireEvidence(
      containsOutput || containsSummary,
      "Conditional launching tool row lacks the final background output",
    );
  }

  /**
   * Check the launching row's final output and hand `record` the row's
   * content-free evidence whether or not the check passes (5040), so a failed
   * comparison still leaves its shape history behind.
   */
  async expectTaskOutputRecorded(
    task: BackgroundTask,
    toolName: string,
    output: string,
    record: (evidence: LaunchRowEvidence) => void,
  ) {
    try {
      await this.expectTaskOutput(task, toolName, output);
    } finally {
      record(this.launchRowEvidence(task));
    }
  }

  /** One task's launching-row evidence: its shape history and the last check. */
  launchRowEvidence(task: BackgroundTask): LaunchRowEvidence {
    return {
      shapes: this.launchRowHistory(task),
      droppedShapes: this.droppedLaunchRowShapes,
      check: this.lastLaunchRowCheck ?? null,
    };
  }

  /** The recorded shapes of one task's launching row, oldest first. */
  launchRowHistory(task: BackgroundTask): LaunchRowShape[] {
    const ordinal = this.launchRows.get(task.id)?.ordinal;
    return ordinal === undefined
      ? []
      : this.launchRowShapes.filter((shape) => shape.task === ordinal);
  }

  /**
   * Record each background task's launching row when its shape changes. A new
   * detail reference is resolved once, for its output length only; a failed
   * resolution is recorded as an unreadable length and never fails the read.
   */
  private async recordLaunchRows() {
    for (const task of this.tasks) {
      if (!task.toolUseId) continue;
      let track = this.launchRows.get(task.id);
      if (!track) {
        track = { ordinal: this.launchRows.size + 1, detailRefs: new Map() };
        this.launchRows.set(task.id, track);
      }
      const part = toolPart(this.rows, task.toolUseId);
      const detailRef = typeof part?.detailRef === "string" ? part.detailRef : undefined;
      let outputLength: number | null;
      if (detailRef !== undefined) {
        if (!track.detailRefs.has(detailRef)) {
          track.detailRefs.set(
            detailRef,
            track.detailRefs.size < LAUNCH_ROW_DETAIL_REF_LIMIT
              ? await this.detailOutputLength(detailRef)
              : null,
          );
        }
        outputLength = track.detailRefs.get(detailRef) ?? null;
      } else {
        outputLength = typeof part?.toolOutput === "string" ? part.toolOutput.length : null;
      }
      const shape = {
        task: track.ordinal,
        taskStatus: task.status,
        ...(this.phase === undefined ? {} : { phase: this.phase }),
        row: part ? ("present" as const) : ("absent" as const),
        ...(typeof part?.toolName === "string" ? { toolName: part.toolName } : {}),
        ...(typeof part?.toolState === "string" ? { toolState: part.toolState } : {}),
        hasDetailRef: detailRef !== undefined,
        detailRefs: track.detailRefs.size,
        outputLength,
        summaryLength: task.summary?.length ?? 0,
      };
      const signature = JSON.stringify(shape);
      if (signature === track.last) continue;
      track.last = signature;
      if (this.launchRowShapes.length >= LAUNCH_ROW_SHAPE_LIMIT) {
        this.droppedLaunchRowShapes += 1;
        continue;
      }
      const now = Date.now();
      this.shapesStartedAt ??= now;
      this.launchRowShapes.push({ atMs: now - this.shapesStartedAt, ...shape });
    }
  }

  private async detailOutputLength(detailRef: string): Promise<number | null> {
    try {
      const details = await this.invoke<{ toolOutput?: unknown }>(TOOL_DETAILS_COMMAND, {
        ...this.identity,
        detailRef,
      });
      return typeof details?.toolOutput === "string" ? details.toolOutput.length : null;
    } catch {
      return null;
    }
  }
}

function toolPart(rows: Row[], toolUseId: string | undefined): Record<string, unknown> | undefined {
  if (!toolUseId) return undefined;
  for (const row of rows) {
    if (!Array.isArray(row.parts)) continue;
    const part = row.parts.find(
      (part: Record<string, unknown>) =>
        part?.type === "tool-invocation" && part.toolUseId === toolUseId,
    );
    if (part) return part;
  }
  return undefined;
}

/** One case's evidence cannot be satisfied by a task left by an earlier case. */
export class TaskCaseEvidence {
  private readonly baseline: Set<string>;
  private readonly running = new Set<string>();
  private readonly idleRunning = new Set<string>();
  private readonly completed = new Map<string, BackgroundTask>();
  changesAfterIdle = 0;
  private sawIdleRunning = false;

  constructor(tasks: BackgroundTask[]) {
    this.baseline = new Set(tasks.map((task) => task.id));
  }

  observe(reader: TokenReader, transcriptChanged: boolean) {
    if (this.sawIdleRunning && transcriptChanged) this.changesAfterIdle += 1;
    for (const task of reader.tasks) {
      if (this.baseline.has(task.id)) continue;
      if (task.status === "running") {
        this.running.add(task.id);
        if (reader.phase === "idle") this.idleRunning.add(task.id);
      }
      if (
        task.status === "completed" &&
        this.running.has(task.id) &&
        this.idleRunning.has(task.id)
      ) {
        this.completed.set(task.id, task);
      }
    }
    if (this.idleRunning.size) this.sawIdleRunning = true;
  }

  get settledTask(): BackgroundTask | undefined {
    return this.completed.values().next().value;
  }

  expectComplete() {
    requireEvidence(
      this.running.size > 0,
      "No new background task was observed running in this case",
    );
    requireEvidence(
      this.idleRunning.size > 0,
      "Foreground idle was never observed with the new task running",
    );
    requireEvidence(
      this.settledTask,
      "The new background task never completed after foreground idle",
    );
    requireEvidence(
      this.changesAfterIdle > 0,
      "No transcript continuation arrived after foreground idle",
    );
  }
}
