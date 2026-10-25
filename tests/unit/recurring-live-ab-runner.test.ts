import { afterEach, describe, expect, mock, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __testing,
  countGuardLines,
  measureFreshness,
  measureSoak,
  parseOptions,
  runArm,
  type Status,
} from "../../scripts/recurring-live-ab";

const directories: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "recurring-ab-test-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const metrics = (changed: number) => ({
  recurringWork: {
    metrics: { kinds: { "diff-scan": { changed, started: changed, workUnits: {} } } },
  },
});
const options = () => ({
  ...parseOptions([]),
  settleMs: 20,
  windowMs: 100,
  sampleMs: 50,
  freshnessProbes: 0,
  readyTimeoutMs: 10_000,
});

function harness(overrides: Partial<typeof __testing.armRuntime> = {}) {
  let now = 0;
  let status: Status = { status: "missing" };
  const child = Object.assign(new EventEmitter(), {
    pid: 123_456,
    kill: mock(() => {
      child.emit("exit", 143);
      return true;
    }),
  }) as unknown as ChildProcess;
  const commands: string[][] = [];
  const profiles: string[] = [];
  const runtime = {
    ...__testing.armRuntime,
    now: () => now,
    sleep: async (ms: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      now += ms;
    },
    readStatus: () => status,
    startProfile: mock((profile: string) => {
      profiles.push(profile);
      status = {
        status: "ready",
        startedAt: "2026-01-01",
        processStartTimes: { launcher: 100 },
        pids: { launcher: child.pid },
        live: { launcher: true },
        logDir: "/stub/logs",
      };
      return child;
    }),
    mise: ((args: string[]) => {
      commands.push(args);
      if (args[0] === "dev:stop") {
        status = { ...status, status: "stopped", live: { launcher: false } };
        child.emit("exit", 0);
      }
      return { status: 0 };
    }) as typeof __testing.armRuntime.mise,
    gatewayFor: () => ({ metrics: mock(async () => metrics(now)) }),
    processSamples: () => ({ backend: { cpuMs: now, rssKiB: 10 } }),
    countGuardLines: mock(() => 2),
    ...overrides,
  };
  return {
    runtime,
    profiles,
    commands,
    child,
    setStatus: (next: Status) => {
      status = next;
    },
  };
}

describe("live benchmark lifecycle", () => {
  test("starts credential-free, waits for readiness, settles and samples before exact-profile cleanup", async () => {
    const h = harness();
    let reads = 0;
    const read = h.runtime.readStatus;
    h.runtime.readStatus = (profile) => {
      reads += 1;
      return reads === 2 ? { ...read(profile), status: "starting" } : read(profile);
    };
    const result = await runArm(options(), "rollback", 1, "/stub", undefined, "owned", h.runtime);
    expect(result.error).toBeUndefined();
    expect(result.readyAfterMs).toBe(5_000);
    expect(result.summary?.samples).toBe(3);
    expect(result.summary?.windowMs).toBe(100);
    expect(result.guardLines).toBe(2);
    const start = (h.runtime.startProfile as ReturnType<typeof mock>).mock.calls[0]!;
    expect(start[0]).toBe("rw-ab-owned-rollback-1");
    expect(start[3]).toMatchObject({
      ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK: "all",
      ORKESTRATOR_NATIVE_OBSERVATION_SHARING: "0",
    });
    expect(start[3].ORKESTRATOR_RECURRING_METRICS).toBeUndefined();
    expect(h.commands).toEqual([
      ["dev:stop", "--profile", result.profile],
      ["dev:reset", "--profile", result.profile],
    ]);
  });

  test("concurrent invocations with the same prefix own distinct names and cleanup", async () => {
    const left = harness();
    const right = harness();
    const [a, b] = await Promise.all([
      runArm(options(), "candidate", 1, "/stub", undefined, undefined, left.runtime),
      runArm(options(), "candidate", 1, "/stub", undefined, undefined, right.runtime),
    ]);
    expect(a.profile).not.toBe(b.profile);
    expect(left.commands.every((args) => args.at(-1) === a.profile)).toBe(true);
    expect(right.commands.every((args) => args.at(-1) === b.profile)).toBe(true);
  });

  test("metrics-off keeps process sampling and skips freshness probes", async () => {
    const probe = mock(async () => []);
    const h = harness({
      gatewayFor: () => ({ metrics: async () => null }),
      measureFreshness: probe,
    });
    const result = await runArm(
      { ...options(), freshnessProbes: 1 },
      "metrics-off",
      1,
      "/stub",
      undefined,
      "off",
      h.runtime,
    );
    expect(result.error).toBeUndefined();
    expect(result.summary?.kinds).toEqual({});
    expect(result.summary?.processes.backend?.cpuMsPerMinute).toBe(60_000);
    expect(probe).not.toHaveBeenCalled();
    const env = (h.runtime.startProfile as ReturnType<typeof mock>).mock.calls[0]![3];
    expect(env.ORKESTRATOR_RECURRING_METRICS).toBe("0");
    expect(env.ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK).toBeUndefined();
    expect(env.ORKESTRATOR_NATIVE_OBSERVATION_SHARING).toBeUndefined();
  });

  test("long prefixes preserve invocation, arm and repeat under the profile length limit", async () => {
    const opts = { ...options(), profilePrefix: "a".repeat(100) };
    const left = await runArm(
      opts,
      "candidate",
      1,
      "/stub",
      undefined,
      undefined,
      harness().runtime,
    );
    const right = await runArm(
      opts,
      "metrics-off",
      2,
      "/stub",
      undefined,
      undefined,
      harness().runtime,
    );
    expect(left.profile.length).toBeLessThanOrEqual(48);
    expect(right.profile.length).toBeLessThanOrEqual(48);
    expect(left.profile).not.toBe(right.profile);
    expect(left.profile).toEndWith("-candidate-1");
    expect(right.profile).toEndWith("-metrics-off-2");
  });

  test.each(["startup", "settle", "probe"] as const)(
    "cancellation during %s awaits owned cleanup",
    async (phase) => {
      const controller = new AbortController();
      const h = harness();
      if (phase === "startup") {
        const read = h.runtime.readStatus;
        h.runtime.readStatus = (profile) => {
          const status = read(profile);
          return status?.status === "ready" ? { ...status, status: "starting" } : status;
        };
      }
      const sleep = h.runtime.sleep;
      h.runtime.sleep = async (ms, signal) => {
        if (phase !== "probe" && signal) controller.abort(new Error("cancelled"));
        await sleep(ms, signal);
      };
      h.runtime.measureFreshness = async () => {
        controller.abort(new Error("cancelled"));
        controller.signal.throwIfAborted();
        return [];
      };
      h.runtime.cliRunner = (() => () => undefined) as never;
      const result = await runArm(
        { ...options(), freshnessProbes: phase === "probe" ? 1 : 0 },
        "candidate",
        1,
        "/stub",
        controller.signal,
        "cancel",
        h.runtime,
      );
      expect(result.error).toContain("cancelled");
      expect(h.commands.map((args) => args[0])).toEqual(["dev:stop", "dev:reset"]);
    },
  );

  test("an existing profile is never started, sampled, stopped or reset", async () => {
    const h = harness();
    h.setStatus({ status: "ready", live: { launcher: true } });
    const result = await runArm(
      options(),
      "candidate",
      1,
      "/stub",
      undefined,
      "collision",
      h.runtime,
    );
    expect(result.error).toContain("Refusing to reuse");
    expect(h.runtime.startProfile).not.toHaveBeenCalled();
    expect(h.commands).toEqual([]);
  });

  test("a foreign launcher after start is never sampled or cleaned up", async () => {
    const h = harness();
    const start = h.runtime.startProfile;
    h.runtime.startProfile = mock((profile: string, opts, logDir, env) => {
      const child = start(profile, opts, logDir, env);
      h.setStatus({
        status: "ready",
        startedAt: "foreign",
        processStartTimes: { launcher: 200 },
        pids: { launcher: 456 },
        live: { launcher: true },
      });
      return child;
    });
    const result = await runArm(
      options(),
      "candidate",
      1,
      "/stub",
      undefined,
      "collision",
      h.runtime,
    );
    expect(result.error).toContain("ownership");
    expect(result.summary).toBeNull();
    expect(h.commands).toEqual([]);
  });

  test("a replaced manifest prevents sampling and profile cleanup", async () => {
    const h = harness();
    h.runtime.sleep = async () => {
      h.setStatus({
        status: "ready",
        startedAt: "replacement",
        processStartTimes: { launcher: 200 },
        pids: { launcher: h.child.pid },
        live: { launcher: true },
      });
    };
    const result = await runArm(
      options(),
      "candidate",
      1,
      "/stub",
      undefined,
      "changed",
      h.runtime,
    );
    expect(result.error).toContain("ownership");
    expect(result.summary).toBeNull();
    expect(h.commands).toEqual([]);
  });

  test("startup timeout still cleans up its owned starting profile", async () => {
    const h = harness();
    const read = h.runtime.readStatus;
    h.runtime.readStatus = (profile) => {
      const status = read(profile);
      return status?.status === "missing" ? status : { ...status, status: "starting" };
    };
    const result = await runArm(
      { ...options(), readyTimeoutMs: 1 },
      "candidate",
      1,
      "/stub",
      undefined,
      "timeout",
      h.runtime,
    );
    expect(result.error).toContain("did not become ready");
    expect(h.commands.map((args) => args[0])).toEqual(["dev:stop", "dev:reset"]);
  });

  test("sampling failure cleans up, while keepProfiles only skips reset", async () => {
    const h = harness({
      processSamples: () => {
        throw new Error("ps failed");
      },
    });
    const result = await runArm(
      { ...options(), keepProfiles: true },
      "candidate",
      1,
      "/stub",
      undefined,
      "failure",
      h.runtime,
    );
    expect(result.error).toContain("ps failed");
    expect(h.commands.map((args) => args[0])).toEqual(["dev:stop"]);
  });

  test("probe results include unusable counts and percentiles", async () => {
    const probe = mock(async () => [
      { environment: "local" as const, latenciesMs: [10, 30], timeouts: 1, unusable: 1 },
    ]);
    const h = harness({ measureFreshness: probe, cliRunner: (() => () => undefined) as never });
    const result = await runArm(
      { ...options(), freshnessProbes: 4 },
      "candidate",
      1,
      "/stub",
      undefined,
      "probe",
      h.runtime,
    );
    expect(result.freshness).toEqual([
      {
        environment: "local",
        latenciesMs: [10, 30],
        timeouts: 1,
        unusable: 1,
        p50Ms: 10,
        p95Ms: 30,
      },
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  test("counts guard lines across logs and distinguishes unreadable logs", () => {
    const dir = temporary();
    mkdirSync(path.join(dir, "nested"));
    writeFileSync(
      path.join(dir, "one.log"),
      "Unhandled promise rejection (continuing)\nordinary\nUnhandled promise rejection (continuing)\n",
    );
    writeFileSync(
      path.join(dir, "nested", "two.log"),
      "Unhandled promise rejection (continuing)\n",
    );
    expect(countGuardLines(dir)).toBe(3);
    expect(countGuardLines(path.join(dir, "missing"))).toBeNull();
    expect(countGuardLines(undefined)).toBeNull();
  });
});

describe("freshness probe baselines", () => {
  async function measure(values: Array<number | null | "reset">, probes = 1) {
    let now = 0;
    const write = mock(() => undefined);
    const gateway = {
      metrics: mock(async () => {
        const value = values.length > 1 ? values.shift()! : values[0]!;
        return value === null
          ? null
          : value === "reset"
            ? { recurringWork: { metrics: { kinds: {} } } }
            : metrics(value);
      }),
    };
    const runtime = {
      ...__testing.freshnessRuntime,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      fixtureEnvironments: () => [{ id: "e1", kind: "local" as const }],
      trackedFileWriter: () => write,
    };
    const result = await measureFreshness(
      gateway,
      (() => undefined) as never,
      probes,
      undefined,
      runtime,
    );
    return { result: result[0]!, write, gateway };
  }

  test("a failed pre-write read cannot turn an existing positive counter into detection", async () => {
    const { result, write } = await measure([null, 7, 7], 2);
    expect(result).toMatchObject({ latenciesMs: [], unusable: 1, timeouts: 1 });
    expect(write).toHaveBeenCalledTimes(1);
  });

  test("malformed metrics cannot establish a baseline", async () => {
    for (const changed of ["7", -1, Number.NaN]) {
      const write = mock(() => undefined);
      const result = await measureFreshness(
        {
          metrics: async () => ({
            recurringWork: { metrics: { kinds: { "diff-scan": { changed } } } },
          }),
        },
        (() => undefined) as never,
        1,
        undefined,
        {
          ...__testing.freshnessRuntime,
          fixtureEnvironments: () => [{ id: "e1", kind: "local" }],
          trackedFileWriter: () => write,
        },
      );
      expect(result[0]?.unusable).toBe(1);
      expect(write).not.toHaveBeenCalled();
    }
  });

  test("after a failed baseline only a later genuine increment produces latency", async () => {
    const { result, write } = await measure([null, 7, 7, 8], 2);
    expect(result).toEqual({ environment: "local", latenciesMs: [100], unusable: 1, timeouts: 0 });
    expect(write).toHaveBeenCalledTimes(1);
  });

  test.each([0, "reset"] as const)("a reset (%s) invalidates the probe", async (reset) => {
    const { result } = await measure([7, reset, 9]);
    expect(result).toMatchObject({ latenciesMs: [], unusable: 1, timeouts: 0 });
  });

  test("a failed post-write read does not imply a counter reset", async () => {
    const { result } = await measure([7, null, 8]);
    expect(result).toMatchObject({ latenciesMs: [100], unusable: 0, timeouts: 0 });
  });
});

// Exercise actual OS delivery and asynchronous cleanup in a Bun child so the
// root Happy DOM preload cannot replace the benchmark's timers or signals.
test.each(["SIGTERM", "SIGINT"] as const)(
  "%s waits for owned launcher stop and reset before exit",
  async (signal) => {
    const dir = temporary();
    const script = path.join(dir, "signal.ts");
    const events = path.join(dir, "events");
    writeFileSync(
      script,
      `
    import { EventEmitter } from "node:events";
    import { appendFileSync } from "node:fs";
    import { __testing, parseOptions, runArm, withTerminationSignals } from ${JSON.stringify(path.resolve(import.meta.dir, "../../scripts/recurring-live-ab.ts"))};
    const record = (event) => appendFileSync(${JSON.stringify(events)}, event + "\\n");
    let status = { status: "missing" };
    const child = Object.assign(new EventEmitter(), { pid: 123456, kill: () => true });
    const runtime = { ...__testing.armRuntime,
      readStatus: () => status,
      startProfile: () => { status = { status: "ready", startedAt: "owned", processStartTimes: { launcher: 100 }, pids: { launcher: child.pid }, live: { launcher: true } }; return child; },
      gatewayFor: () => ({ metrics: async () => { record("sampling"); return null; } }),
      processSamples: () => ({}),
      mise: (args) => { record(args[0]); if (args[0] === "dev:stop") setTimeout(() => { record("launcher-exited"); child.emit("exit", 0); }, 30); return { status: 0 }; },
    };
    process.exitCode = await withTerminationSignals(async (signal) => {
      const result = await runArm({ ...parseOptions([]), settleMs: 0, sampleMs: 60000, windowMs: 120000, freshnessProbes: 0 }, "candidate", 1, "/stub", signal, "signal", runtime);
      record("done"); return result.error ? 1 : 0;
    });
  `,
    );
    const child = spawn(process.execPath, [script], { stdio: "ignore" });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          if (readFileSync(events, "utf8").includes("sampling")) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(readFileSync(events, "utf8")).toContain("sampling");
      child.kill(signal);
      expect(await done).toBe(signal === "SIGTERM" ? 143 : 130);
      expect(readFileSync(events, "utf8").trim().split("\n")).toEqual([
        "sampling",
        "dev:stop",
        "launcher-exited",
        "dev:reset",
        "done",
      ]);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await done;
    }
  },
  10_000,
);

describe("soak", () => {
  const footprint = (keys: number, records: number) => ({
    stream: { open: 1 },
    recurringWork: {
      metrics: { kinds: {} },
      schedulers: [{ owner: "backend-activity", keys, settling: 0, byKind: {} }],
      admission: [],
      fetchPolicies: [{ name: "container-git-fetch", status: { records, containers: records } }],
      signals: [],
    },
  });

  function soakHarness(responses: Array<ReturnType<typeof footprint>>, failing: string[] = []) {
    let now = 0;
    const calls: string[][] = [];
    const cli = ((args: string[]) => {
      calls.push(args);
      const verb = `${args[0]} ${args[1]}`;
      const status = failing.includes(verb) ? 1 : 0;
      const stdout =
        verb === "environment create"
          ? JSON.stringify({ result: { environment: { id: `env-${calls.length}` } } })
          : "{}";
      return { status, stdout, stderr: "" };
    }) as never;
    const gateway = {
      metrics: mock(async () => (responses.length > 1 ? responses.shift()! : responses[0]!)),
    };
    const runtime = {
      ...__testing.soakRuntime,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      fixtureProjectId: () => "project-1",
    };
    return { cli, calls, gateway, runtime };
  }

  test("parses soak options", () => {
    expect(parseOptions([]).soakCycles).toBe(0);
    const parsed = parseOptions(["--soak-cycles", "5", "--soak-environments", "local,container"]);
    expect(parsed.soakCycles).toBe(5);
    expect(parsed.soakEnvironments).toEqual(["local", "container"]);
    expect(() => parseOptions(["--soak-environments", "vm"])).toThrow();
    expect(() => parseOptions(["--soak-cycles", "1.5"])).toThrow();
  });

  test("cycles every kind through create, start, stop, restart and delete", async () => {
    const h = soakHarness([footprint(4, 0)]);
    const result = await measureSoak(
      h.gateway,
      h.cli,
      { soakCycles: 2, soakEnvironments: ["local", "container"], settleMs: 1_000 },
      () => 2048,
      undefined,
      h.runtime,
    );
    expect(result.cyclesCompleted).toBe(2);
    expect(result.failures).toEqual([]);
    expect(result.leaks).toEqual([]);
    expect(result.baseline?.["scheduler:backend-activity:keys"]).toBe(4);
    expect(result.backendRssKiB).toEqual({ baseline: 2048, final: 2048 });
    const verbs = h.calls.map(
      (args) => args.slice(0, 2).join(" ") + (args[3] ? ` ${args[3]}` : ""),
    );
    expect(verbs.slice(0, 5)).toEqual([
      "environment create project-1",
      "environment start --wait",
      "environment stop --wait",
      "environment start --wait",
      "environment delete --wait",
    ]);
    expect(h.calls.filter((args) => args[1] === "create")).toHaveLength(4);
    expect(h.calls.find((args) => args[1] === "create")).toContain("local");
    expect(h.calls.filter((args) => args[1] === "create")[1]).toContain("container");
  });

  test("a gauge above its baseline after the settle is a leak; a transient one is not", async () => {
    // Before: 4 keys at most. After: one sample still at 6 while a job
    // settles, but the lowest settled reading is 5 with one fetch record.
    const h = soakHarness([
      footprint(4, 0),
      footprint(3, 0),
      footprint(4, 0),
      footprint(6, 1),
      footprint(5, 1),
      footprint(5, 1),
    ]);
    const result = await measureSoak(
      h.gateway,
      h.cli,
      { soakCycles: 1, soakEnvironments: ["local"], settleMs: 1_000 },
      () => null,
      undefined,
      h.runtime,
    );
    expect(result.leaks).toEqual([
      { gauge: "fetch:container-git-fetch:containers", baseline: 0, final: 1 },
      { gauge: "fetch:container-git-fetch:records", baseline: 0, final: 1 },
      { gauge: "scheduler:backend-activity:keys", baseline: 4, final: 5 },
    ]);
  });

  test("a failed step still deletes the environment and is reported", async () => {
    const h = soakHarness([footprint(4, 0)], ["environment stop"]);
    const result = await measureSoak(
      h.gateway,
      h.cli,
      { soakCycles: 1, soakEnvironments: ["local"], settleMs: 0 },
      () => null,
      undefined,
      h.runtime,
    );
    expect(result.failures).toEqual([{ cycle: 1, kind: "local", step: "stop" }]);
    expect(h.calls.map((args) => args[1])).toEqual(["create", "start", "stop", "delete"]);
  });

  test("runArm soaks only when cycles are requested", async () => {
    const soak = mock(async () => ({
      cyclesRequested: 1,
      cyclesCompleted: 1,
      durationMs: 0,
      failures: [],
      baseline: {},
      final: {},
      leaks: [],
      backendRssKiB: { baseline: null, final: null },
    }));
    const h = harness({ measureSoak: soak, cliRunner: (() => () => undefined) as never });
    const skipped = await runArm(options(), "candidate", 1, "/stub", undefined, "a", h.runtime);
    expect(skipped.soak).toBeUndefined();
    expect(soak).not.toHaveBeenCalled();
    const h2 = harness({ measureSoak: soak, cliRunner: (() => () => undefined) as never });
    const soaked = await runArm(
      { ...options(), soakCycles: 1 },
      "candidate",
      1,
      "/stub",
      undefined,
      "b",
      h2.runtime,
    );
    expect(soaked.error).toBeUndefined();
    expect(soaked.soak?.cyclesCompleted).toBe(1);
  });
});
