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
    requireEvidence(
      part?.toolName === toolName && part.toolState === "success",
      "Conditional transcript lacks the settled launching tool row",
    );
    // The projection defers output behind a content-addressed detail reference.
    // Resolve the reference from the retained row, never from a forced snapshot.
    const details =
      typeof part.detailRef === "string"
        ? await this.invoke<{ toolOutput?: string }>("get_native_agent_tool_details", {
            ...this.identity,
            detailRef: part.detailRef,
          })
        : part;
    // Bash notifications may carry only the terminal summary; agent reports
    // carry their result. Either must replace the launch placeholder.
    requireEvidence(
      typeof details.toolOutput === "string" &&
        (details.toolOutput.includes(output) ||
          (Boolean(task.summary) && details.toolOutput.includes(task.summary!))),
      "Conditional launching tool row lacks the final background output",
    );
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
