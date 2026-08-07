import { afterEach, describe, test, expect, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AppServerOwnershipUnavailableError,
  AppServerSupervisor,
  parseProcessStartTime,
  parseVersionFromUserAgent,
  __testing,
  type AppServerSupervisorOptions,
} from "./process-supervisor.js";
import {
  AppServerCircuitOpenError,
  AppServerProcessExitError,
  AppServerUnavailableError,
  classifyDispatchFailure,
} from "./errors.js";
import { FakeReadable, FakeWritable } from "./testing/fake-app-server.js";
import type { EngineState } from "../engine/types.js";
import type {
  InboundNotification,
  InboundServerRequest,
} from "./envelope-validation.js";
import {
  ORKESTRATOR_AGENT_MCP_TOKEN_ENV,
  ORKESTRATOR_AGENT_MCP_URL_ENV,
  codexAppServerConfigOverrides,
} from "../codex-config.js";

/**
 * Minimal stand-in for a spawned app-server child. Tests control whether
 * `initialize` succeeds, and can make the process exit on demand.
 */
class FakeChild extends EventEmitter {
  readonly stdin = new FakeWritable();
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeStderr();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed: Array<string> = [];

  constructor(
    readonly pid: number | undefined,
    private readonly behaviour: {
      failInitialize?: boolean;
      hangInitialize?: boolean;
      userAgent?: string;
    } = {},
  ) {
    super();
    // Answer `initialize` as soon as the client writes it.
    const original = this.stdin.write.bind(this.stdin);
    this.stdin.write = (
      chunk: string,
      callback?: (error?: Error | null) => void,
    ) => {
      const result = original(chunk, callback);
      queueMicrotask(() => this.maybeAnswer(chunk));
      return result;
    };
  }

  private maybeAnswer(chunk: string): void {
    let message: { id?: unknown; method?: unknown };
    try {
      message = JSON.parse(chunk.trim());
    } catch {
      return;
    }
    if (message.method !== "initialize" || message.id === undefined) return;
    if (this.behaviour.hangInitialize) return;
    if (this.behaviour.failInitialize) {
      this.stdout.pushMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "initialize refused" },
      });
      return;
    }
    this.stdout.pushMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        userAgent:
          this.behaviour.userAgent ??
          "orkestrator/0.145.0 (Mac OS 26.5; arm64)",
        codexHome: "/tmp/codex-home",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
  }

  kill(signal: string): boolean {
    this.killed.push(signal);
    this.exit(null, signal);
    return true;
  }

  exit(code: number | null, signal: string | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.emit("exit", code, signal);
  }
}

class FakeStderr {
  private readonly listeners: Array<(chunk: string) => void> = [];
  setEncoding(): void {}
  on(event: string, listener: (chunk: string) => void): void {
    if (event === "data") this.listeners.push(listener);
  }
  emitData(chunk: string): void {
    for (const listener of this.listeners) listener(chunk);
  }
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

/**
 * Above every platform's `pid_max`, so `process.kill` on it is guaranteed to
 * fail rather than reach a real process group. Tests that let the supervisor
 * run its termination path must never hand it a plausible PID.
 */
const UNMAPPED_PID = 2_147_483_646;
/** chmod-based permission tests are meaningless as root. */
const RUNNING_AS_ROOT = process.getuid?.() === 0;

/** Private surface exercised directly, per the pidfile coverage gap. */
interface SupervisorInternals {
  pidFilePath(): string;
  pidOwnerToken: string;
  pidOwnershipHeld: boolean;
  acquirePidFileOwnership(instanceId: string): Promise<boolean>;
  reclaimStalePidFile(): Promise<boolean>;
  updateOwnedPidFile(
    pid: number,
    instanceId: string,
    instanceStartedAt: number,
  ): Promise<void>;
  quarantineObservedPidFile(observedRaw: string): Promise<string>;
  quarantineClaimedPidFile(handle: unknown): Promise<boolean>;
}

function internals(supervisor: AppServerSupervisor): SupervisorInternals {
  return supervisor as unknown as SupervisorInternals;
}

function temporaryCodexHome(label: string): string {
  const codexHome = mkdtempSync(join(tmpdir(), label));
  temporaryDirectories.push(codexHome);
  return codexHome;
}

/** Lets the supervisor's internal promise chain reach stdin/stdout. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function writePidRecord(path: string, record: Record<string, unknown>): string {
  mkdirSync(dirname(path), { recursive: true });
  const raw = JSON.stringify(record);
  writeFileSync(path, raw, "utf8");
  return raw;
}

interface Harness {
  supervisor: AppServerSupervisor;
  /** Simulates an environment change without touching process.env. */
  setFingerprint: (value: string) => void;
  children: FakeChild[];
  states: Array<{ state: EngineState; detail?: string }>;
  notifications: Array<{
    notification: InboundNotification;
    generation: number;
  }>;
  serverRequests: Array<{ request: InboundServerRequest; generation: number }>;
  generationReady: Array<{ generation: number; previous: number }>;
  spawnEnvironments: NodeJS.ProcessEnv[];
}

function harness(
  options: {
    behaviours?: Array<{
      failInitialize?: boolean;
      hangInitialize?: boolean;
      pid?: number;
    }>;
    supervisor?: Partial<AppServerSupervisorOptions>;
  } = {},
): Harness {
  const children: FakeChild[] = [];
  const states: Harness["states"] = [];
  const notifications: Harness["notifications"] = [];
  const serverRequests: Harness["serverRequests"] = [];
  const generationReady: Harness["generationReady"] = [];
  const spawnEnvironments: NodeJS.ProcessEnv[] = [];
  let spawnIndex = 0;
  let currentFingerprint = "sha256:initial";

  const supervisor = new AppServerSupervisor({
    codexPath: "/fake/codex",
    cwd: "/tmp/workspace",
    codexHome: "/tmp/codex-home",
    clientInfo: { name: "orkestrator", title: "Orkestrator", version: "2.4.9" },
    pidFileEnabled: false,
    shutdownGraceMs: 20,
    backoffScheduleMs: [1, 1, 1, 1, 1, 1],
    refreshEnvironment: async () => undefined,
    // Never mutate the real process.env: under `bun test --parallel` several test
    // files share one worker process, so a global PATH change races them.
    fingerprintEnvironment: () => currentFingerprint,
    onNotification: (notification, _threadId, generation) =>
      notifications.push({ notification, generation }),
    onServerRequest: (request, generation) =>
      serverRequests.push({ request, generation }),
    onStateChange: (state, detail) => states.push({ state, detail }),
    onGenerationReady: (generation, previous) =>
      generationReady.push({ generation, previous }),
    spawnProcess: ((_command: string, _args: string[], spawnOptions: {
      env?: NodeJS.ProcessEnv;
    }) => {
      const behaviour = options.behaviours?.[spawnIndex] ?? {};
      spawnIndex += 1;
      spawnEnvironments.push({ ...spawnOptions.env });
      const child = new FakeChild(
        behaviour.pid ?? 1000 + spawnIndex,
        behaviour,
      );
      children.push(child);
      return child;
    }) as unknown as AppServerSupervisorOptions["spawnProcess"],
    ...options.supervisor,
  });

  return {
    supervisor,
    setFingerprint: (value: string) => {
      currentFingerprint = value;
    },
    children,
    states,
    notifications,
    serverRequests,
    generationReady,
    spawnEnvironments,
  };
}

describe("startup", () => {
  test("completes the initialize handshake and reaches ready", async () => {
    const h = harness();
    await h.supervisor.ensureReady();

    expect(h.supervisor.getState()).toBe("ready");
    expect(h.supervisor.isReady()).toBe(true);
    expect(h.supervisor.getGeneration()).toBe(1);

    // Handshake order matters: app-server rejects requests before `initialized`.
    const written = h.children[0]!.stdin.parsed();
    expect(written[0]!.method).toBe("initialize");
    expect(written[1]!.method).toBe("initialized");
  });

  test("passes managed GitHub credentials to the app-server generation", async () => {
    const originalGitHubToken = process.env.GITHUB_TOKEN;
    const originalGhToken = process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = "managed-token";
    process.env.GH_TOKEN = "managed-token";

    try {
      const h = harness();
      await h.supervisor.ensureReady();

      expect(h.spawnEnvironments[0]?.GITHUB_TOKEN).toBe("managed-token");
      expect(h.spawnEnvironments[0]?.GH_TOKEN).toBe("managed-token");
    } finally {
      if (originalGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalGitHubToken;
      if (originalGhToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalGhToken;
    }
  });

  test("declares capabilities that keep unsupported server requests out of the flow", async () => {
    const h = harness();
    await h.supervisor.ensureReady();

    const params = h.children[0]!.stdin.parsed()[0]!.params as {
      capabilities: Record<string, boolean>;
      clientInfo: Record<string, string>;
    };
    expect(params.capabilities).toEqual({
      experimentalApi: false,
      requestAttestation: false,
      mcpServerOpenaiFormElicitation: true,
    });
    // Identifying as Orkestrator drives app-server's compliance logging.
    expect(params.clientInfo.name).toBe("orkestrator");
  });

  test("passes --stdio and config overrides without a shell", async () => {
    const spawnCalls: Array<{
      command: string;
      args: string[];
      options: Record<string, unknown>;
    }> = [];
    const h = harness({
      supervisor: {
        configOverrides: { "features.goals": "true" },
        spawnProcess: ((
          command: string,
          args: string[],
          spawnOptions: Record<string, unknown>,
        ) => {
          spawnCalls.push({ command, args, options: spawnOptions });
          return new FakeChild(4242);
        }) as unknown as AppServerSupervisorOptions["spawnProcess"],
      },
    });
    await h.supervisor.ensureReady();

    expect(spawnCalls[0]!.args).toEqual([
      "app-server",
      "--stdio",
      "-c",
      "features.goals=true",
    ]);
    expect(spawnCalls[0]!.options.shell).toBe(false);
    expect(spawnCalls[0]!.options.cwd).toBe("/tmp/workspace");
  });

  test("passes the agent MCP connection to the app-server as safe config overrides", async () => {
    const spawnCalls: Array<{
      args: string[];
      options: Record<string, unknown>;
    }> = [];
    const configOverrides = codexAppServerConfigOverrides({
      [ORKESTRATOR_AGENT_MCP_URL_ENV]: "http://127.0.0.1:4567/mcp",
      [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: "project-secret",
    });
    const h = harness({
      supervisor: {
        configOverrides,
        spawnProcess: ((
          _command: string,
          args: string[],
          spawnOptions: Record<string, unknown>,
        ) => {
          spawnCalls.push({ args, options: spawnOptions });
          return new FakeChild(4242);
        }) as unknown as AppServerSupervisorOptions["spawnProcess"],
      },
    });

    await h.supervisor.ensureReady();

    expect(spawnCalls[0]!.args).toContain("mcp_servers.orkestrator.url=\"http://127.0.0.1:4567/mcp\"");
    expect(spawnCalls[0]!.args).toContain(
      `mcp_servers.orkestrator.bearer_token_env_var="${ORKESTRATOR_AGENT_MCP_TOKEN_ENV}"`,
    );
    expect(spawnCalls[0]!.args.join(" ")).not.toContain("project-secret");
    expect(spawnCalls[0]!.options.shell).toBe(false);
  });

  test("reports the codex version from the initialize user agent", async () => {
    const h = harness();
    await h.supervisor.ensureReady();
    expect(h.supervisor.getHealth().codexVersion).toBe("0.145.0");
    expect(h.supervisor.getHealth().codexHome).toBe("/tmp/codex-home");
  });

  test("suppresses stderr payloads that may contain prompts or file contents", async () => {
    const h = harness();
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await h.supervisor.ensureReady();
      h.children[0]!.stderr.emitData(
        '{"level":"error","target":"codex_core::exec","code":"EACCES","message":"sentinel-private-prompt","fields":{"file":"/secret/path"}}\n',
      );
      h.children[0]!.stderr.emitData("sentinel-private-file-content\n");

      const output = error.mock.calls.flat().map(String).join("\n");
      // The envelope is what makes a bad `-c` override or an unusable
      // CODEX_HOME diagnosable at all.
      expect(output).toContain("level=error");
      expect(output).toContain("target=codex_core::exec");
      expect(output).toContain("code=EACCES");
      // The payload never is.
      expect(output).not.toContain("sentinel-private-prompt");
      expect(output).not.toContain("sentinel-private-file-content");
      expect(output).not.toContain("/secret/path");
      // An unstructured line is reported by size only.
      expect(output).toContain("unstructured (29 bytes suppressed)");
    } finally {
      error.mockRestore();
    }
  });

  test("reports suppressed stderr line and byte counts when the child dies", async () => {
    const h = harness();
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await h.supervisor.ensureReady();
      h.children[0]!.stderr.emitData('{"level":"warn"}\nplain text\n');
      // A line without its terminator still has to be accounted for.
      h.children[0]!.stderr.emitData('{"level":"error"}');
      error.mockClear();
      h.children[0]!.exit(1);

      const output = error.mock.calls.flat().map(String).join("\n");
      expect(output).toMatch(
        /suppressed 3 stderr line\(s\) \(\d+ bytes of payload\)/,
      );
    } finally {
      error.mockRestore();
    }
  });

  test("logs metadata for a bounded number of stderr lines, then only counts", async () => {
    const h = harness();
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await h.supervisor.ensureReady();
      error.mockClear();
      const budget = __testing.STDERR_METADATA_LINE_BUDGET;
      for (let index = 0; index < budget + 10; index += 1) {
        h.children[0]!.stderr.emitData('{"level":"info"}\n');
      }
      expect(error).toHaveBeenCalledTimes(budget);

      error.mockClear();
      h.children[0]!.exit(0);
      const output = error.mock.calls.flat().map(String).join("\n");
      expect(output).toContain(`suppressed ${budget + 10} stderr line(s)`);
    } finally {
      error.mockRestore();
    }
  });

  test("reaps only a positively identified orphan and ignores PID reuse", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "supervisor-pidfile-"));
    temporaryDirectories.push(codexHome);
    const signalled: number[] = [];
    const make = (matches: boolean) =>
      harness({
        supervisor: {
          codexHome,
          pidFileEnabled: true,
          isProcessAlive: (pid) => pid === 4242,
          matchesPidFileProcess: async () => matches,
          signalPidFileProcess: (pid) => signalled.push(pid),
        },
      });

    const first = make(false);
    const pidFilePath = (
      first.supervisor as unknown as {
        pidFilePath: () => string;
      }
    ).pidFilePath();
    const writeRecord = () => {
      mkdirSync(dirname(pidFilePath), { recursive: true });
      writeFileSync(
        pidFilePath,
        JSON.stringify({
          pid: 4242,
          bridgePid: 3131,
          cwd: "/tmp/workspace",
          startedAt: new Date().toISOString(),
          instanceId: "instance-token",
        }),
        "utf8",
      );
    };
    // The owning bridge is considered dead; the child PID exists but does not
    // match the random instance token, as happens after PID reuse.
    writeRecord();
    await first.supervisor.ensureReady();
    expect(signalled).toEqual([]);

    const second = make(true);
    writeRecord();
    await second.supervisor.ensureReady();
    expect(signalled).toEqual([4242]);
  });

  test("does not take over or erase a pidfile owned by another live bridge", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "supervisor-live-owner-"));
    temporaryDirectories.push(codexHome);
    const h = harness({
      supervisor: {
        codexHome,
        pidFileEnabled: true,
        circuitBreakerThreshold: 1,
        isProcessAlive: (pid) => pid === 3131,
      },
    });
    const pidFilePath = (
      h.supervisor as unknown as {
        pidFilePath: () => string;
      }
    ).pidFilePath();
    mkdirSync(dirname(pidFilePath), { recursive: true });
    const record = JSON.stringify({
      pid: 4242,
      bridgePid: 3131,
      cwd: "/tmp/workspace",
      startedAt: new Date().toISOString(),
      instanceId: "live-owner",
    });
    writeFileSync(pidFilePath, record, "utf8");

    const rejection = await h.supervisor
      .ensureReady()
      .then(() => null, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(AppServerOwnershipUnavailableError);
    // Contention is not this bridge's fault: counting it would trip a breaker
    // that nothing resets, locking the workspace out for good.
    expect(h.supervisor.getHealth().circuitOpen).toBe(false);
    // The path is in the message so a stuck user can see what to inspect.
    expect((rejection as Error).message).toContain(pidFilePath);
    expect(h.children).toHaveLength(0);
    expect(await Bun.file(pidFilePath).text()).toBe(record);
  });

  test("atomically admits only one of two simultaneous supervisors", async () => {
    const codexHome = mkdtempSync(
      join(tmpdir(), "supervisor-contended-owner-"),
    );
    temporaryDirectories.push(codexHome);
    let arrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const refreshEnvironment = async () => {
      arrivals += 1;
      if (arrivals === 2) releaseBarrier();
      await barrier;
    };
    const unsafeSignals: number[] = [];
    const make = () =>
      harness({
        supervisor: {
          codexHome,
          pidFileEnabled: true,
          circuitBreakerThreshold: 1,
          refreshEnvironment,
          isProcessAlive: (pid) => pid === process.pid,
          signalPidFileProcess: (pid) => unsafeSignals.push(pid),
        },
      });
    const first = make();
    const second = make();

    const results = await Promise.allSettled([
      first.supervisor.ensureReady(),
      second.supervisor.ensureReady(),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(first.children.length + second.children.length).toBe(1);
    expect(unsafeSignals).toEqual([]);

    // Mark the fake child exited before cleanup so the test cannot send an OS
    // signal to a fabricated PID.
    const winner = first.children.length === 1 ? first : second;
    winner.children[0]!.exit(0);
    await Promise.all([first.supervisor.stop(), second.supervisor.stop()]);
  });

  test("two stale-owner reclaimers cannot remove the winning replacement", async () => {
    const codexHome = mkdtempSync(
      join(tmpdir(), "supervisor-stale-contention-"),
    );
    temporaryDirectories.push(codexHome);
    let arrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const refreshEnvironment = async () => {
      arrivals += 1;
      if (arrivals === 2) releaseBarrier();
      await barrier;
    };
    const unsafeSignals: number[] = [];
    const make = () =>
      harness({
        supervisor: {
          codexHome,
          pidFileEnabled: true,
          circuitBreakerThreshold: 1,
          refreshEnvironment,
          isProcessAlive: (pid) => pid === process.pid,
          signalPidFileProcess: (pid) => unsafeSignals.push(pid),
        },
      });
    const first = make();
    const second = make();
    const pidFilePath = (
      first.supervisor as unknown as {
        pidFilePath: () => string;
      }
    ).pidFilePath();
    mkdirSync(dirname(pidFilePath), { recursive: true });
    writeFileSync(
      pidFilePath,
      JSON.stringify({
        pid: 4242,
        bridgePid: 3131,
        cwd: "/tmp/workspace",
        startedAt: "2026-07-25T12:00:00.000Z",
        instanceId: "stale-child",
      }),
      "utf8",
    );

    const results = await Promise.allSettled([
      first.supervisor.ensureReady(),
      second.supervisor.ensureReady(),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(first.children.length + second.children.length).toBe(1);
    expect(unsafeSignals).toEqual([]);

    const winner = first.children.length === 1 ? first : second;
    winner.children[0]!.exit(0);
    await Promise.all([first.supervisor.stop(), second.supervisor.stop()]);
  });

  test("token-checked shutdown does not remove replacement ownership", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "supervisor-replaced-owner-"));
    temporaryDirectories.push(codexHome);
    const h = harness({
      supervisor: {
        codexHome,
        pidFileEnabled: true,
        isProcessAlive: (pid) => pid === process.pid,
      },
    });
    await h.supervisor.ensureReady();
    const pidFilePath = (
      h.supervisor as unknown as {
        pidFilePath: () => string;
      }
    ).pidFilePath();
    const replacement = JSON.stringify({
      ownerToken: "replacement-owner",
      bridgePid: process.pid,
      cwd: "/tmp/workspace",
      acquiredAt: new Date().toISOString(),
    });
    writeFileSync(pidFilePath, replacement, "utf8");

    h.children[0]!.exit(0);
    await h.supervisor.stop();

    expect(await Bun.file(pidFilePath).text()).toBe(replacement);
  });

  test("retries when initialize is refused, then succeeds", async () => {
    const h = harness({ behaviours: [{ failInitialize: true }, {}] });
    await h.supervisor.ensureReady();

    expect(h.supervisor.getState()).toBe("ready");
    expect(h.children).toHaveLength(2);
    expect(h.states.some((entry) => entry.state === "backoff")).toBe(true);
  });

  test("a spawn without a pid fails rather than producing a half-live generation", async () => {
    const h = harness({
      supervisor: {
        spawnProcess: (() =>
          new FakeChild(
            undefined,
          )) as unknown as AppServerSupervisorOptions["spawnProcess"],
        circuitBreakerThreshold: 1,
      },
    });

    await expect(h.supervisor.ensureReady()).rejects.toBeInstanceOf(
      AppServerCircuitOpenError,
    );
  });

  test("concurrent ensureReady calls share one startup", async () => {
    const h = harness();
    const [first, second, third] = await Promise.all([
      h.supervisor.ensureReady(),
      h.supervisor.ensureReady(),
      h.supervisor.ensureReady(),
    ]);

    expect(h.children).toHaveLength(1);
    expect(first.id).toBe(second.id);
    expect(second.id).toBe(third.id);
  });
});

describe("circuit breaker", () => {
  test("stops retrying after repeated failures in the window", async () => {
    const h = harness({
      behaviours: Array.from({ length: 10 }, () => ({ failInitialize: true })),
      supervisor: { circuitBreakerThreshold: 3 },
    });

    await expect(h.supervisor.ensureReady()).rejects.toBeInstanceOf(
      AppServerCircuitOpenError,
    );
    // Bounded attempts, not an infinite restart loop.
    expect(h.children).toHaveLength(3);
    expect(h.supervisor.getState()).toBe("failed");
    expect(h.supervisor.getHealth().circuitOpen).toBe(true);
  });

  test("stays open on later calls so health can report terminal failure", async () => {
    const h = harness({
      behaviours: Array.from({ length: 10 }, () => ({ failInitialize: true })),
      supervisor: { circuitBreakerThreshold: 2 },
    });

    await expect(h.supervisor.ensureReady()).rejects.toBeInstanceOf(
      AppServerCircuitOpenError,
    );
    const spawnedAfterFirstFailure = h.children.length;
    await expect(h.supervisor.ensureReady()).rejects.toBeInstanceOf(
      AppServerCircuitOpenError,
    );
    // No further spawn attempts once the breaker is open.
    expect(h.children).toHaveLength(spawnedAfterFirstFailure);
  });

  test("failures outside the rolling window do not accumulate", async () => {
    let clock = 0;
    const h = harness({
      behaviours: [{ failInitialize: true }, { failInitialize: true }, {}],
      supervisor: {
        circuitBreakerThreshold: 3,
        circuitWindowMs: 1_000,
        now: () => {
          clock += 5_000;
          return clock;
        },
      },
    });

    // Each failure is 5s apart with a 1s window, so the breaker never trips.
    await h.supervisor.ensureReady();
    expect(h.supervisor.getState()).toBe("ready");
  });
});

describe("unexpected exit", () => {
  test("rejects in-flight requests ambiguously and marks the generation dead", async () => {
    const h = harness();
    await h.supervisor.ensureReady();

    const inFlight = h.supervisor.request("thread/read", { threadId: "t1" });
    h.children[0]!.exit(1);

    const error = await inFlight.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppServerProcessExitError);
    // The write may have landed, so this must never be auto-retried.
    expect(classifyDispatchFailure(error)).toBe("ambiguous");
    expect(h.supervisor.isReady()).toBe(false);
    expect(h.supervisor.getState()).toBe("restarting");
  });

  test("the next request starts a new generation and reports the handover", async () => {
    const h = harness();
    await h.supervisor.ensureReady();
    h.children[0]!.exit(1);

    const generation = await h.supervisor.ensureReady();
    expect(generation.id).toBe(2);
    expect(h.supervisor.getHealth().restartCount).toBe(1);
    // Callers use this to re-read or resume their threads.
    expect(h.generationReady).toEqual([{ generation: 2, previous: 1 }]);
  });

  test("notifications are tagged with the generation that produced them", async () => {
    const h = harness();
    await h.supervisor.ensureReady();
    h.children[0]!.stdout.pushMessage({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "t1", turn: { id: "turn-1" } },
    });

    h.children[0]!.exit(1);
    await h.supervisor.ensureReady();
    h.children[1]!.stdout.pushMessage({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "t1", turn: { id: "turn-2" } },
    });

    // Stale-generation events are identifiable and therefore discardable.
    expect(h.notifications.map((entry) => entry.generation)).toEqual([1, 2]);
  });

  test("records the exit code and signal for health", async () => {
    const h = harness();
    await h.supervisor.ensureReady();
    h.children[0]!.exit(null, "SIGSEGV");

    const health = h.supervisor.getHealth();
    expect(health.lastExitSignal).toBe("SIGSEGV");
  });

  test("refuses to answer a server request from a dead generation", async () => {
    const h = harness();
    await h.supervisor.ensureReady();
    const firstChild = h.children[0]!;
    firstChild.exit(1);
    await h.supervisor.ensureReady();

    // Generation 1 is gone; app-server has forgotten the request.
    await h.supervisor.respondToServerRequest(1, "srv-1", {
      decision: "denied",
    });
    expect(firstChild.stdin.parsed().some((m) => m.id === "srv-1")).toBe(false);

    await h.supervisor.respondToServerRequest(2, "srv-2", {
      decision: "denied",
    });
    expect(h.children[1]!.stdin.parsed().some((m) => m.id === "srv-2")).toBe(
      true,
    );
  });
});

describe("environment fingerprint", () => {
  test("no restart when the environment is unchanged", async () => {
    const h = harness();
    await h.supervisor.ensureReady();

    const result = await h.supervisor.ensureEnvironmentIsCurrent({
      hasActiveTurns: () => false,
      waitForIdle: async () => undefined,
    });

    expect(result.restarted).toBe(false);
    expect(h.children).toHaveLength(1);
  });

  test("restarts when PATH changed and nothing is running", async () => {
    const h = harness();
    await h.supervisor.ensureReady();

    // A persistent child snapshots its environment at launch, so a PATH change
    // means it is serving stale tool lookups until replaced.
    h.setFingerprint("sha256:after-a-tool-was-installed");
    const result = await h.supervisor.ensureEnvironmentIsCurrent({
      hasActiveTurns: () => false,
      waitForIdle: async () => undefined,
    });

    expect(result.restarted).toBe(true);
    expect(h.children).toHaveLength(2);
    expect(h.supervisor.getState()).toBe("ready");
  });

  test("waits for active turns to settle before restarting", async () => {
    const h = harness();
    await h.supervisor.ensureReady();
    h.setFingerprint("sha256:changed");

    let settled = false;
    const drainStates: EngineState[] = [];
    await h.supervisor.ensureEnvironmentIsCurrent({
      hasActiveTurns: () => !settled,
      waitForIdle: async () => {
        drainStates.push(h.supervisor.getState());
        settled = true;
      },
    });

    // New turns are blocked while draining, rather than killed mid-command.
    expect(drainStates).toEqual(["draining"]);
    expect(h.children).toHaveLength(2);
  });

  test("exposes only a digest, never the underlying values", async () => {
    const h = harness({ supervisor: { fingerprintEnvironment: undefined } });
    await h.supervisor.ensureReady();

    const fingerprint = h.supervisor.getHealth().environmentFingerprint;
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{32}$/);
    expect(fingerprint).not.toContain(process.env.PATH?.slice(0, 12) ?? " ");
  });
});

describe("shutdown", () => {
  test("stop terminates a child whose initialize handshake is still pending", async () => {
    const h = harness({ behaviours: [{ hangInitialize: true }] });
    const startupResult = h.supervisor
      .ensureReady()
      .then(() => null, (error: unknown) => error);
    await flushMicrotasks();
    expect(h.children).toHaveLength(1);
    expect(h.children[0]!.stdin.parsed()[0]?.method).toBe("initialize");

    await h.supervisor.stop();

    expect(await startupResult).toBeInstanceOf(AppServerUnavailableError);
    expect(h.children[0]!.killed.length).toBeGreaterThan(0);
    expect(h.supervisor.getState()).toBe("stopped");
    expect(h.supervisor.isReady()).toBe(false);
  });

  test("closes stdin then escalates to the process group", async () => {
    const h = harness();
    await h.supervisor.ensureReady();
    const child = h.children[0]!;

    await h.supervisor.stop();

    expect(
      child.stdin.writableEnded ||
        child.exitCode !== null ||
        child.signalCode !== null,
    ).toBe(true);
    expect(h.supervisor.getState()).toBe("stopped");
  });

  test("a stopped supervisor refuses new work instead of respawning", async () => {
    const h = harness();
    await h.supervisor.ensureReady();
    await h.supervisor.stop();

    await expect(h.supervisor.request("thread/read")).rejects.toThrow(
      /stopped/,
    );
    expect(h.children).toHaveLength(1);
  });

  test("exit during shutdown does not schedule a restart", async () => {
    const h = harness();
    await h.supervisor.ensureReady();
    await h.supervisor.stop();

    expect(h.supervisor.getState()).toBe("stopped");
    expect(h.children).toHaveLength(1);
  });

  test("explicit restart advances the generation", async () => {
    const h = harness();
    await h.supervisor.ensureReady();
    await h.supervisor.restartNow("test reason");

    expect(h.supervisor.getGeneration()).toBe(2);
    expect(h.children).toHaveLength(2);
  });
});

describe("pidfile ownership acquisition", () => {
  test.skipIf(RUNNING_AS_ROOT)(
    "an unwritable pidfile directory fails fast instead of spinning",
    async () => {
      const codexHome = temporaryCodexHome("supervisor-unwritable-");
      const h = harness({
        supervisor: {
          codexHome,
          pidFileEnabled: true,
          // The recorded bridge is dead, so the record looks reclaimable...
          isProcessAlive: () => false,
          matchesPidFileProcess: async () => false,
          signalPidFileProcess: () => undefined,
        },
      });
      const pidFilePath = internals(h.supervisor).pidFilePath();
      const record = writePidRecord(pidFilePath, {
        ownerToken: "dead-owner",
        bridgePid: 3131,
        cwd: "/tmp/workspace",
        acquiredAt: new Date().toISOString(),
        pid: 4242,
        startedAt: new Date().toISOString(),
        instanceId: "stale-instance",
      });
      // ...but the quarantine rename cannot succeed, so "reclaimed" was a lie
      // and the acquisition loop re-observed the same record forever.
      chmodSync(dirname(pidFilePath), 0o500);

      const startedAt = Date.now();
      try {
        await expect(h.supervisor.ensureReady()).rejects.toBeInstanceOf(
          AppServerOwnershipUnavailableError,
        );
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(h.children).toHaveLength(0);
        expect(readFileSync(pidFilePath, "utf8")).toBe(record);
      } finally {
        chmodSync(dirname(pidFilePath), 0o700);
      }
    },
  );

  test("a bridge PID that is alive but unrelated does not lock the workspace out for good", async () => {
    const codexHome = temporaryCodexHome("supervisor-recycled-pid-");
    let clockOffsetMs = 0;
    const h = harness({
      behaviours: [{ pid: UNMAPPED_PID }],
      supervisor: {
        codexHome,
        pidFileEnabled: true,
        circuitBreakerThreshold: 1,
        // Stands in for a recycled PID: alive, but nothing to do with us.
        isProcessAlive: (pid) => pid === 3131,
        matchesPidFileProcess: async () => false,
        signalPidFileProcess: () => undefined,
        now: () => Date.now() + clockOffsetMs,
      },
    });
    const pidFilePath = internals(h.supervisor).pidFilePath();
    writePidRecord(pidFilePath, {
      ownerToken: "foreign-owner",
      bridgePid: 3131,
      cwd: "/tmp/workspace",
      acquiredAt: new Date().toISOString(),
      pid: 4242,
      startedAt: new Date().toISOString(),
      instanceId: "foreign-instance",
    });

    await expect(h.supervisor.ensureReady()).rejects.toBeInstanceOf(
      AppServerOwnershipUnavailableError,
    );
    expect(h.supervisor.getHealth().circuitOpen).toBe(false);

    // The escape hatch: past the TTL the record is abandoned regardless of what
    // the PID looks like, because a PID alone never proved identity.
    clockOffsetMs = __testing.PID_OWNERSHIP_TTL_MS + 60_000;
    await h.supervisor.ensureReady();
    expect(h.supervisor.getState()).toBe("ready");
    expect(h.children).toHaveLength(1);
    h.children[0]!.exit(0);
  });

  test("a vanished pidfile drops the claim so the next start re-acquires it", async () => {
    const codexHome = temporaryCodexHome("supervisor-vanished-pidfile-");
    const h = harness({
      behaviours: [
        { pid: UNMAPPED_PID },
        { pid: UNMAPPED_PID },
        { pid: UNMAPPED_PID },
      ],
      supervisor: {
        codexHome,
        pidFileEnabled: true,
        isProcessAlive: (pid) => pid === process.pid,
      },
    });
    await h.supervisor.ensureReady();
    const pidFilePath = internals(h.supervisor).pidFilePath();

    // Something outside the bridge cleaned CODEX_HOME while we held ownership.
    rmSync(pidFilePath);
    h.children[0]!.exit(1);

    await h.supervisor.ensureReady();
    expect(h.supervisor.getState()).toBe("ready");
    expect(h.supervisor.getHealth().circuitOpen).toBe(false);
    expect(existsSync(pidFilePath)).toBe(true);
    // The restart attempt that found the record missing is what dropped the
    // stale claim; without it every later attempt failed identically.
    expect(h.supervisor.getHealth().lastError).toContain("is unreadable");
    expect(h.children).toHaveLength(3);
    h.children.at(-1)!.exit(0);
  });

  test("a corrupt pidfile under our own claim is re-acquired rather than wedged", async () => {
    const codexHome = temporaryCodexHome("supervisor-corrupt-pidfile-");
    const h = harness({
      supervisor: {
        codexHome,
        pidFileEnabled: true,
        isProcessAlive: (pid) => pid === process.pid,
      },
    });
    await h.supervisor.ensureReady();
    const pidFilePath = internals(h.supervisor).pidFilePath();
    writeFileSync(pidFilePath, "{not json", "utf8");

    await expect(
      internals(h.supervisor).updateOwnedPidFile(4242, "instance", Date.now()),
    ).rejects.toThrow(/not a valid ownership record/);
    expect(internals(h.supervisor).pidOwnershipHeld).toBe(false);
    h.children[0]!.exit(0);
  });

  test("updateOwnedPidFile refuses to publish once the token changed", async () => {
    const codexHome = temporaryCodexHome("supervisor-token-changed-");
    const h = harness({
      supervisor: {
        codexHome,
        pidFileEnabled: true,
        isProcessAlive: (pid) => pid === process.pid,
      },
    });
    await h.supervisor.ensureReady();
    const pidFilePath = internals(h.supervisor).pidFilePath();
    const replacement = JSON.stringify({
      ownerToken: "replacement-owner",
      bridgePid: process.pid,
      cwd: "/tmp/workspace",
      acquiredAt: new Date().toISOString(),
    });
    writeFileSync(pidFilePath, replacement, "utf8");

    await expect(
      internals(h.supervisor).updateOwnedPidFile(4242, "instance", Date.now()),
    ).rejects.toThrow(/ownership changed before child publication/);
    expect(internals(h.supervisor).pidOwnershipHeld).toBe(false);
    // The replacement owner's record is left exactly as it was.
    expect(readFileSync(pidFilePath, "utf8")).toBe(replacement);
    h.children[0]!.exit(0);
  });

  test("updateOwnedPidFile re-validates the token immediately before publishing", async () => {
    const codexHome = temporaryCodexHome("supervisor-token-race-");
    let hijackOnNextClockRead = false;
    let pidFilePath = "";
    const h = harness({
      supervisor: {
        codexHome,
        pidFileEnabled: true,
        isProcessAlive: (pid) => pid === process.pid,
        // `now()` is read while the payload is built — after the first token
        // check and before the second — which is the only hook that lands a
        // contender between the two reads deterministically.
        now: () => {
          if (hijackOnNextClockRead) {
            hijackOnNextClockRead = false;
            writeFileSync(
              pidFilePath,
              JSON.stringify({ ownerToken: "late-replacement" }),
              "utf8",
            );
          }
          return Date.now();
        },
      },
    });
    await h.supervisor.ensureReady();
    pidFilePath = internals(h.supervisor).pidFilePath();
    // A record with our token but no `acquiredAt`, so the payload build reads
    // the clock.
    writeFileSync(
      pidFilePath,
      JSON.stringify({ ownerToken: internals(h.supervisor).pidOwnerToken }),
      "utf8",
    );
    hijackOnNextClockRead = true;

    await expect(
      internals(h.supervisor).updateOwnedPidFile(4242, "instance", Date.now()),
    ).rejects.toThrow(/ownership changed before child publication/);
    expect(JSON.parse(readFileSync(pidFilePath, "utf8")).ownerToken).toBe(
      "late-replacement",
    );
    h.children[0]!.exit(0);
  });

  test("a failed pidfile publication terminates the child it just spawned", async () => {
    const codexHome = temporaryCodexHome("supervisor-publish-failure-");
    const children: FakeChild[] = [];
    let pidFilePath = "";
    const supervisor = new AppServerSupervisor({
      codexPath: "/fake/codex",
      cwd: "/tmp/workspace",
      codexHome,
      clientInfo: { name: "orkestrator", title: "O", version: "2.4.9" },
      pidFileEnabled: true,
      shutdownGraceMs: 20,
      backoffScheduleMs: [1],
      circuitBreakerThreshold: 1,
      refreshEnvironment: async () => undefined,
      fingerprintEnvironment: () => "sha256:test",
      isProcessAlive: (pid) => pid === process.pid,
      onNotification: () => undefined,
      onServerRequest: () => undefined,
      spawnProcess: (() => {
        // Ownership is stolen in the window between spawn and publication.
        writeFileSync(
          pidFilePath,
          JSON.stringify({ ownerToken: "stolen" }),
          "utf8",
        );
        const child = new FakeChild(UNMAPPED_PID);
        children.push(child);
        return child;
      }) as unknown as AppServerSupervisorOptions["spawnProcess"],
    });
    pidFilePath = internals(supervisor).pidFilePath();

    await expect(supervisor.ensureReady()).rejects.toBeInstanceOf(
      AppServerCircuitOpenError,
    );
    expect(children).toHaveLength(1);
    // A child left running here would race the next owner over CODEX_HOME.
    expect(
      children[0]!.exitCode !== null || children[0]!.signalCode !== null,
    ).toBe(true);
  });
});

describe("reclaimStalePidFile", () => {
  const makeHarness = (
    codexHome: string,
    overrides: Partial<AppServerSupervisorOptions> = {},
  ) =>
    harness({
      behaviours: [{ pid: UNMAPPED_PID }],
      supervisor: {
        codexHome,
        pidFileEnabled: true,
        isProcessAlive: () => false,
        signalPidFileProcess: () => undefined,
        ...overrides,
      },
    });

  test("reaps a current-format record whose owning bridge is gone", async () => {
    const codexHome = temporaryCodexHome("supervisor-current-format-");
    const signalled: number[] = [];
    const h = makeHarness(codexHome, {
      isProcessAlive: (pid) => pid === 4242,
      matchesPidFileProcess: async () => true,
      signalPidFileProcess: (pid) => signalled.push(pid),
    });
    const pidFilePath = internals(h.supervisor).pidFilePath();
    // Every other fixture writes the pre-token shape, so this is the only test
    // that exercises the `ownerToken` + `acquiredAt` validation.
    writePidRecord(pidFilePath, {
      ownerToken: "dead-owner",
      bridgePid: 3131,
      cwd: "/tmp/workspace",
      acquiredAt: new Date().toISOString(),
      pid: 4242,
      startedAt: new Date().toISOString(),
      instanceId: "stale-instance",
    });

    await expect(internals(h.supervisor).reclaimStalePidFile()).resolves.toBe(
      true,
    );
    expect(signalled).toEqual([4242]);
    expect(existsSync(pidFilePath)).toBe(false);
  });

  test("leaves an incomplete record alone inside the publication grace window", async () => {
    const codexHome = temporaryCodexHome("supervisor-grace-window-");
    const h = makeHarness(codexHome);
    const pidFilePath = internals(h.supervisor).pidFilePath();
    // A winner mid-publication looks exactly like this.
    const record = writePidRecord(pidFilePath, { ownerToken: "half-written" });

    await expect(internals(h.supervisor).reclaimStalePidFile()).resolves.toBe(
      false,
    );
    expect(readFileSync(pidFilePath, "utf8")).toBe(record);
  });

  test("removes an unparseable record once the grace window has passed", async () => {
    const codexHome = temporaryCodexHome("supervisor-past-grace-");
    const h = makeHarness(codexHome);
    const pidFilePath = internals(h.supervisor).pidFilePath();
    mkdirSync(dirname(pidFilePath), { recursive: true });
    writeFileSync(pidFilePath, "{ truncated", "utf8");
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(pidFilePath, longAgo, longAgo);

    await expect(internals(h.supervisor).reclaimStalePidFile()).resolves.toBe(
      true,
    );
    expect(existsSync(pidFilePath)).toBe(false);
  });

  test("treats a missing record as reclaimable", async () => {
    const codexHome = temporaryCodexHome("supervisor-missing-record-");
    const h = makeHarness(codexHome);
    mkdirSync(dirname(internals(h.supervisor).pidFilePath()), {
      recursive: true,
    });

    // `stat` throwing is the "it is already gone" case.
    await expect(internals(h.supervisor).reclaimStalePidFile()).resolves.toBe(
      true,
    );
  });

  test.skipIf(RUNNING_AS_ROOT)(
    "an unreadable record is not reclaimed, so acquisition cannot spin on it",
    async () => {
      const codexHome = temporaryCodexHome("supervisor-unreadable-record-");
      const h = makeHarness(codexHome);
      const pidFilePath = internals(h.supervisor).pidFilePath();
      mkdirSync(dirname(pidFilePath), { recursive: true });
      writeFileSync(pidFilePath, "{}", "utf8");
      const longAgo = new Date(Date.now() - 60_000);
      utimesSync(pidFilePath, longAgo, longAgo);
      chmodSync(pidFilePath, 0o200);

      try {
        await expect(
          internals(h.supervisor).reclaimStalePidFile(),
        ).resolves.toBe(false);
      } finally {
        chmodSync(pidFilePath, 0o600);
      }
    },
  );

  test("signals a pre-token record only when the PID really is our app-server", async () => {
    const codexHome = temporaryCodexHome("supervisor-legacy-record-");
    const signalled: number[] = [];
    const legacyRecord = {
      // The shape written by the release before instance tokens existed.
      pid: 4242,
      bridgePid: 3131,
      cwd: "/tmp/workspace",
      startedAt: new Date().toISOString(),
    };

    const matching = makeHarness(codexHome, {
      isProcessAlive: (pid) => pid === 4242,
      matchesLegacyAppServerProcess: async () => true,
      signalPidFileProcess: (pid) => signalled.push(pid),
    });
    writePidRecord(internals(matching.supervisor).pidFilePath(), legacyRecord);
    await expect(
      internals(matching.supervisor).reclaimStalePidFile(),
    ).resolves.toBe(true);
    expect(signalled).toEqual([4242]);

    const notMatching = makeHarness(codexHome, {
      isProcessAlive: (pid) => pid === 4242,
      matchesLegacyAppServerProcess: async () => false,
      signalPidFileProcess: (pid) => signalled.push(pid),
    });
    writePidRecord(
      internals(notMatching.supervisor).pidFilePath(),
      legacyRecord,
    );
    await expect(
      internals(notMatching.supervisor).reclaimStalePidFile(),
    ).resolves.toBe(true);
    // Still only the first reap: an unidentifiable PID is never signalled.
    expect(signalled).toEqual([4242]);
  });

  test("does not evict a pre-token record whose bridge is still running", async () => {
    const codexHome = temporaryCodexHome("supervisor-legacy-live-");
    const h = makeHarness(codexHome, {
      isProcessAlive: (pid) => pid === 3131,
      matchesLegacyAppServerProcess: async () => true,
    });
    const pidFilePath = internals(h.supervisor).pidFilePath();
    const record = writePidRecord(pidFilePath, {
      pid: 4242,
      bridgePid: 3131,
      cwd: "/tmp/workspace",
      startedAt: new Date().toISOString(),
    });

    await expect(internals(h.supervisor).reclaimStalePidFile()).resolves.toBe(
      false,
    );
    expect(readFileSync(pidFilePath, "utf8")).toBe(record);
  });
});

describe("pidfile quarantine", () => {
  test("restores the record by rename when hardlinking is unavailable", async () => {
    const codexHome = temporaryCodexHome("supervisor-link-eperm-");
    const h = harness({
      supervisor: {
        codexHome,
        pidFileEnabled: true,
        linkFile: async () => {
          const error: NodeJS.ErrnoException = new Error("operation not permitted");
          error.code = "EPERM";
          throw error;
        },
      },
    });
    const pidFilePath = internals(h.supervisor).pidFilePath();
    const successor = writePidRecord(pidFilePath, {
      ownerToken: "successor",
      bridgePid: process.pid,
      cwd: "/tmp/workspace",
      acquiredAt: new Date().toISOString(),
    });

    // We observed a different record than what is on disk now, so the successor
    // must survive even though the restore hardlink fails.
    await expect(
      internals(h.supervisor).quarantineObservedPidFile("{}"),
    ).resolves.toBe("contended");
    expect(readFileSync(pidFilePath, "utf8")).toBe(successor);
    expect(
      existsSync(
        `${pidFilePath}.${internals(h.supervisor).pidOwnerToken}.stale`,
      ),
    ).toBe(false);
  });

  test("reports the difference between a vanished record and a blocked rename", async () => {
    const codexHome = temporaryCodexHome("supervisor-quarantine-outcome-");
    const h = harness({ supervisor: { codexHome, pidFileEnabled: true } });
    const pidFilePath = internals(h.supervisor).pidFilePath();
    mkdirSync(dirname(pidFilePath), { recursive: true });

    // Nothing to move: safe to retry the acquisition.
    await expect(
      internals(h.supervisor).quarantineObservedPidFile("{}"),
    ).resolves.toBe("contended");

    if (!RUNNING_AS_ROOT) {
      const record = writePidRecord(pidFilePath, { ownerToken: "stuck" });
      chmodSync(dirname(pidFilePath), 0o500);
      try {
        // The record is still exactly where it was, so retrying would spin.
        await expect(
          internals(h.supervisor).quarantineObservedPidFile(record),
        ).resolves.toBe("blocked");
      } finally {
        chmodSync(dirname(pidFilePath), 0o700);
      }
    }
  });

  test("quarantineClaimedPidFile compares the claimed inode before removing", async () => {
    const codexHome = temporaryCodexHome("supervisor-claimed-quarantine-");
    const h = harness({ supervisor: { codexHome, pidFileEnabled: true } });
    const pidFilePath = internals(h.supervisor).pidFilePath();
    mkdirSync(dirname(pidFilePath), { recursive: true });

    // A handle whose identity cannot be read proves nothing, so nothing moves.
    writePidRecord(pidFilePath, { ownerToken: "claimed" });
    await expect(
      internals(h.supervisor).quarantineClaimedPidFile({
        stat: async () => {
          throw new Error("bad handle");
        },
      }),
    ).resolves.toBe(false);
    expect(existsSync(pidFilePath)).toBe(true);

    // Same inode: this really is the file we created, so it is ours to remove.
    const identity = statSync(pidFilePath, { bigint: true });
    await expect(
      internals(h.supervisor).quarantineClaimedPidFile({
        stat: async () => ({ dev: identity.dev, ino: identity.ino }),
      }),
    ).resolves.toBe(true);
    expect(existsSync(pidFilePath)).toBe(false);
  });

  test("quarantineClaimedPidFile restores a replacement it did not create", async () => {
    const codexHome = temporaryCodexHome("supervisor-claimed-replaced-");
    const linkErrors: string[] = [];
    const h = harness({
      supervisor: {
        codexHome,
        pidFileEnabled: true,
        linkFile: async () => {
          linkErrors.push("EPERM");
          const error: NodeJS.ErrnoException = new Error("no hardlinks here");
          error.code = "EPERM";
          throw error;
        },
      },
    });
    const pidFilePath = internals(h.supervisor).pidFilePath();
    const replacement = writePidRecord(pidFilePath, {
      ownerToken: "replacement",
    });

    await expect(
      internals(h.supervisor).quarantineClaimedPidFile({
        stat: async () => ({ dev: 1n, ino: 999_999n }),
      }),
    ).resolves.toBe(false);
    expect(linkErrors).toHaveLength(1);
    // Destroying this record would have left the public path empty while a
    // newer owner believed it held the workspace.
    expect(readFileSync(pidFilePath, "utf8")).toBe(replacement);
  });
});

describe("matchesAppServerInstance", () => {
  const instanceId = "11111111-2222-3333-4444-555555555555";
  const token = `ORKESTRATOR_APP_SERVER_INSTANCE_ID=${instanceId}`;
  const startedAt = Date.parse("Jul 25 2026 17:03:43");
  const cLocaleLstart = "Sat Jul 25 17:03:43 2026\n";

  test("parses only the C-locale start time", () => {
    expect(parseProcessStartTime(cLocaleLstart)).toBe(startedAt);
    // A developer with LC_TIME=fr_FR.UTF-8 used to get NaN here, and reaping
    // silently stopped working for them alone.
    expect(parseProcessStartTime("sam. 25 juil. 17:03:43 2026")).toBeNull();
    expect(parseProcessStartTime("")).toBeNull();
  });

  test("darwin accepts a process carrying the instance token", async () => {
    const calls: string[][] = [];
    await expect(
      __testing.matchesAppServerInstance(
        4242,
        instanceId,
        startedAt,
        "/opt/codex",
        {
          platform: "darwin",
          runPs: async (args) => {
            calls.push(args);
            return args.includes("-Eww")
              ? `/opt/codex app-server --stdio PATH=/usr/bin ${token}\n`
              : cLocaleLstart;
          },
        },
      ),
    ).resolves.toBe(true);
    expect(calls[0]).toContain("-Eww");
  });

  test("darwin refuses a sibling app-server with an identical command line", async () => {
    const calls: string[][] = [];
    await expect(
      __testing.matchesAppServerInstance(
        4242,
        instanceId,
        startedAt,
        "/opt/codex",
        {
          platform: "darwin",
          runPs: async (args) => {
            calls.push(args);
            // Same binary, same arguments, a different environment's token.
            return "/opt/codex app-server --stdio ORKESTRATOR_APP_SERVER_INSTANCE_ID=other\n";
          },
        },
      ),
    ).resolves.toBe(false);
    // The reap is a process-group SIGKILL, so it must stop at the token check.
    expect(calls).toHaveLength(1);
  });

  test("darwin refuses a start time it cannot parse", async () => {
    await expect(
      __testing.matchesAppServerInstance(
        4242,
        instanceId,
        startedAt,
        "/opt/codex",
        {
          platform: "darwin",
          runPs: async (args) =>
            args.includes("-Eww")
              ? `/opt/codex app-server --stdio ${token}\n`
              : "sam. 25 juil. 17:03:43 2026\n",
        },
      ),
    ).resolves.toBe(false);
  });

  test("darwin refuses a start time outside the window", async () => {
    await expect(
      __testing.matchesAppServerInstance(
        4242,
        instanceId,
        startedAt - 60_000,
        "/opt/codex",
        {
          platform: "darwin",
          runPs: async (args) =>
            args.includes("-Eww")
              ? `/opt/codex app-server --stdio ${token}\n`
              : cLocaleLstart,
        },
      ),
    ).resolves.toBe(false);
  });

  test("darwin refuses to signal when ps fails", async () => {
    await expect(
      __testing.matchesAppServerInstance(
        4242,
        instanceId,
        startedAt,
        "/opt/codex",
        {
          platform: "darwin",
          runPs: async () => {
            throw new Error("ps: no such process");
          },
        },
      ),
    ).resolves.toBe(false);
  });

  test("linux requires the token in /proc/<pid>/environ", async () => {
    const probe = (environment: string) => ({
      platform: "linux" as const,
      readProcFile: async (path: string) =>
        Buffer.from(
          path.endsWith("environ")
            ? environment
            : ["/opt/codex", "app-server", "--stdio", ""].join("\0"),
          "utf8",
        ),
    });

    await expect(
      __testing.matchesAppServerInstance(
        4242,
        instanceId,
        startedAt,
        "/opt/codex",
        probe(`PATH=/usr/bin\0${token}\0`),
      ),
    ).resolves.toBe(true);
    await expect(
      __testing.matchesAppServerInstance(
        4242,
        instanceId,
        startedAt,
        "/opt/codex",
        probe("PATH=/usr/bin\0"),
      ),
    ).resolves.toBe(false);
  });

  test("refuses to signal on platforms without an identity check", async () => {
    await expect(
      __testing.matchesAppServerInstance(
        4242,
        instanceId,
        startedAt,
        "/opt/codex",
        { platform: "win32" },
      ),
    ).resolves.toBe(false);
  });

  test.skipIf(process.platform !== "darwin")(
    "the real ps reports a parseable start time for this process",
    async () => {
      const output = await __testing.runPs([
        "-p",
        String(process.pid),
        "-o",
        "lstart=",
      ]);
      const parsed = parseProcessStartTime(output);
      expect(parsed).not.toBeNull();
      expect(Math.abs(Date.now() - (parsed ?? 0))).toBeLessThan(
        24 * 60 * 60 * 1_000,
      );
    },
  );
});

describe("matchesLegacyAppServerProcess", () => {
  test("linux requires our binary, our arguments and our working directory", async () => {
    const probe = (cwd: string) => ({
      platform: "linux" as const,
      readProcFile: async () =>
        Buffer.from(["/opt/codex", "app-server", "--stdio", ""].join("\0")),
      readProcLink: async () => cwd,
    });

    await expect(
      __testing.matchesLegacyAppServerProcess(
        4242,
        "/opt/codex",
        "/work/env-a",
        probe("/work/env-a"),
      ),
    ).resolves.toBe(true);
    // A sibling environment's orphan is someone else's to reap.
    await expect(
      __testing.matchesLegacyAppServerProcess(
        4242,
        "/opt/codex",
        "/work/env-a",
        probe("/work/env-b"),
      ),
    ).resolves.toBe(false);
  });

  test("linux tolerates an unreadable cwd but not a different command", async () => {
    await expect(
      __testing.matchesLegacyAppServerProcess(
        4242,
        "/opt/codex",
        "/work/env-a",
        {
          platform: "linux",
          readProcFile: async () =>
            Buffer.from(["/opt/codex", "app-server", "--stdio", ""].join("\0")),
          readProcLink: async () => {
            throw new Error("EACCES");
          },
        },
      ),
    ).resolves.toBe(true);

    await expect(
      __testing.matchesLegacyAppServerProcess(
        4242,
        "/opt/codex",
        "/work/env-a",
        {
          platform: "linux",
          readProcFile: async () =>
            Buffer.from(["/usr/bin/node", "server.js", ""].join("\0")),
          readProcLink: async () => "/work/env-a",
        },
      ),
    ).resolves.toBe(false);
  });

  test("darwin matches on the command line alone", async () => {
    await expect(
      __testing.matchesLegacyAppServerProcess(4242, "/opt/codex", "/work", {
        platform: "darwin",
        runPs: async () => "/opt/codex app-server --stdio\n",
      }),
    ).resolves.toBe(true);
    await expect(
      __testing.matchesLegacyAppServerProcess(4242, "/opt/codex", "/work", {
        platform: "darwin",
        runPs: async () => "/usr/bin/vim notes.txt\n",
      }),
    ).resolves.toBe(false);
  });

  test("refuses on platforms it cannot inspect", async () => {
    await expect(
      __testing.matchesLegacyAppServerProcess(4242, "/opt/codex", "/work", {
        platform: "win32",
      }),
    ).resolves.toBe(false);
  });
});

describe("process primitives", () => {
  test("isProcessAlive reports our own process and not an impossible one", () => {
    expect(__testing.isProcessAlive(process.pid)).toBe(true);
    expect(__testing.isProcessAlive(UNMAPPED_PID)).toBe(false);
  });

  test("isProcessAlive treats EPERM as alive", () => {
    // PID 1 exists but belongs to root, so a normal user gets EPERM. As root it
    // simply succeeds; either way "alive" is the correct answer.
    expect(__testing.isProcessAlive(1)).toBe(true);
  });

  test("the default reaper swallows a process group that is already gone", () => {
    expect(() => __testing.signalStaleProcessTree(UNMAPPED_PID)).not.toThrow();
  });
});

describe("child stderr metadata", () => {
  test("keeps the envelope and drops the payload", () => {
    const described = __testing.describeChildStderrLine(
      '{"level":"warn","target":"codex_core::mcp","message":"secret prompt text","fields":{"path":"/home/u/notes.md","code":"E42"}}',
    );
    expect(described).toContain("level=warn");
    expect(described).toContain("target=codex_core::mcp");
    expect(described).toContain("code=E42");
    expect(described).not.toContain("secret prompt text");
    expect(described).not.toContain("notes.md");
  });

  test("drops envelope values that are not identifier-shaped", () => {
    const described = __testing.describeChildStderrLine(
      '{"level":"info","target":"contains spaces and \\n newlines"}',
    );
    expect(described).toContain("level=info");
    expect(described).not.toContain("target=");
  });

  test("reports an unparseable line by size only", () => {
    const described = __testing.describeChildStderrLine("panicked at secrets");
    expect(described).toBe("unstructured (19 bytes suppressed)");
    expect(described).not.toContain("secrets");
  });

  test("falls back to an unknown level rather than inventing one", () => {
    expect(__testing.describeChildStderrLine("{}")).toContain("level=unknown");
    expect(__testing.describeChildStderrLine("[1,2,3]")).toContain(
      "unstructured",
    );
  });
});

describe("request and health plumbing", () => {
  test("requestWithGeneration reports which generation served the call", async () => {
    const h = harness();
    await h.supervisor.ensureReady();
    const pending = h.supervisor.requestWithGeneration<{ ok: boolean }>(
      "thread/read",
      { threadId: "t1" },
    );
    await flushMicrotasks();
    const sent = h.children[0]!.stdin
      .parsed()
      .find((message) => message.method === "thread/read");
    h.children[0]!.stdout.pushMessage({
      jsonrpc: "2.0",
      id: sent!.id,
      result: { ok: true },
    });

    await expect(pending).resolves.toEqual({
      result: { ok: true },
      generation: 1,
    });
  });

  test("respondToServerRequestWithError only answers the live generation", async () => {
    const h = harness();
    await h.supervisor.ensureReady();
    const firstChild = h.children[0]!;

    await h.supervisor.respondToServerRequestWithError(
      1,
      "srv-1",
      -32603,
      "refused",
    );
    expect(
      firstChild.stdin.parsed().find((message) => message.id === "srv-1"),
    ).toMatchObject({ error: { code: -32603, message: "refused" } });

    firstChild.exit(1);
    await h.supervisor.ensureReady();
    // Generation 1 is gone; app-server has forgotten the request.
    await h.supervisor.respondToServerRequestWithError(
      1,
      "srv-2",
      -32603,
      "refused",
    );
    expect(
      h.children[1]!.stdin.parsed().some((message) => message.id === "srv-2"),
    ).toBe(false);
  });

  test("surfaces unknown notification and server-request counters through health", async () => {
    const h = harness();
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await h.supervisor.ensureReady();
      h.supervisor.recordUnknownNotification();
      h.supervisor.recordUnknownServerRequest();
      h.supervisor.recordUnknownServerRequest();
      // A protocol violation is counted the same way, from the read loop.
      h.children[0]!.stdout.push("this is not json\n");

      const health = h.supervisor.getHealth();
      expect(health.unknownNotifications).toBe(2);
      expect(health.unknownServerRequests).toBe(2);
      expect(health.notificationQueueDepth).toBe(0);
    } finally {
      error.mockRestore();
    }
  });

  test("a spawn error is handled as an exit rather than an unhandled event", async () => {
    const h = harness();
    await h.supervisor.ensureReady();

    h.children[0]!.emit("error", new Error("spawn EACCES"));

    expect(h.supervisor.getHealth().lastError).toContain("spawn EACCES");
    expect(h.supervisor.isReady()).toBe(false);
    expect(h.supervisor.getState()).toBe("restarting");
  });

  test("a second environment check joins the drain already in flight", async () => {
    const h = harness({
      behaviours: [{ pid: UNMAPPED_PID }, { pid: UNMAPPED_PID }],
    });
    await h.supervisor.ensureReady();
    h.setFingerprint("sha256:changed");

    let releaseIdle!: () => void;
    const idle = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    const first = h.supervisor.ensureEnvironmentIsCurrent({
      hasActiveTurns: () => true,
      waitForIdle: () => idle,
    });
    await flushMicrotasks();
    const second = h.supervisor.ensureEnvironmentIsCurrent({
      hasActiveTurns: () => {
        throw new Error("the second caller must not start its own drain");
      },
      waitForIdle: async () => undefined,
    });
    releaseIdle();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.restarted).toBe(true);
    expect(secondResult.restarted).toBe(true);
    // One drain, one replacement child.
    expect(h.children).toHaveLength(2);
    h.children[1]!.exit(0);
  });
});

describe("parseVersionFromUserAgent", () => {
  test("extracts the semver from a real user agent", () => {
    expect(
      parseVersionFromUserAgent(
        "orkestrator/0.145.0 (Mac OS 26.5.2; arm64) unknown (orkestrator; 2.4.9)",
      ),
    ).toBe("0.145.0");
  });

  test("returns undefined rather than guessing", () => {
    expect(parseVersionFromUserAgent(undefined)).toBeUndefined();
    expect(parseVersionFromUserAgent("no version here")).toBeUndefined();
  });
});
