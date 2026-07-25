import { afterEach, describe, test, expect, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AppServerSupervisor,
  parseVersionFromUserAgent,
  type AppServerSupervisorOptions,
} from "./process-supervisor.js";
import {
  AppServerCircuitOpenError,
  AppServerProcessExitError,
  classifyDispatchFailure,
} from "./errors.js";
import { FakeReadable, FakeWritable } from "./testing/fake-app-server.js";
import type { EngineState } from "../engine/types.js";
import type {
  InboundNotification,
  InboundServerRequest,
} from "./envelope-validation.js";

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
    spawnProcess: (() => {
      const behaviour = options.behaviours?.[spawnIndex] ?? {};
      spawnIndex += 1;
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
      mcpServerOpenaiFormElicitation: false,
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
        '{"level":"error","message":"sentinel-private-prompt"}\n',
      );
      h.children[0]!.stderr.emitData("sentinel-private-file-content\n");

      const output = error.mock.calls.flat().map(String).join("\n");
      expect(output).toContain("stderr output suppressed");
      expect(output).not.toContain("sentinel-private-prompt");
      expect(output).not.toContain("sentinel-private-file-content");
      expect(error).toHaveBeenCalledTimes(1);
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

    await expect(h.supervisor.ensureReady()).rejects.toBeInstanceOf(
      AppServerCircuitOpenError,
    );
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
