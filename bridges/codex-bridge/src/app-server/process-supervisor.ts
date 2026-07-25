/**
 * Supervises exactly one `codex app-server --stdio` child per Orkestrator
 * environment.
 *
 * This is the piece that changes the failure domain. With `codex exec` a crash
 * rejected a single turn's generator. Here one child serves every Codex tab and
 * build phase in the environment, so the supervisor exists to make that shared
 * failure survivable:
 *
 *   - a monotonic **generation** invalidates everything from a dead child, so a
 *     late event can never overwrite state belonging to a newer process;
 *   - in-flight requests fail *ambiguously* (see errors.ts) rather than being
 *     silently retried;
 *   - repeated failures open a **circuit breaker** instead of restarting forever;
 *   - an **environment fingerprint** forces a controlled restart when the
 *     developer's PATH changes, which a persistent child would otherwise miss;
 *   - a **pidfile** plus process-group termination stops orphaned children from
 *     outliving the bridge and racing over the same `CODEX_HOME`.
 *
 * It never falls back to the SDK engine on failure: running the same pending
 * turn through two mechanisms could execute it twice.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AppServerCircuitOpenError,
  AppServerProcessExitError,
  AppServerUnavailableError,
} from "./errors.js";
import { JsonlRpcClient, SerialQueue, type RpcMetricsSnapshot } from "./jsonl-rpc-client.js";
import { createRecorderFromEnv, type NotificationRecorder } from "./notification-recorder.js";
import type { InboundNotification, InboundServerRequest } from "./envelope-validation.js";
import {
  fingerprintRuntimeEnvironment,
  refreshRuntimeEnvironment,
} from "../runtime-env.js";
import type { EngineGeneration, EngineState } from "../engine/types.js";

export interface InitializeResult {
  userAgent: string;
  codexHome: string;
  platformFamily?: string;
  platformOs?: string;
}

export interface AppServerSupervisorOptions {
  /** Path to the codex binary. */
  codexPath: string;
  /** Working directory for the child — the environment's workspace. */
  cwd: string;
  /** Reported to app-server; used for compliance logs and analytics attribution. */
  clientInfo: { name: string; title: string; version: string };
  codexHome: string;
  /** Extra `-c key=value` overrides, e.g. `features.goals=true`. */
  configOverrides?: Record<string, string>;
  onNotification: (
    notification: InboundNotification,
    threadId: string | null,
    generation: EngineGeneration,
  ) => void;
  onServerRequest: (request: InboundServerRequest, generation: EngineGeneration) => void;
  onStateChange?: (state: EngineState, detail?: string) => void;
  /** Called after a successful restart so callers can resume their threads. */
  onGenerationReady?: (generation: EngineGeneration, previous: EngineGeneration) => void;
  /** Injected in tests. */
  spawnProcess?: typeof spawn;
  refreshEnvironment?: () => Promise<void>;
  /**
   * Computes the environment fingerprint. Injectable so tests can simulate a
   * PATH change without mutating the real `process.env` — under
   * `bun test --parallel` several test files share one worker process, so a
   * global env mutation races whatever else that worker is running.
   */
  fingerprintEnvironment?: () => string;
  /**
   * Builds a per-generation recorder for replay fixtures, or returns null when
   * recording is off. Injectable so tests do not touch the real filesystem.
   */
  createRecorder?: (generation: EngineGeneration) => NotificationRecorder | null;
  now?: () => number;
  /** Backoff schedule; jitter is applied on top. */
  backoffScheduleMs?: number[];
  /** Failures within `circuitWindowMs` that trip the breaker. */
  circuitBreakerThreshold?: number;
  circuitWindowMs?: number;
  shutdownGraceMs?: number;
  /** Disables pidfile bookkeeping in tests. */
  pidFileEnabled?: boolean;
}

export interface AppServerHealth {
  state: EngineState;
  generation: EngineGeneration;
  pid: number | null;
  codexVersion?: string;
  codexHome?: string;
  restartCount: number;
  /** Digest only — the underlying PATH values are never exposed. */
  environmentFingerprint: string | null;
  lastError?: string;
  lastExitCode?: number | null;
  lastExitSignal?: string | null;
  circuitOpen: boolean;
  rpc?: RpcMetricsSnapshot;
  notificationQueueDepth: number;
  notificationQueueHighWaterMark: number;
  unknownNotifications: number;
  unknownServerRequests: number;
}

interface Generation {
  id: EngineGeneration;
  child: ChildProcessWithoutNullStreams;
  client: JsonlRpcClient;
  environmentFingerprint: string;
  initialize: InitializeResult;
  startedAt: number;
  recorder: NotificationRecorder | null;
}

const DEFAULT_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000, 10_000];
const DEFAULT_CIRCUIT_THRESHOLD = 5;
const DEFAULT_CIRCUIT_WINDOW_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

export class AppServerSupervisor {
  private readonly options: AppServerSupervisorOptions;
  private readonly now: () => number;
  private readonly backoffSchedule: number[];
  private readonly circuitThreshold: number;
  private readonly circuitWindowMs: number;
  private readonly shutdownGraceMs: number;
  private readonly fingerprintEnvironment: () => string;

  /** Serial queues for notification processing, keyed by thread id. */
  readonly notificationQueue = new SerialQueue();

  private state: EngineState = "stopped";
  private generationCounter = 0;
  private current: Generation | null = null;
  /**
   * Last generation that reached ready, retained after `current` is cleared.
   * A crash nulls `current`, so without this the restart would look like a first
   * start and callers would never be told to re-read or resume their threads.
   */
  private lastReadyGeneration: EngineGeneration = 0;
  private startPromise: Promise<Generation> | null = null;
  private restartFailures: number[] = [];
  private restartCount = 0;
  private circuitOpen = false;
  private lastError: string | undefined;
  private lastExitCode: number | null = null;
  private lastExitSignal: string | null = null;
  private stopping = false;
  private unknownNotifications = 0;
  private unknownServerRequests = 0;
  /** Set while draining so no new turn can be dispatched mid-restart. */
  private drainPromise: Promise<void> | null = null;

  constructor(options: AppServerSupervisorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.backoffSchedule = options.backoffScheduleMs ?? DEFAULT_BACKOFF_MS;
    this.circuitThreshold = options.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_THRESHOLD;
    this.circuitWindowMs = options.circuitWindowMs ?? DEFAULT_CIRCUIT_WINDOW_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.fingerprintEnvironment = options.fingerprintEnvironment ?? fingerprintRuntimeEnvironment;
  }

  getState(): EngineState {
    return this.state;
  }

  getGeneration(): EngineGeneration {
    return this.current?.id ?? this.generationCounter;
  }

  isReady(): boolean {
    return this.state === "ready" && this.current !== null && !this.current.client.isClosed();
  }

  getHealth(): AppServerHealth {
    return {
      state: this.state,
      generation: this.getGeneration(),
      pid: this.current?.child.pid ?? null,
      codexHome: this.current?.initialize.codexHome,
      codexVersion: parseVersionFromUserAgent(this.current?.initialize.userAgent),
      restartCount: this.restartCount,
      environmentFingerprint: this.current?.environmentFingerprint ?? null,
      lastError: this.lastError,
      lastExitCode: this.lastExitCode,
      lastExitSignal: this.lastExitSignal,
      circuitOpen: this.circuitOpen,
      rpc: this.current?.client.getMetrics(),
      notificationQueueDepth: this.notificationQueue.pendingDepth,
      notificationQueueHighWaterMark: this.notificationQueue.highWaterMark,
      unknownNotifications: this.unknownNotifications,
      unknownServerRequests: this.unknownServerRequests,
    };
  }

  recordUnknownNotification(): void {
    this.unknownNotifications += 1;
  }

  recordUnknownServerRequest(): void {
    this.unknownServerRequests += 1;
  }

  private setState(state: EngineState, detail?: string): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state, detail);
  }

  /**
   * Returns a ready generation, starting or awaiting one as needed.
   * Callers must re-check the generation after any await: it may have advanced.
   *
   * Blocks behind an in-progress drain so a prompt cannot be dispatched into a
   * child that is about to be replaced.
   */
  async ensureReady(): Promise<Generation> {
    if (this.drainPromise) await this.drainPromise;
    return this.ensureStarted();
  }

  /**
   * Start path without the drain gate. Used from inside a drain (`restartNow`),
   * where awaiting `drainPromise` would deadlock on itself.
   */
  private async ensureStarted(): Promise<Generation> {
    if (this.stopping) throw new AppServerUnavailableError("stopped");
    if (this.circuitOpen) {
      throw new AppServerCircuitOpenError(this.restartFailures.length, this.lastError);
    }
    if (this.current && !this.current.client.isClosed() && this.state === "ready") {
      return this.current;
    }
    this.startPromise ??= this.startWithRetry().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const generation = await this.ensureReady();
    return generation.client.request<T>(method, params, options);
  }

  /**
   * Issues a request and reports which generation served it, so callers doing
   * recovery can tell whether a restart happened underneath them.
   */
  async requestWithGeneration<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<{ result: T; generation: EngineGeneration }> {
    const generation = await this.ensureReady();
    const result = await generation.client.request<T>(method, params, options);
    return { result, generation: generation.id };
  }

  async respondToServerRequest(
    generation: EngineGeneration,
    id: string | number,
    result: unknown,
  ): Promise<void> {
    // Responding into a dead generation is meaningless; app-server has already
    // forgotten the request.
    if (!this.current || this.current.id !== generation) return;
    await this.current.client.respond(id, result);
  }

  async respondToServerRequestWithError(
    generation: EngineGeneration,
    id: string | number,
    code: number,
    message: string,
  ): Promise<void> {
    if (!this.current || this.current.id !== generation) return;
    await this.current.client.respondWithError(id, code, message);
  }

  private async startWithRetry(): Promise<Generation> {
    let attempt = 0;
    for (;;) {
      try {
        const generation = await this.start();
        this.restartFailures = [];
        return generation;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.recordFailure();
        if (this.circuitOpen) {
          this.setState("failed", this.lastError);
          throw new AppServerCircuitOpenError(this.restartFailures.length, this.lastError);
        }
        const delay = this.backoffDelay(attempt);
        attempt += 1;
        this.setState("backoff", `retrying in ${delay}ms: ${this.lastError}`);
        await sleep(delay);
        if (this.stopping) throw new AppServerUnavailableError("stopped");
      }
    }
  }

  private recordFailure(): void {
    const now = this.now();
    this.restartFailures = this.restartFailures.filter(
      (at) => now - at <= this.circuitWindowMs,
    );
    this.restartFailures.push(now);
    if (this.restartFailures.length >= this.circuitThreshold) {
      this.circuitOpen = true;
    }
  }

  /** Full jitter, so several environments restarting together do not synchronise. */
  private backoffDelay(attempt: number): number {
    const base =
      this.backoffSchedule[Math.min(attempt, this.backoffSchedule.length - 1)] ?? 1_000;
    return Math.floor(base / 2 + Math.random() * (base / 2));
  }

  private async start(): Promise<Generation> {
    this.setState("starting");

    // Re-read PATH-ish variables *before* launch: the child snapshots them and
    // cannot see later changes.
    await (this.options.refreshEnvironment ?? refreshRuntimeEnvironment)();
    const environmentFingerprint = this.fingerprintEnvironment();

    if (this.options.pidFileEnabled !== false) {
      await this.killStalePidFileChild();
    }

    this.generationCounter += 1;
    const generationId = this.generationCounter;

    const args = ["app-server", "--stdio"];
    for (const [key, value] of Object.entries(this.options.configOverrides ?? {})) {
      args.push("-c", `${key}=${value}`);
    }

    const spawnFn = this.options.spawnProcess ?? spawn;
    const child = spawnFn(this.options.codexPath, args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        CODEX_HOME: this.options.codexHome,
        // Structured stderr so supervisor logs stay parseable.
        LOG_FORMAT: "json",
      },
      // Never a shell: arguments must not be re-parsed.
      shell: false,
      // Own process group, so terminating the group also reaps background
      // terminals and other descendants the agent spawned.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    if (!child.pid) {
      throw new AppServerProcessExitError("app-server failed to spawn", {
        generation: generationId,
      });
    }

    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // app-server logs structured JSON here. Surface it without inspecting
      // payloads, which can contain prompt text.
      const text = chunk.toString().trim();
      if (text) console.error(`[codex-bridge][app-server:${generationId}] ${text}`);
    });

    const recorder =
      (this.options.createRecorder ?? ((generation) => createRecorderFromEnv({ generation })))(
        generationId,
      );
    if (recorder) {
      console.error(
        `[codex-bridge][app-server:${generationId}] recording notifications to ${recorder.getStats().fileName}`,
      );
    }

    const client = new JsonlRpcClient({
      generation: generationId,
      stdin: child.stdin,
      stdout: child.stdout,
      onNotification: (notification, threadId) =>
        this.options.onNotification(notification, threadId, generationId),
      onServerRequest: (request) => this.options.onServerRequest(request, generationId),
      onProtocolViolation: (detail) => {
        this.unknownNotifications += 1;
        console.error(`[codex-bridge][app-server:${generationId}] protocol: ${detail}`);
      },
      ...(recorder ? { recordInboundLine: (line: string) => recorder.record(line) } : {}),
    });

    let exited = false;
    const handleExit = (code: number | null, signal: string | null) => {
      if (exited) return;
      exited = true;
      this.lastExitCode = code;
      this.lastExitSignal = signal;
      client.close(
        new AppServerProcessExitError(
          `app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          { generation: generationId, exitCode: code, signal },
        ),
      );
      // Flush whatever this generation buffered; a crash is exactly the case
      // where the tail of the recording matters most.
      void recorder?.close();
      this.handleUnexpectedExit(generationId, code, signal);
    };
    child.once("exit", handleExit);
    child.once("error", (error: Error) => {
      this.lastError = error.message;
      handleExit(null, null);
    });

    let initialize: InitializeResult;
    try {
      initialize = await client.request<InitializeResult>("initialize", {
        clientInfo: this.options.clientInfo,
        capabilities: {
          // Experimental methods are not part of the stable generated union, and
          // opting in would expose us to shapes the router cannot type-check.
          experimentalApi: false,
          // Attestation would make us responsible for answering
          // `attestation/generate`; declining keeps the request out of the flow.
          requestAttestation: false,
          // Form elicitation would let downstream MCP servers block a turn on UI
          // we do not have.
          mcpServerOpenaiFormElicitation: false,
        },
      });
      // app-server rejects normal requests until this lands.
      await client.notify("initialized");
    } catch (error) {
      // A failed handshake is worth having on disk: the recording holds whatever
      // app-server said before it gave up.
      await recorder?.close();
      await this.terminateChild(child);
      throw error;
    }

    const generation: Generation = {
      id: generationId,
      child,
      client,
      environmentFingerprint,
      initialize,
      startedAt: this.now(),
      recorder,
    };
    const previous = this.lastReadyGeneration;
    this.current = generation;
    this.lastReadyGeneration = generationId;
    this.setState("ready");

    if (this.options.pidFileEnabled !== false) {
      await this.writePidFile(child.pid);
    }
    if (previous !== 0) {
      this.restartCount += 1;
      // Every referenced thread has to be re-read or resumed against the new
      // child before it can accept turns again.
      this.options.onGenerationReady?.(generationId, previous);
    }

    return generation;
  }

  /**
   * A child died without us asking. Everything from this generation is now
   * invalid; callers learn via their rejected requests and the state change, and
   * the next `ensureReady()` starts a fresh generation.
   */
  private handleUnexpectedExit(
    generationId: EngineGeneration,
    code: number | null,
    signal: string | null,
  ): void {
    if (this.current?.id !== generationId) return;
    this.current = null;
    if (this.stopping) {
      this.setState("stopped");
      return;
    }
    this.setState(
      "restarting",
      `generation ${generationId} exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
    );
  }

  /**
   * The developer's PATH changed, so the running child is serving stale tool
   * lookups. Restart, but only between turns: callers pass a predicate that
   * reports whether any turn is still active.
   */
  async ensureEnvironmentIsCurrent(options: {
    hasActiveTurns: () => boolean;
    waitForIdle: () => Promise<void>;
  }): Promise<{ restarted: boolean; fingerprint: string }> {
    await (this.options.refreshEnvironment ?? refreshRuntimeEnvironment)();
    const fingerprint = this.fingerprintEnvironment();

    if (!this.current || this.current.environmentFingerprint === fingerprint) {
      return { restarted: false, fingerprint };
    }

    if (this.drainPromise) {
      await this.drainPromise;
      return { restarted: true, fingerprint };
    }

    const drain = (async () => {
      this.setState("draining", "runtime environment changed");
      if (options.hasActiveTurns()) {
        // Let in-flight turns settle rather than killing work mid-command.
        await options.waitForIdle();
      }
      await this.restartNow("runtime environment changed");
    })();

    this.drainPromise = drain.finally(() => {
      this.drainPromise = null;
    });
    await this.drainPromise;
    return { restarted: true, fingerprint };
  }

  /** Stops the current child and starts a fresh generation. */
  async restartNow(reason: string): Promise<void> {
    this.setState("restarting", reason);
    const previous = this.current;
    this.current = null;
    if (previous) {
      previous.client.close(
        new AppServerProcessExitError(`app-server restarting: ${reason}`, {
          generation: previous.id,
        }),
      );
      await previous.recorder?.close();
      await this.terminateChild(previous.child);
    }
    if (this.stopping) return;
    // `ensureStarted`, not `ensureReady`: we may be inside the drain that owns
    // `drainPromise`, and awaiting it here would deadlock.
    await this.ensureStarted();
  }

  /**
   * Graceful shutdown: stop accepting work, close stdin so app-server sees EOF,
   * then escalate SIGTERM → SIGKILL to the whole process group.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.setState("draining", "bridge shutting down");
    const generation = this.current;
    this.current = null;

    if (generation) {
      generation.client.close(
        new AppServerProcessExitError("bridge shutting down", { generation: generation.id }),
      );
      // Flushed before the child dies so a recording survives a clean shutdown.
      await generation.recorder?.close();
      await this.terminateChild(generation.child);
    }
    this.notificationQueue.clear();
    if (this.options.pidFileEnabled !== false) {
      await rm(this.pidFilePath(), { force: true }).catch(() => undefined);
    }
    this.setState("stopped");
  }

  private async terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;

    try {
      child.stdin?.end();
    } catch {
      // Already closed.
    }

    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
    });

    this.signalProcessTree(child, "SIGTERM");

    const timedOut = await Promise.race([
      exited.then(() => false),
      sleep(this.shutdownGraceMs).then(() => true),
    ]);

    if (timedOut) {
      // Grace expired. SIGKILL the group so descendants cannot survive.
      this.signalProcessTree(child, "SIGKILL");
      await Promise.race([exited, sleep(1_000)]);
    }
  }

  /**
   * Signals the child's whole process group where supported, so background
   * terminals the agent started are reaped too. Falls back to the single process
   * when the group is already gone or on platforms without process groups.
   */
  private signalProcessTree(
    child: ChildProcessWithoutNullStreams,
    signal: "SIGTERM" | "SIGKILL",
  ): void {
    const pid = child.pid;
    if (!pid) return;

    if (process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // ESRCH/EPERM: fall through to signalling the process directly.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }

  private pidFileDir(): string {
    return join(this.options.codexHome, "orkestrator-bridge");
  }

  private pidFilePath(): string {
    return join(this.pidFileDir(), `app-server-${hashPath(this.options.cwd)}.pid`);
  }

  private async writePidFile(pid: number): Promise<void> {
    try {
      await mkdir(this.pidFileDir(), { recursive: true });
      await writeFile(
        this.pidFilePath(),
        JSON.stringify({
          pid,
          bridgePid: process.pid,
          cwd: this.options.cwd,
          startedAt: new Date(this.now()).toISOString(),
        }),
        "utf8",
      );
    } catch (error) {
      console.warn(
        "[codex-bridge] Failed to write app-server pidfile:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Cleans up an orphan from a previous bridge that was SIGKILLed (or a container
   * that died abruptly). Targets only the recorded pid — never a broad
   * `pkill codex`, which would also kill the session-title generator or an
   * unrelated Codex the developer is running.
   */
  private async killStalePidFileChild(): Promise<void> {
    const path = this.pidFilePath();
    if (!existsSync(path)) return;

    try {
      const raw = await readFile(path, "utf8");
      const record = JSON.parse(raw) as { pid?: unknown; bridgePid?: unknown };
      const pid = typeof record.pid === "number" ? record.pid : null;
      if (pid && pid !== process.pid && isProcessAlive(pid)) {
        console.error(`[codex-bridge] Reaping stale app-server pid ${pid}`);
        try {
          if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
          else process.kill(pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    } catch {
      // Unreadable pidfile is not actionable.
    } finally {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 checks existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function hashPath(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** `orkestrator/0.145.0 (Mac OS ...)` → `0.145.0`. */
export function parseVersionFromUserAgent(userAgent: string | undefined): string | undefined {
  if (!userAgent) return undefined;
  return userAgent.match(/\/(\d+\.\d+\.\d+)/)?.[1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
