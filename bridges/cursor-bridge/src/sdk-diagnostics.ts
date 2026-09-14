/** Metadata-only observation of the pinned SDK's otherwise private run boundary. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import * as sdk from "@cursor/sdk";

const MAX_TRANSPORTS = 16;
const MAX_EXECUTIONS = 128;
const MAX_RECENT = 8;
const scopes = new AsyncLocalStorage<CursorSdkDiagnostics>();
type RecordValue = Record<string, unknown>;
type Stage = "executing" | "response-ready" | "completed" | "failed" | "closed";
type Execution = {
  id?: string;
  kind: string;
  stage: Stage;
  startedAt: number;
  changedAt: number;
  responses: number;
};
type TransportObservation = {
  reference: WeakRef<RecordValue>;
  attempt: number;
  lastInbound?: number;
  lastMeaningful?: number;
  inboundCount: number;
  outboundCount: number;
  heartbeatCount: number;
};
const EXEC_KINDS = new Set([
  "shellArgs",
  "shellStreamArgs",
  "backgroundShellSpawnArgs",
  "readArgs",
  "redactedReadArgs",
  "writeArgs",
  "deleteArgs",
  "grepArgs",
  "lsArgs",
  "diagnosticsArgs",
  "requestContextArgs",
  "mcpArgs",
  "listMcpResourcesExecArgs",
  "readMcpResourceExecArgs",
  "mcpStateExecArgs",
  "fetchArgs",
  "executeHookArgs",
  "writeShellStdinArgs",
]);
const FRAME_KINDS = new Set([
  "heartbeat",
  "serverHeartbeat",
  "clientHeartbeat",
  "interactionUpdate",
  "interactionQuery",
  "interactionResponse",
  "execServerMessage",
  "execServerControlMessage",
  "execClientMessage",
  "execClientControlMessage",
  "conversationCheckpointUpdate",
  "kvServerMessage",
  "kvClientMessage",
  "runRequest",
  "conversationAction",
  "turnEnded",
  "abort",
  "ended",
  "textDelta",
  "thinkingDelta",
  "tokenDelta",
  "thinkingCompleted",
  "toolCallStarted",
  "toolCallCompleted",
  "partialToolCall",
  "toolCallDelta",
  "shellOutputDelta",
  "summary",
  "summaryStarted",
  "summaryCompleted",
  "stepStarted",
  "stepCompleted",
  "askQuestionInteractionQuery",
  "switchModeRequestQuery",
  "mcpAuthRequestQuery",
  "connectScmRequestQuery",
  ...EXEC_KINDS,
  ...Array.from(EXEC_KINDS, (kind) => kind.replace(/Args$/, "Result")),
  "readToolCall",
  "shellToolCall",
  "writeToolCall",
  "grepToolCall",
  "lsToolCall",
  "mcpToolCall",
  "taskToolCall",
  "shellStream",
]);
const HANDLERS = [
  "streamSplitter",
  "execHandler",
  "interactionController",
  "checkpointController",
  "kvHandler",
  "conversationActionManager",
  "handleShellStream",
];
const HANDLER_STATES = new Set(["started", "completed", "errored"]);
const BOUNDARIES = new Set([
  "heartbeat",
  "send-started",
  "send-resolved",
  "cancel-requested",
  "cancel-settled",
  "closed",
]);

function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" ? (value as RecordValue) : {};
}
function hash(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 1024) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
function age(now: number, value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, now - value) : null;
}
function category(value: unknown, allowed: Set<string>): string {
  return typeof value === "string" && allowed.has(value) ? value : "other";
}
function frame(value: unknown): string {
  if (typeof value !== "string" || value.length > 160) return "other";
  return value
    .split(":", 3)
    .map((part) => category(part, FRAME_KINDS))
    .join(":");
}
function safely(work: () => void): void {
  try {
    work();
  } catch {
    /* Observation must never change SDK execution. */
  }
}

// The patch exposes prototypes, not a logger. Keep all policy and bounds in
// ordinary bridge code. An SDK upgrade must pass the seam test before shipping.
export interface SdkDiagnosticSeam {
  stallDetectorPrototype: {
    startTimer: (...args: unknown[]) => unknown;
    trackActivity: (...args: unknown[]) => unknown;
  };
  execControllerPrototype: { run: (...args: unknown[]) => unknown };
}
interface ExecManager {
  handle(...args: unknown[]): AsyncIterable<unknown>;
  handleControlMessage(...args: unknown[]): unknown;
}

/** Exported for contract tests; production installs once, only with debugging enabled. */
export function instrumentSdk(seam: SdkDiagnosticSeam): () => void {
  const detector = seam.stallDetectorPrototype;
  const controller = seam.execControllerPrototype;
  if (
    typeof detector?.startTimer !== "function" ||
    typeof detector?.trackActivity !== "function" ||
    typeof controller?.run !== "function"
  ) {
    throw new Error("Unsupported Cursor diagnostic seam");
  }
  const startTimer = detector.startTimer;
  const trackActivity = detector.trackActivity;
  const run = controller.run;
  const owners = new WeakMap<object, CursorSdkDiagnostics>();
  detector.startTimer = function (...args) {
    safely(() => {
      const scope = scopes.getStore();
      if (scope && !owners.has(this)) {
        owners.set(this, scope);
        scope.transport(this);
      }
    });
    return startTimer.apply(this, args);
  };
  detector.trackActivity = function (...args) {
    safely(() => owners.get(this)?.transportActivity(this, args[0], args[1]));
    return trackActivity.apply(this, args);
  };
  controller.run = function (this: { controlledExecManager: ExecManager }, ...args) {
    const scope = scopes.getStore();
    if (!scope) return run.apply(this, args);
    const manager = this.controlledExecManager;
    // A controller owns this facade. Never mutate the shared executor manager:
    // multiple simultaneous turns can use it with different diagnostic scopes.
    this.controlledExecManager = {
      handleControlMessage: (...input) => manager.handleControlMessage(...input),
      handle: (...input) => observeExecution(manager.handle(...input), scope, input[1]),
    };
    const restore = () => {
      this.controlledExecManager = manager;
    };
    try {
      const result = run.apply(this, args);
      if (result !== null && typeof result === "object" && "then" in result) {
        return Promise.resolve(result).finally(restore);
      }
      restore();
      return result;
    } catch (error) {
      restore();
      throw error;
    }
  };
  return () => {
    detector.startTimer = startTimer;
    detector.trackActivity = trackActivity;
    controller.run = run;
  };
}

async function* observeExecution(
  source: AsyncIterable<unknown>,
  scope: CursorSdkDiagnostics,
  request: unknown,
): AsyncGenerator<unknown> {
  let update: ((stage: Stage) => void) | undefined;
  safely(() => {
    update = scope.execution(request);
  });
  // Do not retain tool arguments across a yield. Only the SDK's own iterator
  // needs them; our tracking entry contains a hash, category and timestamps.
  request = undefined;
  try {
    for await (const response of source) {
      safely(() => update?.("response-ready"));
      yield response;
      // The SDK loop awaits clientStream.write(response) before requesting the
      // next item. A stuck response-ready entry pinpoints that write boundary.
      safely(() => update?.("executing"));
    }
    safely(() => update?.("completed"));
  } catch (error) {
    safely(() => update?.("failed"));
    throw error;
  } finally {
    safely(() => update?.("closed"));
  }
}

type DiagnosticModule = object;
let sdkModule: DiagnosticModule = sdk;
let coverage: "installed" | "unavailable" | undefined;
let uninstall: (() => void) | undefined;

function install(): "installed" | "unavailable" {
  if (coverage) return coverage;
  coverage = "unavailable";
  safely(() => {
    const hook: unknown = Reflect.get(sdkModule, "__orkestratorDiagnosticsV1");
    if (typeof hook === "function") {
      const restore: unknown = hook(instrumentSdk);
      if (typeof restore === "function") uninstall = restore as () => void;
      coverage = "installed";
    }
  });
  return coverage;
}

/** Restores vendor prototypes and clears the coverage memo. Tests only. */
export function resetSdkDiagnosticsForTests(nextModule: DiagnosticModule = sdk): void {
  uninstall?.();
  uninstall = undefined;
  coverage = undefined;
  sdkModule = nextModule;
}

/** One bounded scope per bridge turn, including while its renderer is inactive. */
export class CursorSdkDiagnostics {
  private readonly transports: TransportObservation[] = [];
  private readonly transportEntries = new WeakMap<object, TransportObservation>();
  private readonly seen = new WeakSet<object>();
  private readonly active = new Set<Execution>();
  private readonly recent: Execution[] = [];
  private droppedTransports = 0;
  private transportAttempts = 0;
  private droppedExecutions = 0;
  private executionsStarted = 0;
  private executionsCompleted = 0;
  private executionsFailed = 0;
  private closed = false;
  private run?: string;
  private readonly session?: string;
  private readonly coverage: string;

  constructor(
    sessionId: string,
    private readonly now: () => number = Date.now,
    private readonly write: (line: string) => void = (line) => console.info(line),
  ) {
    this.session = hash(sessionId);
    this.coverage = install();
  }

  follow<T>(work: () => T): T {
    return scopes.run(this, work);
  }
  sent(runId: string): void {
    this.run = hash(runId);
  }
  transport(value: object): void {
    if (this.closed || this.seen.has(value)) return;
    this.seen.add(value);
    this.transportAttempts++;
    // Reclaim completed attempts so transport retries do not consume the cap
    // forever. Never evict a live attempt without reporting lost coverage.
    for (let i = this.transports.length - 1; i >= 0; i--) {
      const previous = this.transports[i]!.reference.deref();
      if (!previous || previous.disposed === true) this.transports.splice(i, 1);
    }
    if (this.transports.length >= MAX_TRANSPORTS) {
      this.droppedTransports++;
      return;
    }
    const observation: TransportObservation = {
      reference: new WeakRef(object(value)),
      attempt: this.transportAttempts,
      inboundCount: 0,
      outboundCount: 0,
      heartbeatCount: 0,
    };
    this.transports.push(observation);
    this.transportEntries.set(value, observation);
  }
  transportActivity(detector: object, direction: unknown, kind: unknown): void {
    if (this.closed) return;
    const entry = this.transportEntries.get(detector);
    if (!entry) return;
    if (direction === "inbound_message") {
      entry.inboundCount++;
      entry.lastInbound = this.now();
      if (kind === "heartbeat") entry.heartbeatCount++;
      else entry.lastMeaningful = this.now();
    } else if (direction === "outbound_write") entry.outboundCount++;
  }
  execution(request: unknown): (stage: Stage) => void {
    if (this.closed) return () => {};
    this.executionsStarted++;
    if (this.active.size >= MAX_EXECUTIONS) {
      this.droppedExecutions++;
      return () => {};
    }
    const value = object(request);
    const entry: Execution = {
      id: hash(value.execId),
      kind: category(object(value.message).case, EXEC_KINDS),
      stage: "executing",
      startedAt: this.now(),
      changedAt: this.now(),
      responses: 0,
    };
    this.active.add(entry);
    let settled = false;
    return (stage) => {
      if (this.closed || settled) return;
      entry.stage = stage;
      entry.changedAt = this.now();
      if (stage === "response-ready") entry.responses++;
      if (stage === "completed" || stage === "failed" || stage === "closed") {
        settled = true;
        if (stage === "completed") this.executionsCompleted++;
        if (stage === "failed") this.executionsFailed++;
        this.active.delete(entry);
        this.recent.push(entry);
        if (this.recent.length > MAX_RECENT) this.recent.shift();
      }
    };
  }

  report(event: string): void {
    if (this.closed) return;
    safely(() => {
      const now = this.now();
      const transports = this.transports.slice(0, 4).map((observation) => {
        const d = observation.reference.deref();
        if (!d) return { collected: true };
        const handlers = object(d.handlerTracker).handlers;
        return {
          attempt: observation.attempt,
          inboundCount: observation.inboundCount,
          outboundCount: observation.outboundCount,
          heartbeatCount: observation.heartbeatCount,
          lastInboundAgoMs: age(now, observation.lastInbound),
          lastMeaningfulAgoMs: age(now, observation.lastMeaningful),
          serverHeartbeatAgoMs: age(now, d.lastServerSentHeartbeatAt),
          clientHeartbeatAgoMs: age(now, d.lastClientSentHeartbeatAt),
          lastInbound: frame(object(d.lastInboundMessage).messageType),
          lastOutbound: frame(object(d.lastOutboundMessage).messageType),
          paused: d.paused === true,
          aborted: typeof d.abortedAt === "number",
          streamEnded: typeof d.streamEndedAt === "number",
          disposed: d.disposed === true,
          handlers: HANDLERS.flatMap((name) => {
            const h = object(handlers instanceof Map ? handlers.get(name) : undefined);
            if (h.state === undefined) return [];
            return [
              {
                name,
                state: category(h.state, HANDLER_STATES),
                durationMs: age(typeof h.endedAt === "number" ? h.endedAt : now, h.startedAt),
              },
            ];
          }),
        };
      });
      const summarize = (e: Execution) => ({
        id: e.id,
        kind: e.kind,
        stage: e.stage,
        ageMs: age(now, e.startedAt),
        stageAgeMs: age(now, e.changedAt),
        responses: e.responses,
      });
      const payload = {
        bridge: "cursor",
        event: "sdk-snapshot",
        boundary: category(event, BOUNDARIES),
        session: this.session,
        run: this.run,
        coverage: this.coverage,
        transportAttempts: this.transportAttempts,
        transportCount: this.transports.length,
        droppedTransports: this.droppedTransports,
        transports,
        executionsStarted: this.executionsStarted,
        executionsCompleted: this.executionsCompleted,
        executionsFailed: this.executionsFailed,
        pendingExecutionCount: this.active.size,
        pendingExecutions: Array.from(this.active).slice(0, MAX_RECENT).map(summarize),
        recentExecutions: this.recent.map(summarize),
        droppedExecutions: this.droppedExecutions,
      };
      const json = JSON.stringify(payload);
      this.write(
        `[bridge-diagnostics] ${
          Buffer.byteLength(json) <= 8192
            ? json
            : JSON.stringify({
                bridge: "cursor",
                event: "sdk-snapshot-overflow",
                session: this.session,
                run: this.run,
              })
        }`,
      );
    });
  }
  close(): void {
    this.closed = true;
    this.transports.length = 0;
    this.active.clear();
    this.recent.length = 0;
  }
}
