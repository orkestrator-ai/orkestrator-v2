import { describe, expect, mock, spyOn, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testing as commandTesting } from "./commands.js";
import { OrkestratorBackend } from "./index.js";
import type { AgentToolConnection } from "./agent-tools.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { StorageService } from "./storage.js";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";

function fakeAgentTools(overrides: {
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
} = {}) {
  return {
    start: mock(overrides.start ?? (async () => undefined)),
    stop: mock(overrides.stop ?? (async () => undefined)),
    connection: mock((
      _environmentId: string,
      _projectId: string,
      _target: "host" | "container",
    ): AgentToolConnection => ({
      url: "http://127.0.0.1:43210/mcp",
      token: "test-token",
    })),
    revokeEnvironment: mock(() => undefined),
  };
}

test("activity transition events omit backend-only provider session identifiers", async () => {
  const events: Array<{ event: string; payload: unknown }> = [];
  const backend = new OrkestratorBackend({
    dataDir: path.join(os.tmpdir(), `ork-backend-activity-event-${randomUUID()}`),
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: (event, payload) => events.push({ event, payload }),
    agentTools: fakeAgentTools(),
  });
  const transition = (backend as unknown as {
    nativeAgents: {
      options: {
        onActivityTransition?: (event: Record<string, unknown>) => void;
      };
    };
  }).nativeAgents.options.onActivityTransition;

  transition?.({
    environmentId: "env-1",
    sessionKey: "private-storage-key",
    providerSessionId: "private-provider-id",
    previousState: "working",
    state: "idle",
  });

  expect(events).toEqual([{
    event: "native-agent-session-activity",
    payload: {
      environment_id: "env-1",
      previous_state: "working",
      state: "idle",
    },
  }]);
  await backend.shutdown();
});

test("wires observe-only monitoring and its adoption kill switch from the environment", async () => {
  const observeKey = "ORKESTRATOR_AGENT_INTERACTION_OBSERVE_ONLY";
  const killSwitchKey = "ORKESTRATOR_AGENT_INTERACTION_MONITOR_KILL_SWITCH";
  const previousObserve = process.env[observeKey];
  const previousKillSwitch = process.env[killSwitchKey];
  const backends: OrkestratorBackend[] = [];
  const options = {
    dataDir: path.join(os.tmpdir(), "ork-backend-interaction-env"),
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    agentTools: fakeAgentTools(),
    startupReapers: {
      localServers: async () => [],
      claudeTmuxRuntimes: async () => [],
    },
  };
  const monitorOptions = (backend: OrkestratorBackend) => {
    const nativeAgents = (backend as unknown as {
      nativeAgents: {
        options: {
          interactionMonitorMode?: "disabled" | "observe-only";
          interactionMonitorAdoptionEnabled?: boolean;
        };
        interactionMonitorAdoptionEnabled: boolean;
      };
    }).nativeAgents;
    return {
      ...nativeAgents.options,
      effectiveAdoption: nativeAgents.interactionMonitorAdoptionEnabled,
    };
  };

  try {
    delete process.env[observeKey];
    delete process.env[killSwitchKey];
    const disabled = new OrkestratorBackend(options);
    backends.push(disabled);
    expect(monitorOptions(disabled)).toMatchObject({
      interactionMonitorMode: "disabled",
      interactionMonitorAdoptionEnabled: true,
      effectiveAdoption: true,
    });

    process.env[observeKey] = "1";
    process.env[killSwitchKey] = "1";
    const observeOnly = new OrkestratorBackend({
      ...options,
      agentTools: fakeAgentTools(),
    });
    backends.push(observeOnly);
    expect(monitorOptions(observeOnly)).toMatchObject({
      interactionMonitorMode: "observe-only",
      interactionMonitorAdoptionEnabled: false,
      effectiveAdoption: false,
    });
    const internals = observeOnly as unknown as {
      buildPipelines: {
        options: {
          onInteractionObservation(event: {
            environmentId: string;
            provider: "opencode";
            sessionId: string;
            interactionId: string;
            kind: "permission";
            registration: {
              origin: "build-pipeline";
              interactionPolicy: typeof UNATTENDED_AGENT_INTERACTION_POLICY;
              phase: string;
            };
            state: "detected" | "withdrawn";
            providerState?: "running";
          }): Promise<void>;
        };
      };
      loopedReviews: {
        options: {
          onInteractionObservation(event: {
            environmentId: string;
            provider: "opencode";
            sessionId: string;
            interactionId: string;
            kind: "permission";
            registration: {
              origin: "looped-review";
              interactionPolicy: typeof UNATTENDED_AGENT_INTERACTION_POLICY;
              phase: string;
            };
            state: "detected" | "withdrawn";
            providerState?: "running";
          }): Promise<void>;
        };
      };
      context: { loopedReviews: unknown };
      nativeAgents: {
        getInteractionObservations(): Array<Record<string, unknown>>;
      };
    };
    const event = {
      environmentId: "env-1",
      provider: "opencode" as const,
      sessionId: "session-1",
      interactionId: "permission-1",
      kind: "permission" as const,
      registration: {
        origin: "build-pipeline" as const,
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        phase: "build",
      },
    };
    await internals.buildPipelines.options.onInteractionObservation({
      ...event,
      state: "detected",
    });
    await internals.buildPipelines.options.onInteractionObservation({
      ...event,
      state: "withdrawn",
      providerState: "running",
    });
    const reviewEvent = {
      ...event,
      sessionId: "session-2",
      interactionId: "permission-2",
      registration: {
        origin: "looped-review" as const,
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        phase: "discovery",
      },
    };
    await internals.loopedReviews.options.onInteractionObservation({
      ...reviewEvent,
      state: "detected",
    });
    await internals.loopedReviews.options.onInteractionObservation({
      ...reviewEvent,
      state: "withdrawn",
      providerState: "running",
    });
    expect(internals.context.loopedReviews).toBe(internals.loopedReviews);
    expect(internals.nativeAgents.getInteractionObservations()).toEqual([
      expect.objectContaining({
        provider: "opencode",
        kind: "permission",
        workflowSurface: "build-pipeline",
        phase: "pipeline",
        count: 1,
        eventualOutcome: "withdrawn",
      }),
      expect.objectContaining({
        provider: "opencode",
        kind: "permission",
        workflowSurface: "looped-review",
        phase: "discovery",
        count: 1,
        eventualOutcome: "withdrawn",
      }),
    ]);
  } finally {
    if (previousObserve === undefined) delete process.env[observeKey];
    else process.env[observeKey] = previousObserve;
    if (previousKillSwitch === undefined) delete process.env[killSwitchKey];
    else process.env[killSwitchKey] = previousKillSwitch;
    await Promise.all(backends.map((backend) =>
      backend.shutdown().catch(() => undefined)
    ));
  }
});

describe("agent-tools lifecycle", () => {
  test("starts before reapers and stops during shutdown", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-tools-"));
    const calls: string[] = [];
    const tools = fakeAgentTools({
      start: async () => {
        calls.push("tools:start");
      },
      stop: async () => {
        calls.push("tools:stop");
      },
    });
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      agentTools: tools,
      startupReapers: {
        localServers: async () => {
          calls.push("pid");
          return [];
        },
        claudeTmuxRuntimes: async () => {
          calls.push("tmux");
          return [];
        },
      },
    });
    try {
      await backend.init();
      expect(calls).toEqual(["tools:start", "pid", "tmux"]);
      await backend.shutdown();
      expect(calls).toEqual(["tools:start", "pid", "tmux", "tools:stop"]);
      expect(tools.start).toHaveBeenCalledTimes(1);
      expect(tools.stop).toHaveBeenCalledTimes(1);
    } finally {
      await backend.shutdown().catch(() => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("surfaces bind failures and still permits lifecycle cleanup", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-tools-"));
    const tools = fakeAgentTools({
      start: async () => {
        throw new Error("bind failed");
      },
    });
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      agentTools: tools,
      startupReapers: {
        localServers: async () => [],
        claudeTmuxRuntimes: async () => [],
      },
    });
    try {
      await expect(backend.init()).rejects.toThrow("bind failed");
      expect(tools.start).toHaveBeenCalledTimes(1);
      await backend.shutdown();
      expect(tools.stop).toHaveBeenCalledTimes(1);
    } finally {
      await backend.shutdown().catch(() => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("propagates stop failures and retries cleanup on a later shutdown", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-tools-"));
    let attempts = 0;
    const tools = fakeAgentTools({
      stop: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("stop failed");
      },
    });
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      agentTools: tools,
      startupReapers: {
        localServers: async () => [],
        claudeTmuxRuntimes: async () => [],
      },
    });
    try {
      await backend.init();
      await expect(backend.shutdown()).rejects.toThrow("stop failed");
      await expect(backend.shutdown()).resolves.toBeUndefined();
      expect(tools.stop).toHaveBeenCalledTimes(2);
    } finally {
      await backend.shutdown().catch(() => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

test("reports registered commands and routes agent completion through the registry", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-command-route-"));
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    agentTools: fakeAgentTools(),
    startupReapers: {
      localServers: async () => [],
      claudeTmuxRuntimes: async () => [],
    },
  });
  try {
    expect(backend.hasCommand("pr_monitor_agent_turn_completed")).toBe(true);
    expect(backend.hasCommand("not_a_backend_command")).toBe(false);

    const internal = backend as unknown as {
      context: {
        storage: StorageService;
        notifyAgentTurnCompleted: (environmentId: string) => Promise<void>;
      };
    };
    const getEnvironment = spyOn(internal.context.storage, "getEnvironment");
    await internal.context.notifyAgentTurnCompleted("missing-env");
    expect(getEnvironment).toHaveBeenCalledWith("missing-env");
  } finally {
    await backend.shutdown().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createFakeChild(pid: number): ChildProcessWithoutNullStreams {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  } as unknown as ChildProcessWithoutNullStreams;
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function resolvesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<"resolved" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => "resolved" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("startup runs the tmux reaper after the PID reaper even when PID reaping fails", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-init-"));
  const calls: string[] = [];
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    startupReapers: {
      localServers: async () => {
        calls.push("pid");
        throw new Error("PID scan failed");
      },
      claudeTmuxRuntimes: async () => {
        calls.push("tmux");
        return [];
      },
    },
  });
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await backend.init();
    expect(calls).toEqual(["pid", "tmux"]);
  } finally {
    console.warn = originalWarn;
    await backend.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("startup remains available when the tmux runtime reaper fails", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-init-"));
  const calls: string[] = [];
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    startupReapers: {
      localServers: async () => {
        calls.push("pid");
        return [];
      },
      claudeTmuxRuntimes: async () => {
        calls.push("tmux");
        throw new Error("tmux scan failed");
      },
    },
  });
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await expect(backend.init()).resolves.toBeUndefined();
    expect(calls).toEqual(["pid", "tmux"]);
  } finally {
    console.warn = originalWarn;
    await backend.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("supervisor failures are isolated during restore and shutdown", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-native-lifecycle-"));
  const calls: string[] = [];
  const tools = fakeAgentTools({
    start: async () => {
      calls.push("tools:start");
    },
    stop: async () => {
      calls.push("tools:stop");
    },
  });
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    agentTools: tools,
    startupReapers: {
      localServers: async () => [],
      claudeTmuxRuntimes: async () => [],
    },
  });
  const internals = backend as unknown as {
    buildPipelines: {
      init: () => Promise<void>;
      shutdown: () => Promise<void>;
    };
    loopedReviews: {
      init: () => Promise<void>;
      shutdown: () => Promise<void>;
    };
    nativeAgents: {
      init: () => Promise<void>;
      shutdown: () => Promise<void>;
      ensureSession: (input: Record<string, unknown>) => Promise<unknown>;
    };
  };
  internals.buildPipelines.init = mock(async () => {
    calls.push("pipelines:init");
  });
  internals.loopedReviews.init = mock(async () => {
    calls.push("reviews:init");
    throw new Error("review restore failed");
  });
  internals.nativeAgents.init = mock(async () => {
    calls.push("native:init");
    throw new Error("restore failed");
  });
  internals.nativeAgents.ensureSession = mock(async (input) => ({
    providerSessionId: "provider-1",
    ...input,
  }));
  internals.nativeAgents.shutdown = mock(async () => {
    calls.push("native:shutdown");
    throw new Error("native drain failed");
  });
  internals.buildPipelines.shutdown = mock(async () => {
    calls.push("pipelines:shutdown");
  });
  internals.loopedReviews.shutdown = mock(async () => {
    calls.push("reviews:shutdown");
    throw new Error("review drain failed");
  });

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await expect(backend.init()).resolves.toBeUndefined();
    expect(calls).toEqual([
      "tools:start",
      "pipelines:init",
      "reviews:init",
      "native:init",
    ]);
    await expect(backend.invoke("ensure_native_agent_session", {
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "env-env-1:tab-1",
    })).resolves.toMatchObject({ providerSessionId: "provider-1" });
    expect(internals.nativeAgents.ensureSession).toHaveBeenCalledWith({
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "env-env-1:tab-1",
      title: undefined,
      model: undefined,
      reasoningEffort: undefined,
      phase: undefined,
    });

    await expect(backend.shutdown()).resolves.toBeUndefined();
    expect(calls.slice(-4)).toEqual([
      "native:shutdown",
      "pipelines:shutdown",
      "reviews:shutdown",
      "tools:stop",
    ]);
  } finally {
    console.warn = originalWarn;
    await backend.shutdown().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

type ControlledInterval = {
  active: boolean;
  callback: () => void;
  delay: number;
  handle: ReturnType<typeof setInterval>;
  unref: ReturnType<typeof mock>;
};

/**
 * Replace the global interval timers so a sweep can be driven by hand.
 *
 * The sweep under test fires every two seconds and must keep firing for the
 * life of the backend, which no real-time test can observe without either
 * sleeping or accepting flakiness.
 */
function controlledIntervals() {
  const intervals: ControlledInterval[] = [];
  const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
    ((callback: () => void, delay = 0) => {
      const unref = mock(() => undefined);
      const handle = { unref } as unknown as ReturnType<typeof setInterval>;
      intervals.push({ active: true, callback, delay, handle, unref });
      return handle;
    }) as typeof setInterval,
  );
  const clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation(
    ((handle: ReturnType<typeof setInterval>) => {
      const interval = intervals.find((candidate) => candidate.handle === handle);
      if (interval) interval.active = false;
    }) as typeof clearInterval,
  );
  return {
    intervals,
    clearIntervalSpy,
    tick(delay: number): void {
      for (const interval of intervals) {
        if (interval.active && interval.delay === delay) interval.callback();
      }
    },
    restore(): void {
      clearIntervalSpy.mockRestore();
      setIntervalSpy.mockRestore();
    },
  };
}

describe("native-agent activity reconciliation lifecycle", () => {
  test("coalesces tab-resource sweeps on a one-minute cadence", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ork-backend-tab-resource-sweep-"),
    );
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      agentTools: fakeAgentTools(),
      startupReapers: {
        localServers: async () => [],
        claudeTmuxRuntimes: async () => [],
      },
    });
    const teardownGate = deferred<unknown>();
    const orphanGate = deferred<unknown>();
    const reconcileTabTeardowns = mock(() =>
      reconcileTabTeardowns.mock.calls.length === 1
        ? Promise.resolve({ completed: 0 })
        : teardownGate.promise
    );
    const reconcileOrphans = mock(() =>
      reconcileOrphans.mock.calls.length === 1
        ? Promise.resolve({ terminals: 0, nativeSessions: 0, tmuxSessions: 0 })
        : orphanGate.promise
    );
    const internals = backend as unknown as {
      commands: Map<string, (args: Record<string, unknown>, context: unknown) => unknown>;
      buildPipelines: { init: () => Promise<void> };
      nativeAgents: {
        init: () => Promise<void>;
        reconcileAgentActivity: () => Promise<void>;
      };
    };
    internals.commands.set("reconcile_tab_teardowns", reconcileTabTeardowns);
    internals.commands.set("reconcile_orphaned_tab_resources", reconcileOrphans);
    internals.buildPipelines.init = mock(async () => undefined);
    internals.nativeAgents.init = mock(async () => undefined);
    internals.nativeAgents.reconcileAgentActivity = mock(async () => undefined);
    const { intervals, clearIntervalSpy, tick, restore } = controlledIntervals();

    try {
      await backend.init();
      expect(reconcileTabTeardowns).toHaveBeenCalledTimes(1);
      expect(reconcileOrphans).toHaveBeenCalledTimes(1);
      const resourceSweep = intervals.find((interval) => interval.delay === 60_000);
      expect(resourceSweep).toBeDefined();

      tick(60_000);
      tick(60_000);
      expect(reconcileTabTeardowns).toHaveBeenCalledTimes(2);
      expect(reconcileOrphans).toHaveBeenCalledTimes(2);

      teardownGate.resolve({ completed: 0 });
      orphanGate.resolve({ terminals: 0, nativeSessions: 0, tmuxSessions: 0 });
      await waitForCondition(() => {
        tick(60_000);
        return reconcileTabTeardowns.mock.calls.length === 3
          && reconcileOrphans.mock.calls.length === 3;
      }, "completed tab-resource sweep to release its coalescing guard");
      expect(reconcileTabTeardowns).toHaveBeenCalledTimes(3);
      expect(reconcileOrphans).toHaveBeenCalledTimes(3);

      await backend.shutdown();
      expect(resourceSweep!.active).toBe(false);
      expect(clearIntervalSpy).toHaveBeenCalledWith(resourceSweep!.handle);
    } finally {
      teardownGate.resolve({ completed: 0 });
      orphanGate.resolve({ terminals: 0, nativeSessions: 0, tmuxSessions: 0 });
      await backend.shutdown().catch(() => undefined);
      restore();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("awaits initial activity hydration before startup completes", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ork-backend-native-activity-init-"),
    );
    const hydration = deferred<void>();
    const calls: string[] = [];
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      agentTools: fakeAgentTools(),
      startupReapers: {
        localServers: async () => [],
        claudeTmuxRuntimes: async () => [],
      },
    });
    const internals = backend as unknown as {
      buildPipelines: { init: () => Promise<void> };
      nativeAgents: {
        init: () => Promise<void>;
        reconcileAgentActivity: () => Promise<void>;
      };
    };
    internals.buildPipelines.init = mock(async () => undefined);
    internals.nativeAgents.init = mock(async () => undefined);
    internals.nativeAgents.reconcileAgentActivity = mock(async () => {
      calls.push("hydrate:start");
      await hydration.promise;
      calls.push("hydrate:end");
    });

    try {
      let initialized = false;
      const initialization = backend.init().then(() => {
        initialized = true;
      });
      await waitForCondition(
        () => calls.includes("hydrate:start"),
        "initial native-agent activity hydration",
      );

      expect(initialized).toBe(false);
      expect(calls).toEqual(["hydrate:start"]);

      hydration.resolve(undefined);
      await initialization;
      expect(initialized).toBe(true);
      expect(calls).toEqual(["hydrate:start", "hydrate:end"]);
    } finally {
      hydration.resolve(undefined);
      await backend.shutdown().catch(() => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("isolates an initial activity hydration failure and leaves commands available", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ork-backend-native-activity-failure-"),
    );
    const tools = fakeAgentTools();
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      agentTools: tools,
      startupReapers: {
        localServers: async () => [],
        claudeTmuxRuntimes: async () => [],
      },
    });
    const internals = backend as unknown as {
      buildPipelines: { init: () => Promise<void> };
      nativeAgents: {
        init: () => Promise<void>;
        reconcileAgentActivity: () => Promise<void>;
      };
    };
    internals.buildPipelines.init = mock(async () => undefined);
    internals.nativeAgents.init = mock(async () => undefined);
    internals.nativeAgents.reconcileAgentActivity = mock(async () => {
      throw new Error("activity snapshot unavailable");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(backend.init()).resolves.toBeUndefined();
      await expect(backend.invoke("get_environment_snapshots", {
        projectId: "project-1",
      })).resolves.toEqual([]);
      expect(tools.start).toHaveBeenCalledTimes(1);
      expect(internals.nativeAgents.reconcileAgentActivity)
        .toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[backend] Failed to restore native agent activity:",
        expect.objectContaining({ message: "activity snapshot unavailable" }),
      );
    } finally {
      warn.mockRestore();
      await backend.shutdown().catch(() => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("runs activity reconciliation periodically and clears its interval on shutdown", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ork-backend-native-activity-sweep-"),
    );
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      agentTools: fakeAgentTools(),
      startupReapers: {
        localServers: async () => [],
        claudeTmuxRuntimes: async () => [],
      },
    });
    const internals = backend as unknown as {
      buildPipelines: { init: () => Promise<void> };
      nativeAgents: {
        init: () => Promise<void>;
        reconcileAgentActivity: () => Promise<void>;
      };
      promptQueues: {
        drainAll: () => Promise<void>;
        shutdown: () => Promise<void>;
      };
    };
    internals.buildPipelines.init = mock(async () => undefined);
    internals.nativeAgents.init = mock(async () => undefined);
    internals.nativeAgents.reconcileAgentActivity = mock(async () => undefined);
    internals.promptQueues.drainAll = mock(async () => undefined);
    internals.promptQueues.shutdown = mock(async () => undefined);

    const { intervals, clearIntervalSpy, tick, restore } = controlledIntervals();

    try {
      await backend.init();
      expect(internals.nativeAgents.reconcileAgentActivity)
        .toHaveBeenCalledTimes(1);
      expect(internals.promptQueues.drainAll).toHaveBeenCalledTimes(1);
      const nativeSweep = intervals.find((interval) => interval.delay === 2_000);
      expect(nativeSweep).toBeDefined();
      expect(nativeSweep!.unref).toHaveBeenCalledTimes(1);

      tick(2_000);
      await Promise.resolve();
      expect(internals.nativeAgents.reconcileAgentActivity)
        .toHaveBeenCalledTimes(2);
      expect(internals.promptQueues.drainAll).toHaveBeenCalledTimes(2);

      await backend.shutdown();
      expect(internals.promptQueues.shutdown).toHaveBeenCalledTimes(1);
      expect(nativeSweep!.active).toBe(false);
      expect(clearIntervalSpy).toHaveBeenCalledWith(nativeSweep!.handle);

      tick(2_000);
      await Promise.resolve();
      expect(internals.nativeAgents.reconcileAgentActivity)
        .toHaveBeenCalledTimes(2);
      expect(internals.promptQueues.drainAll).toHaveBeenCalledTimes(2);
    } finally {
      await backend.shutdown().catch(() => undefined);
      restore();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("isolates a rejected sweep and keeps reconciling on the next tick", async () => {
    // The interval callback is a separate failure boundary from the awaited
    // hydration at startup: a bridge that is briefly unreachable rejects here
    // every two seconds, and an unhandled rejection would tear the backend
    // down rather than simply skipping one sweep.
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ork-backend-native-activity-tick-failure-"),
    );
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      agentTools: fakeAgentTools(),
      startupReapers: {
        localServers: async () => [],
        claudeTmuxRuntimes: async () => [],
      },
    });
    const internals = backend as unknown as {
      buildPipelines: { init: () => Promise<void> };
      nativeAgents: {
        init: () => Promise<void>;
        reconcileAgentActivity: () => Promise<void>;
      };
    };
    internals.buildPipelines.init = mock(async () => undefined);
    internals.nativeAgents.init = mock(async () => undefined);
    let sweeps = 0;
    internals.nativeAgents.reconcileAgentActivity = mock(async () => {
      sweeps += 1;
      // The first call is the awaited startup hydration, which is covered by
      // its own test; only the interval callback fails here.
      if (sweeps > 1) throw new Error("activity sweep unavailable");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const { tick, restore } = controlledIntervals();

    try {
      await backend.init();
      expect(sweeps).toBe(1);

      tick(2_000);
      await waitForCondition(
        () => warn.mock.calls.some(([message]) =>
          message === "[backend] Failed to reconcile native agent activity:"
        ),
        "the failed sweep to be reported",
      );
      expect(warn).toHaveBeenCalledWith(
        "[backend] Failed to reconcile native agent activity:",
        expect.objectContaining({ message: "activity sweep unavailable" }),
      );

      // The backend is still serving commands, and the interval survived its
      // own callback throwing.
      await expect(backend.invoke("get_environment_snapshots", {
        projectId: "project-1",
      })).resolves.toEqual([]);
      tick(2_000);
      await waitForCondition(
        () => sweeps === 3,
        "a later sweep after the failed one",
      );
    } finally {
      await backend.shutdown().catch(() => undefined);
      restore();
      warn.mockRestore();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("arms the activity sweep once across repeated init calls", async () => {
    // `init()` is re-entered by supervisors that retry a partially failed
    // startup. A second interval would double every bridge poll for the life
    // of the process, and only the newest handle would be cleared on shutdown.
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ork-backend-native-activity-idempotent-"),
    );
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      agentTools: fakeAgentTools(),
      startupReapers: {
        localServers: async () => [],
        claudeTmuxRuntimes: async () => [],
      },
    });
    const internals = backend as unknown as {
      buildPipelines: { init: () => Promise<void> };
      nativeAgents: {
        init: () => Promise<void>;
        reconcileAgentActivity: () => Promise<void>;
      };
    };
    internals.buildPipelines.init = mock(async () => undefined);
    internals.nativeAgents.init = mock(async () => undefined);
    internals.nativeAgents.reconcileAgentActivity = mock(async () => undefined);
    const { intervals, tick, restore } = controlledIntervals();

    try {
      await backend.init();
      await backend.init();

      expect(intervals.filter((interval) => interval.delay === 2_000))
        .toHaveLength(1);
      tick(2_000);
      await Promise.resolve();
      // Two init calls, one interval: three reconciles, not four.
      expect(internals.nativeAgents.reconcileAgentActivity)
        .toHaveBeenCalledTimes(3);
    } finally {
      await backend.shutdown().catch(() => undefined);
      restore();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("hydrates activity only after native agent launches are restored", async () => {
    // Reconciling first would read an empty launch registry and publish `idle`
    // for every environment whose agent is about to be restored.
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ork-backend-native-activity-order-"),
    );
    const calls: string[] = [];
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      agentTools: fakeAgentTools(),
      startupReapers: {
        localServers: async () => [],
        claudeTmuxRuntimes: async () => [],
      },
    });
    const internals = backend as unknown as {
      buildPipelines: { init: () => Promise<void> };
      nativeAgents: {
        init: () => Promise<void>;
        reconcileAgentActivity: () => Promise<void>;
      };
    };
    internals.buildPipelines.init = mock(async () => {
      calls.push("pipelines:init");
    });
    internals.nativeAgents.init = mock(async () => {
      calls.push("native:init");
    });
    internals.nativeAgents.reconcileAgentActivity = mock(async () => {
      calls.push("native:reconcile");
    });

    try {
      await backend.init();
      expect(calls).toEqual([
        "pipelines:init",
        "native:init",
        "native:reconcile",
      ]);
    } finally {
      await backend.shutdown().catch(() => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

test("shutdown clears backend-owned PR watch state before a new backend starts", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-pr-shutdown-"));
  const options = {
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    startupReapers: {
      localServers: async () => [],
      claudeTmuxRuntimes: async () => [],
    },
  };
  const first = new OrkestratorBackend(options);
  let second: OrkestratorBackend | undefined;
  try {
    await first.init();
    const project = await first.invoke<{ id: string }>("add_project", {
      gitUrl: "https://github.com/acme/repo.git",
    });
    const environment = await first.invoke<{ id: string }>("create_environment", {
      projectId: project.id,
      name: "PR watch",
      environmentType: "local",
    });
    await first.invoke("pr_monitor_watch", {
      environmentId: environment.id,
      mode: "create-pending",
    });
    await expect(first.invoke<{ entries: unknown[] }>("get_pr_monitor_state"))
      .resolves.toMatchObject({ entries: [expect.objectContaining({ mode: "create-pending" })] });

    await first.shutdown();
    second = new OrkestratorBackend(options);
    await second.init();
    await expect(second.invoke<{ entries: unknown[] }>("get_pr_monitor_state"))
      .resolves.toEqual({ entries: [] });
  } finally {
    await first.shutdown().catch(() => undefined);
    await second?.shutdown().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("shutdown closes lifecycle admission before draining accepted work", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-lifecycle-shutdown-"));
  const lifecycleTasks = new EnvironmentLifecycleTaskTracker();
  let finishOperation!: () => void;
  const operationBlocked = new Promise<void>((resolve) => {
    finishOperation = resolve;
  });
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    environmentLifecycleTasks: lifecycleTasks,
    startupReapers: {
      localServers: async () => [],
      claudeTmuxRuntimes: async () => [],
    },
  });
  try {
    await backend.init();
    const operation = lifecycleTasks.admit(() => operationBlocked);
    const shutdown = backend.shutdown();
    let shutdownFinished = false;
    void shutdown.then(() => {
      shutdownFinished = true;
    });

    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    expect(lifecycleTasks.isAccepting()).toBe(false);
    await expect(backend.invoke("greet", { name: "late" })).rejects.toThrow(
      "Backend is shutting down",
    );

    finishOperation();
    await operation;
    await expect(shutdown).resolves.toBeUndefined();
    expect(shutdownFinished).toBe(true);
  } finally {
    finishOperation();
    await backend.shutdown().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("startup reconciles a persisted creating environment before accepting commands", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-lifecycle-recovery-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "interrupted",
    projectId: "project",
    name: "Interrupted",
    branch: "interrupted",
    containerId: null,
    status: "creating",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
  });
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    startupReapers: {
      localServers: async () => [],
      claudeTmuxRuntimes: async () => [],
    },
  });
  try {
    await backend.init();
    await expect(backend.invoke<{ status: string; lifecycleError?: string }[]>(
      "get_environments",
      { projectId: "project" },
    )).resolves.toEqual([
      expect.objectContaining({
        id: "interrupted",
        status: "error",
        lifecycleError: expect.stringContaining("interrupted"),
      }),
    ]);
  } finally {
    await backend.shutdown().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("startup re-admits interrupted deletion while its tombstone continues blocking writes", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-delete-recovery-"));
  const storage = new StorageService(dataDir);
  const releaseTermination = deferred<void>();
  const terminationStarted = deferred<void>();
  const environmentId = "interrupted-delete";
  const originalWarn = console.warn;
  commandTesting.resetLocalServerLifecycle();
  await storage.init();
  await storage.addEnvironment({
    id: environmentId,
    projectId: "project",
    name: "Interrupted delete",
    branch: "interrupted-delete",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: path.join(dataDir, "interrupted-delete-worktree"),
    deletionRequestedAt: new Date(1).toISOString(),
    lifecycleOperation: "deleting",
    lifecycleOperationStartedAt: new Date(1).toISOString(),
  });
  commandTesting.setLocalServerProcess(
    `codex:${environmentId}`,
    createFakeChild(96001),
  );
  commandTesting.setTerminateProcessTree(async () => {
    terminationStarted.resolve();
    await releaseTermination.promise;
    return true;
  });
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    startupReapers: {
      localServers: async () => [],
      claudeTmuxRuntimes: async () => [],
    },
  });

  try {
    // An empty fixture worktree has no tmux runtime to clean up. That
    // best-effort warning is unrelated to lifecycle recovery under test.
    console.warn = () => undefined;
    await backend.init();
    await terminationStarted.promise;

    await expect(storage.savePromptQueue(
      `codex env-${environmentId}:tab-1`,
      environmentId,
      [{ id: "late" }],
    )).rejects.toThrow("being deleted");
    await expect(storage.getEnvironment(environmentId)).resolves.toMatchObject({
      deletionRequestedAt: expect.any(String),
      lifecycleOperation: "deleting",
    });

    releaseTermination.resolve();
    await waitForCondition(
      async () => await storage.getEnvironment(environmentId) === null,
      "re-admitted deletion to remove the environment",
    );
    expect(commandTesting.getLocalServerProcess(`codex:${environmentId}`)).toBeUndefined();
  } finally {
    console.warn = originalWarn;
    releaseTermination.resolve();
    await backend.shutdown().catch(() => undefined);
    commandTesting.resetLocalServerLifecycle();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("shutdown applies one deadline across lifecycle and local-operation drains", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-shutdown-deadline-"));
  const storage = new StorageService(dataDir);
  const releaseFirstTermination = deferred<void>();
  const firstTerminationStarted = deferred<void>();
  const environmentId = "blocked-delete";
  let terminationAttempts = 0;
  const originalWarn = console.warn;
  commandTesting.resetLocalServerLifecycle();
  await storage.init();
  await storage.addEnvironment({
    id: environmentId,
    projectId: "project",
    name: "Blocked delete",
    branch: "blocked-delete",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: path.join(dataDir, "blocked-delete-worktree"),
  });
  commandTesting.setLocalServerProcess(
    `codex:${environmentId}`,
    createFakeChild(96002),
  );
  commandTesting.setTerminateProcessTree(async () => {
    terminationAttempts += 1;
    if (terminationAttempts === 1) {
      firstTerminationStarted.resolve();
      await releaseFirstTermination.promise;
    }
    return true;
  });
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    environmentLifecycleDrainTimeoutMs: 20,
    startupReapers: {
      localServers: async () => [],
      claudeTmuxRuntimes: async () => [],
    },
  });

  let deletion: Promise<void> | undefined;
  try {
    // An empty fixture worktree has no tmux runtime to clean up. That
    // best-effort warning is unrelated to shutdown coordination under test.
    console.warn = () => undefined;
    await backend.init();
    deletion = backend.invoke("delete_environment", { environmentId });
    await firstTerminationStarted.promise;

    const shutdown = backend.shutdown();
    await expect(resolvesWithin(shutdown, 1_000)).resolves.toBe("resolved");
    expect(terminationAttempts).toBe(2);
    expect(commandTesting.getLocalServerProcess(`codex:${environmentId}`)).toBeUndefined();

    releaseFirstTermination.resolve();
    await expect(deletion).resolves.toBeUndefined();
  } finally {
    console.warn = originalWarn;
    releaseFirstTermination.resolve();
    await deletion?.catch(() => undefined);
    await backend.shutdown().catch(() => undefined);
    commandTesting.resetLocalServerLifecycle();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("startup fails closed when reconciliation cannot persist its result", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-lifecycle-failclosed-"));
  const seed = new StorageService(dataDir);
  await seed.init();
  await seed.addEnvironment({
    id: "interrupted",
    projectId: "project",
    name: "Interrupted",
    branch: "interrupted",
    containerId: null,
    status: "creating",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
  });
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    startupReapers: {
      localServers: async () => [],
      claudeTmuxRuntimes: async () => [],
    },
  });
  const storage = (backend as unknown as {
    context: { storage: StorageService };
  }).context.storage;
  const realUpdate = storage.updateEnvironment.bind(storage);
  storage.updateEnvironment = (async () => {
    throw new Error("environments.json is read-only");
  }) as StorageService["updateEnvironment"];

  try {
    // Serving commands on top of a `creating` record this backend can never
    // finish would report progress that will never arrive, so init must reject
    // rather than continue past a failed reconciliation.
    await expect(backend.init()).rejects.toThrow("environments.json is read-only");
    storage.updateEnvironment = realUpdate;
    await expect(storage.getEnvironment("interrupted")).resolves.toMatchObject({
      status: "creating",
    });
  } finally {
    storage.updateEnvironment = realUpdate;
    await backend.shutdown().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
