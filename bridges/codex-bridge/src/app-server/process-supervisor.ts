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
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import {
  AppServerCircuitOpenError,
  AppServerProcessExitError,
  AppServerUnavailableError,
} from "./errors.js";
import {
  JsonlRpcClient,
  SerialQueue,
  type RpcMetricsSnapshot,
} from "./jsonl-rpc-client.js";
import {
  createRecorderFromEnv,
  type NotificationRecorder,
} from "./notification-recorder.js";
import type {
  InboundNotification,
  InboundServerRequest,
} from "./envelope-validation.js";
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
  onServerRequest: (
    request: InboundServerRequest,
    generation: EngineGeneration,
  ) => void;
  onStateChange?: (state: EngineState, detail?: string) => void;
  /** Called after a successful restart so callers can resume their threads. */
  onGenerationReady?: (
    generation: EngineGeneration,
    previous: EngineGeneration,
  ) => void;
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
  createRecorder?: (
    generation: EngineGeneration,
  ) => NotificationRecorder | null;
  now?: () => number;
  /** Backoff schedule; jitter is applied on top. */
  backoffScheduleMs?: number[];
  /** Failures within `circuitWindowMs` that trip the breaker. */
  circuitBreakerThreshold?: number;
  circuitWindowMs?: number;
  shutdownGraceMs?: number;
  /** Disables pidfile bookkeeping in tests. */
  pidFileEnabled?: boolean;
  /**
   * Verifies that a recorded PID still belongs to the exact child instance.
   * Production uses a random environment token; injectable for pidfile tests.
   */
  matchesPidFileProcess?: (pid: number, instanceId: string) => Promise<boolean>;
  /** Process primitives are injectable so pidfile safety can be tested without signals. */
  isProcessAlive?: (pid: number) => boolean;
  signalPidFileProcess?: (pid: number) => void;
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
  instanceId: string;
}

interface PidOwnershipRecord {
  ownerToken?: string;
  bridgePid?: number;
  cwd?: string;
  acquiredAt?: string;
  pid?: number;
  startedAt?: string;
  instanceId?: string;
}

const DEFAULT_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000, 10_000];
const DEFAULT_CIRCUIT_THRESHOLD = 5;
const DEFAULT_CIRCUIT_WINDOW_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const INCOMPLETE_PIDFILE_GRACE_MS = 1_000;

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
  /** Stable for this supervisor; child `instanceId`s change each generation. */
  private readonly pidOwnerToken = randomUUID();
  private pidOwnershipHeld = false;

  constructor(options: AppServerSupervisorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.backoffSchedule = options.backoffScheduleMs ?? DEFAULT_BACKOFF_MS;
    this.circuitThreshold =
      options.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_THRESHOLD;
    this.circuitWindowMs = options.circuitWindowMs ?? DEFAULT_CIRCUIT_WINDOW_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.fingerprintEnvironment =
      options.fingerprintEnvironment ?? fingerprintRuntimeEnvironment;
  }

  getState(): EngineState {
    return this.state;
  }

  getGeneration(): EngineGeneration {
    return this.current?.id ?? this.generationCounter;
  }

  isReady(): boolean {
    return (
      this.state === "ready" &&
      this.current !== null &&
      !this.current.client.isClosed()
    );
  }

  getHealth(): AppServerHealth {
    return {
      state: this.state,
      generation: this.getGeneration(),
      pid: this.current?.child.pid ?? null,
      codexHome: this.current?.initialize.codexHome,
      codexVersion: parseVersionFromUserAgent(
        this.current?.initialize.userAgent,
      ),
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
      throw new AppServerCircuitOpenError(
        this.restartFailures.length,
        this.lastError,
      );
    }
    if (
      this.current &&
      !this.current.client.isClosed() &&
      this.state === "ready"
    ) {
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
          throw new AppServerCircuitOpenError(
            this.restartFailures.length,
            this.lastError,
          );
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
      this.backoffSchedule[
        Math.min(attempt, this.backoffSchedule.length - 1)
      ] ?? 1_000;
    return Math.floor(base / 2 + Math.random() * (base / 2));
  }

  private async start(): Promise<Generation> {
    this.setState("starting");

    // Re-read PATH-ish variables *before* launch: the child snapshots them and
    // cannot see later changes.
    await (this.options.refreshEnvironment ?? refreshRuntimeEnvironment)();
    const environmentFingerprint = this.fingerprintEnvironment();
    const instanceId = randomUUID();
    const instanceStartedAt = this.now();

    if (this.options.pidFileEnabled !== false && !this.pidOwnershipHeld) {
      const available = await this.acquirePidFileOwnership(instanceId);
      if (!available) {
        throw new AppServerUnavailableError(
          "unavailable",
          "another live bridge already supervises app-server for this workspace",
        );
      }
    }

    this.generationCounter += 1;
    const generationId = this.generationCounter;

    const args = ["app-server", "--stdio"];
    for (const [key, value] of Object.entries(
      this.options.configOverrides ?? {},
    )) {
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
        ORKESTRATOR_APP_SERVER_INSTANCE_ID: instanceId,
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

    if (this.options.pidFileEnabled !== false) {
      try {
        // Publish the PID before the handshake. If the bridge dies while
        // initialize is pending, the next owner can still identify and reap
        // this exact process rather than leaving an orphan.
        await this.updateOwnedPidFile(child.pid, instanceId, instanceStartedAt);
      } catch (error) {
        await this.terminateChild(child);
        throw error;
      }
    }

    let reportedSuppressedStderr = false;
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // app-server stderr can contain prompts, file contents, and tool output.
      // Never copy it into the durable application log. A single metadata-only
      // marker keeps the failure observable without retaining user data.
      if (chunk.toString().trim() && !reportedSuppressedStderr) {
        reportedSuppressedStderr = true;
        console.error(
          `[codex-bridge][app-server:${generationId}] stderr output suppressed`,
        );
      }
    });

    const recorder = (
      this.options.createRecorder ??
      ((generation) => createRecorderFromEnv({ generation }))
    )(generationId);
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
      onServerRequest: (request) =>
        this.options.onServerRequest(request, generationId),
      onProtocolViolation: (detail) => {
        this.unknownNotifications += 1;
        console.error(
          `[codex-bridge][app-server:${generationId}] protocol: ${detail}`,
        );
      },
      ...(recorder
        ? { recordInboundLine: (line: string) => recorder.record(line) }
        : {}),
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
      instanceId,
    };
    const previous = this.lastReadyGeneration;
    this.current = generation;
    this.lastReadyGeneration = generationId;
    this.setState("ready");

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
        new AppServerProcessExitError("bridge shutting down", {
          generation: generation.id,
        }),
      );
      // Flushed before the child dies so a recording survives a clean shutdown.
      await generation.recorder?.close();
      await this.terminateChild(generation.child);
    }
    this.notificationQueue.clear();
    if (this.options.pidFileEnabled !== false) {
      await this.releasePidFileOwnership();
    }
    this.setState("stopped");
  }

  private async terminateChild(
    child: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;

    try {
      child.stdin?.end();
    } catch {
      // Already closed.
    }

    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return resolve();
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
    return join(
      this.pidFileDir(),
      `app-server-${hashPath(this.options.cwd)}.pid`,
    );
  }

  private async updateOwnedPidFile(
    pid: number,
    instanceId: string,
    instanceStartedAt: number,
  ): Promise<void> {
    const path = this.pidFilePath();
    const current = JSON.parse(
      await readFile(path, "utf8"),
    ) as PidOwnershipRecord;
    if (current.ownerToken !== this.pidOwnerToken) {
      this.pidOwnershipHeld = false;
      throw new AppServerUnavailableError(
        "unavailable",
        "app-server pidfile ownership changed before child publication",
      );
    }
    const payload = Buffer.from(
      JSON.stringify({
        ownerToken: this.pidOwnerToken,
        bridgePid: process.pid,
        cwd: this.options.cwd,
        acquiredAt: current.acquiredAt ?? new Date(this.now()).toISOString(),
        pid,
        startedAt: new Date(instanceStartedAt).toISOString(),
        instanceId,
      }),
      "utf8",
    );
    const temporary = `${path}.${this.pidOwnerToken}.update`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.write(payload, 0, payload.length, 0);
      await handle.sync();
      await handle.close();

      // Validate again immediately before publication. The public record is
      // never truncated: readers see the complete starting record or the
      // complete PID-bearing replacement.
      const latest = JSON.parse(
        await readFile(path, "utf8"),
      ) as PidOwnershipRecord;
      if (latest.ownerToken !== this.pidOwnerToken) {
        this.pidOwnershipHeld = false;
        throw new AppServerUnavailableError(
          "unavailable",
          "app-server pidfile ownership changed before child publication",
        );
      }
      await rename(temporary, path);
    } finally {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Atomically claims startup ownership before spawning. `open(..., "wx")` is
   * the cross-process compare-and-set: only one bridge can create the record.
   */
  private async acquirePidFileOwnership(instanceId: string): Promise<boolean> {
    await mkdir(this.pidFileDir(), { recursive: true });

    for (;;) {
      try {
        const handle = await open(this.pidFilePath(), "wx", 0o600);
        try {
          const record: PidOwnershipRecord = {
            ownerToken: this.pidOwnerToken,
            bridgePid: process.pid,
            cwd: this.options.cwd,
            acquiredAt: new Date(this.now()).toISOString(),
            instanceId,
          };
          await handle.writeFile(JSON.stringify(record), "utf8");
          await handle.sync();
          this.pidOwnershipHeld = true;
          return true;
        } catch (error) {
          await this.quarantineClaimedPidFile(handle);
          throw error;
        } finally {
          await handle.close().catch(() => undefined);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const reclaimed = await this.reclaimStalePidFile();
      if (!reclaimed) return false;
    }
  }

  /**
   * Cleans up an orphan from a previous bridge that was SIGKILLed (or a container
   * that died abruptly). The stale record is atomically quarantined before it is
   * removed, so a contender can never unlink a successor's ownership record.
   */
  private async reclaimStalePidFile(): Promise<boolean> {
    const path = this.pidFilePath();
    let record: PidOwnershipRecord | null = null;
    let observedRaw: string | null = null;
    try {
      observedRaw = await readFile(path, "utf8");
      record = JSON.parse(observedRaw) as PidOwnershipRecord;
    } catch {
      // The winner may still be publishing its owner record.
    }

    const bridgePid =
      typeof record?.bridgePid === "number" ? record.bridgePid : null;
    const validCurrentOwner =
      record &&
      bridgePid !== null &&
      bridgePid > 0 &&
      record.cwd === this.options.cwd &&
      typeof record.ownerToken === "string" &&
      record.ownerToken.length > 0 &&
      typeof record.acquiredAt === "string" &&
      Number.isFinite(Date.parse(record.acquiredAt));
    const validLegacyOwner =
      record &&
      record.ownerToken === undefined &&
      bridgePid !== null &&
      bridgePid > 0 &&
      record.cwd === this.options.cwd &&
      typeof record.instanceId === "string" &&
      record.instanceId.length > 0 &&
      typeof record.startedAt === "string" &&
      Number.isFinite(Date.parse(record.startedAt));
    const validOwner = validCurrentOwner || validLegacyOwner;

    if (validOwner && bridgePid !== null) {
      const processIsAlive = this.options.isProcessAlive ?? isProcessAlive;
      // This includes another supervisor in the same process. Ownership is per
      // supervisor token, not merely per bridge PID.
      if (processIsAlive(bridgePid)) return false;
    } else {
      try {
        const metadata = await stat(path);
        if (Date.now() - metadata.mtimeMs < INCOMPLETE_PIDFILE_GRACE_MS)
          return false;
      } catch {
        return true;
      }
    }

    const pid = typeof record?.pid === "number" ? record.pid : null;
    const instanceId =
      typeof record?.instanceId === "string" ? record.instanceId : null;
    const startedAt =
      typeof record?.startedAt === "string"
        ? Date.parse(record.startedAt)
        : Number.NaN;
    const processIsAlive = this.options.isProcessAlive ?? isProcessAlive;
    const matches =
      pid &&
      pid !== process.pid &&
      instanceId &&
      record?.cwd === this.options.cwd &&
      Number.isFinite(startedAt) &&
      processIsAlive(pid) &&
      (await (this.options.matchesPidFileProcess
        ? this.options.matchesPidFileProcess(pid, instanceId)
        : matchesAppServerInstance(
            pid,
            instanceId,
            startedAt,
            this.options.codexPath,
          )));

    const quarantineToken =
      typeof record?.ownerToken === "string" ? record.ownerToken : randomUUID();
    // A persistently unreadable record is not safe to remove and must not make
    // the acquisition loop spin forever.
    if (observedRaw === null) return false;
    if (!(await this.quarantineObservedPidFile(observedRaw, quarantineToken))) {
      return true;
    }

    if (matches) {
      console.error(`[codex-bridge] Reaping stale app-server pid ${pid}`);
      if (this.options.signalPidFileProcess) {
        this.options.signalPidFileProcess(pid);
      } else {
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
    }
    return true;
  }

  private async quarantineObservedPidFile(
    observedRaw: string,
    quarantineToken: string,
  ): Promise<boolean> {
    const path = this.pidFilePath();
    const quarantinePath = `${path}.${quarantineToken}.stale`;
    try {
      await rename(path, quarantinePath);
    } catch {
      return false;
    }

    try {
      const movedRaw = await readFile(quarantinePath, "utf8");
      if (movedRaw !== observedRaw) {
        // A contender replaced the stale record after our read. Restore that
        // exact inode only when the public path is still empty; never overwrite
        // a still-newer owner.
        await link(quarantinePath, path).catch(() => undefined);
        return false;
      }
      return true;
    } finally {
      await rm(quarantinePath, { force: true }).catch(() => undefined);
    }
  }

  private async releasePidFileOwnership(): Promise<void> {
    if (!this.pidOwnershipHeld) return;
    this.pidOwnershipHeld = false;
    const path = this.pidFilePath();
    try {
      const record = JSON.parse(
        await readFile(path, "utf8"),
      ) as PidOwnershipRecord;
      if (record.ownerToken !== this.pidOwnerToken) return;
      await this.quarantineOwnedPidFile();
    } catch {
      // Already removed or replaced by a different owner.
    }
  }

  private async quarantineOwnedPidFile(): Promise<boolean> {
    const path = this.pidFilePath();
    const quarantinePath = `${path}.${this.pidOwnerToken}.release`;
    try {
      await rename(path, quarantinePath);
    } catch {
      return false;
    }

    try {
      const moved = JSON.parse(
        await readFile(quarantinePath, "utf8"),
      ) as PidOwnershipRecord;
      if (moved.ownerToken !== this.pidOwnerToken) {
        await link(quarantinePath, path).catch(() => undefined);
        return false;
      }
      return true;
    } finally {
      await rm(quarantinePath, { force: true }).catch(() => undefined);
    }
  }

  private async quarantineClaimedPidFile(handle: FileHandle): Promise<boolean> {
    const path = this.pidFilePath();
    const quarantinePath = `${path}.${this.pidOwnerToken}.failed`;
    let claimedIdentity: { dev: number | bigint; ino: number | bigint };
    try {
      const metadata = await handle.stat({ bigint: true });
      claimedIdentity = { dev: metadata.dev, ino: metadata.ino };
    } catch {
      return false;
    }

    try {
      await rename(path, quarantinePath);
    } catch {
      return false;
    }

    try {
      const moved = await stat(quarantinePath, { bigint: true });
      if (
        moved.dev !== claimedIdentity.dev ||
        moved.ino !== claimedIdentity.ino
      ) {
        // Ownership was replaced while our publication failed. Restore the
        // moved successor only if the public path is still unclaimed.
        await link(quarantinePath, path).catch(() => undefined);
        return false;
      }
      return true;
    } finally {
      await rm(quarantinePath, { force: true }).catch(() => undefined);
    }
  }
}

async function matchesAppServerInstance(
  pid: number,
  instanceId: string,
  expectedStartedAt: number,
  codexPath: string,
): Promise<boolean> {
  const token = `ORKESTRATOR_APP_SERVER_INSTANCE_ID=${instanceId}`;
  if (process.platform === "linux") {
    try {
      const [environment, commandLine] = await Promise.all([
        readFile(`/proc/${pid}/environ`),
        readFile(`/proc/${pid}/cmdline`),
      ]);
      const environmentEntries = environment.toString("utf8").split("\0");
      const command = commandLine.toString("utf8").split("\0");
      return (
        environmentEntries.includes(token) &&
        command.some((entry) => entry === "app-server") &&
        command.some((entry) => entry === "--stdio")
      );
    } catch {
      return false;
    }
  }
  if (process.platform === "darwin") {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          "/bin/ps",
          ["-p", String(pid), "-o", "lstart=", "-o", "command="],
          { maxBuffer: 1024 * 1024 },
          (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          },
        );
      });
      // Darwin does not expose another process's environment reliably. Pair
      // the recorded launch time with the exact executable/arguments instead;
      // a reused PID cannot match the old process start time.
      const startedAtText = output.slice(0, 24).trim();
      const command = output.slice(24).trim();
      const actualStartedAt = Date.parse(startedAtText);
      return (
        Number.isFinite(actualStartedAt) &&
        Math.abs(actualStartedAt - expectedStartedAt) < 2_000 &&
        command.includes(codexPath) &&
        command.includes("app-server") &&
        command.includes("--stdio")
      );
    } catch {
      return false;
    }
  }
  // Refuse to signal on platforms where exact instance identity is unavailable.
  return false;
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
export function parseVersionFromUserAgent(
  userAgent: string | undefined,
): string | undefined {
  if (!userAgent) return undefined;
  return userAgent.match(/\/(\d+\.\d+\.\d+)/)?.[1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
