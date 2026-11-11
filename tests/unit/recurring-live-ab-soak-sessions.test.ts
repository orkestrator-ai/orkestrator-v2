import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __testing,
  measureSoak,
  parseOptions,
  profileArguments,
} from "../../scripts/recurring-live-ab";
import {
  FAKE_PI_MODEL_REF,
  profilePiAgentDirectory,
  startFakeModelServer,
  writeFakePiModels,
  type FakeModelServer,
} from "../../scripts/recurring-live-ab-fake-model";
import { nativeWebPlatform } from "../register-dom";

// The root preload installs Happy DOM's fetch and Response; a loopback server
// needs Bun's own.
const fetch = nativeWebPlatform.fetch;

const directories: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "recurring-soak-sessions-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const metrics = (rows: number, owners: number) => ({
  stream: { open: 1 },
  recurringWork: {
    metrics: { kinds: {} },
    schedulers: [{ owner: "backend-activity", keys: 4, settling: 0, byKind: {} }],
    admission: [],
    fetchPolicies: [],
    signals: [],
    caches: [
      { name: "storage-row-cache", sources: 1, gauges: { rows } },
      { name: "change-tracking", sources: 1, gauges: { worktreeOwners: owners } },
    ],
  },
});

/** A soak runtime whose CLI and fake model are in memory. */
function sessionHarness(options: {
  cycleRows: (cycle: number) => number;
  answer?: boolean;
  catalogue?: string;
}) {
  let now = 0;
  let cycle = 0;
  let completions = 0;
  const calls: string[][] = [];
  const stop = mock(async () => undefined);
  const written: Array<{ dataDir: string; baseUrl: string }> = [];
  const fake: FakeModelServer = {
    baseUrl: "http://127.0.0.1:1/v1",
    counts: () => ({ completions, models: 0, refused: 0 }),
    workflow: () => ({}),
    marker: () => null,
    release: () => undefined,
    stop,
  };
  let sessions = 0;
  const cli = (async (args: string[]) => {
    calls.push(args);
    const verb = `${args[0]} ${args[1]}`;
    if (verb === "environment create") {
      cycle += 1;
      return {
        status: 0,
        stdout: JSON.stringify({ result: { environment: { id: `env-c${cycle}` } } }),
      };
    }
    if (verb === "agent options") {
      // The real command refuses options it does not take.
      if (args.includes("--timeout")) return { status: 2, stdout: "{}" };
      return {
        status: 0,
        stdout: options.catalogue ?? JSON.stringify({ models: [FAKE_PI_MODEL_REF] }),
      };
    }
    if (verb === "session start" || verb === "session prompt") {
      if (options.answer !== false) completions += 1;
      // Pi runs end `run-unknown` (exit 7), with the session in the receipt.
      const id = verb === "session start" ? `ses-${++sessions}` : args[2];
      return {
        status: 7,
        stdout: JSON.stringify({ ok: false, receipt: { resources: { sessionId: id } } }),
      };
    }
    return { status: 0, stdout: "{}" };
  }) as never;
  const gateway = {
    metrics: mock(async () => metrics(options.cycleRows(cycle), 1)),
  };
  const runtime = {
    ...__testing.soakRuntime,
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    fixtureProjectId: async () => "project-1",
    fixtureLocalEnvironmentId: async () => "env-fixture",
    environmentName: async (_cli: unknown, id: string) => (id === "env-fixture" ? "fixture" : null),
    startFakeModel: () => fake,
    writeFakePiModels: (dataDir: string, baseUrl: string) => {
      written.push({ dataDir, baseUrl });
      return path.join(dataDir, "models.json");
    },
  };
  return { cli, calls, gateway, runtime, stop, written };
}

describe("soak sessions and trends", () => {
  test("parses the session and gap options and bounds the session count", () => {
    const parsed = parseOptions(["--soak-sessions", "2", "--soak-cycle-gap-ms", "60000"]);
    expect(parsed.soakSessions).toBe(2);
    expect(parsed.soakCycleGapMs).toBe(60_000);
    expect(parseOptions([]).soakSessions).toBe(0);
    expect(() => parseOptions(["--soak-sessions", "9"])).toThrow();
    expect(() => parseOptions(["--soak-sessions", "1.5"])).toThrow();
  });

  test("starts profiles headless, credential-free and optionally on chosen toolchains", () => {
    const defaults = profileArguments("p", parseOptions([]));
    expect(defaults).toEqual(expect.arrayContaining(["--headless", "--no-agent-credentials"]));
    expect(defaults).not.toContain("--agent-platforms");
    const narrowed = profileArguments("p", parseOptions(["--agent-platforms", "pi"]));
    expect(narrowed.slice(-2)).toEqual(["--agent-platforms", "pi"]);
    expect(() => parseOptions(["--agent-platforms", "pi;rm"])).toThrow();
  });

  test("keeps fake-model sessions open, prompts them every cycle and samples the trend", async () => {
    const h = sessionHarness({ cycleRows: () => 100 });
    const result = await measureSoak(
      h.gateway,
      h.cli,
      {
        soakCycles: 6,
        soakEnvironments: ["local"],
        settleMs: 0,
        soakCycleGapMs: 1_000,
        soakSessions: 2,
        dataDir: "/profile/data",
      },
      () => 4096,
      undefined,
      h.runtime,
    );
    expect(result.failures).toEqual([]);
    expect(h.written).toEqual([{ dataDir: "/profile/data", baseUrl: "http://127.0.0.1:1/v1" }]);
    expect(result.sessions).toEqual({
      requested: 2,
      opened: 2,
      cycleSessions: 6,
      prompts: 12,
      modelRequests: 20,
    });
    expect(h.stop).toHaveBeenCalledTimes(1);
    // The catalogue is refreshed once the fake provider exists, before any session.
    const firstSession = h.calls.findIndex((args) => args[0] === "session");
    const refresh = h.calls.findIndex((args) => args.includes("--refresh"));
    expect(refresh).toBeGreaterThanOrEqual(0);
    expect(refresh).toBeLessThan(firstSession);
    const start = h.calls.find((args) => args[0] === "session" && args[1] === "start")!;
    expect(start).toEqual(expect.arrayContaining(["--agent", "pi", "--model", FAKE_PI_MODEL_REF]));
    expect(start).toContain("--wait");
    // A cycle's session is opened on that cycle's environment while it is ready.
    const cycleStart = h.calls.findIndex((args) => args.includes("env-c1"));
    expect(h.calls[cycleStart + 1]).toEqual(expect.arrayContaining(["session", "start", "env-c1"]));
    expect(result.trend.map((sample) => sample.cycle)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.trend[0]?.caches).toMatchObject({ "cache:storage-row-cache:rows": 100 });
    expect(result.trend[0]?.backendRssKiB).toBe(4096);
    expect(result.growing).toEqual([]);
    expect(result.rssTrend).toMatchObject({ gauge: "backend:rssKiB", growing: false });
  });

  test("a cache that climbs every cycle is reported as rising", async () => {
    const h = sessionHarness({ cycleRows: (cycle) => 100 + cycle * 10 });
    const result = await measureSoak(
      h.gateway,
      h.cli,
      { soakCycles: 9, soakEnvironments: ["local"], settleMs: 0 },
      () => null,
      undefined,
      h.runtime,
    );
    expect(result.growing.map((trend) => trend.gauge)).toEqual(["cache:storage-row-cache:rows"]);
    expect(
      result.cacheTrends.find((trend) => trend.gauge.endsWith(":worktreeOwners")),
    ).toMatchObject({ growing: false });
    expect(result.rssTrend).toBeNull();
  });

  test("a session the fake model never answered refuses to start the soak, and stops the model", async () => {
    const h = sessionHarness({ cycleRows: () => 1, answer: false });
    await expect(
      measureSoak(
        h.gateway,
        h.cli,
        {
          soakCycles: 1,
          soakEnvironments: ["local"],
          settleMs: 0,
          soakSessions: 1,
          dataDir: "/profile/data",
        },
        () => null,
        undefined,
        h.runtime,
      ),
    ).rejects.toThrow("did not answer on the fake model");
    expect(h.stop).toHaveBeenCalledTimes(1);
  });

  test("a catalogue that never lists the fake model stops the soak before any session", async () => {
    const h = sessionHarness({ cycleRows: () => 1, catalogue: "{}" });
    await expect(
      measureSoak(
        h.gateway,
        h.cli,
        {
          soakCycles: 1,
          soakEnvironments: ["local"],
          settleMs: 0,
          soakSessions: 1,
          dataDir: "/profile/data",
        },
        () => null,
        undefined,
        h.runtime,
      ),
    ).rejects.toThrow("did not list the fake model");
    expect(h.calls.some((args) => args[0] === "session")).toBe(false);
    expect(h.stop).toHaveBeenCalledTimes(1);
  });

  test("a browser reader needs sessions and is at most one", () => {
    expect(parseOptions(["--soak-sessions", "2", "--soak-readers", "1"]).soakReaders).toBe(1);
    expect(parseOptions([]).soakReaders).toBe(0);
    expect(() => parseOptions(["--soak-readers", "1"])).toThrow("needs --soak-sessions");
    expect(() => parseOptions(["--soak-sessions", "1", "--soak-readers", "2"])).toThrow();
  });

  test("a reader opens each cycle's session tab, then the long-lived ones, every cycle", async () => {
    const h = sessionHarness({ cycleRows: () => 1 });
    const reads: string[] = [];
    const reader = {
      read: mock(async (name: string) => {
        reads.push(name);
        // The fixture's tabs are the two long-lived sessions.
        if (name === "soak-local-2") throw new Error("tab never showed the reply");
        return name === "fixture" ? 2 : 1;
      }),
      close: mock(async () => undefined),
    };
    const result = await measureSoak(
      h.gateway,
      h.cli,
      {
        soakCycles: 3,
        soakEnvironments: ["local"],
        settleMs: 0,
        soakSessions: 2,
        dataDir: "/profile/data",
        reader,
      },
      () => null,
      undefined,
      h.runtime,
    );
    expect(reads).toEqual([
      "soak-local-1",
      "fixture",
      "soak-local-2",
      "fixture",
      "soak-local-3",
      "fixture",
    ]);
    // A read that fails is the cycle's `read` step; the soak carries on.
    expect(result.failures).toEqual([{ cycle: 2, kind: "local", step: "read" }]);
    expect(result.cyclesCompleted).toBe(3);
    expect(result.reader).toEqual({ reads: 5, tabs: 8 });
    // The reader is the caller's to close.
    expect(reader.close).not.toHaveBeenCalled();
  });

  test("a soak without a reader reports none", async () => {
    const h = sessionHarness({ cycleRows: () => 1 });
    const result = await measureSoak(
      h.gateway,
      h.cli,
      { soakCycles: 1, soakEnvironments: ["local"], settleMs: 0 },
      () => null,
      undefined,
      h.runtime,
    );
    expect(result.reader).toBeUndefined();
  });

  test("sessions need the profile's data directory", async () => {
    const h = sessionHarness({ cycleRows: () => 1 });
    await expect(
      measureSoak(
        h.gateway,
        h.cli,
        { soakCycles: 1, soakEnvironments: ["local"], settleMs: 0, soakSessions: 1 },
        () => null,
        undefined,
        h.runtime,
      ),
    ).rejects.toThrow("data directory");
  });
});

describe("fake model endpoint", () => {
  test("answers a streamed chat completion on loopback and keeps only counts", async () => {
    const server = startFakeModelServer({ Response: nativeWebPlatform.Response });
    try {
      expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "soak-1", stream: true, messages: [] }),
      });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const body = await response.text();
      expect(body).toContain('"content":"Soak reply."');
      expect(body).toContain('"finish_reason":"stop"');
      expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
      const plain = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
      });
      expect(((await plain.json()) as { choices: unknown[] }).choices).toHaveLength(1);
      expect(
        (await fetch(`${server.baseUrl}/chat/completions`, { method: "POST", body: "{" })).status,
      ).toBe(400);
      expect((await fetch(`${server.baseUrl}/elsewhere`)).status).toBe(404);
      expect(server.counts()).toEqual({ completions: 2, models: 0, refused: 2 });
    } finally {
      await server.stop();
    }
  });

  test("writes the profile's own Pi models.json, owner-only, and never over other providers", () => {
    const dataDir = temporary();
    const file = writeFakePiModels(dataDir, "http://127.0.0.1:4321/v1");
    expect(file).toBe(path.join(profilePiAgentDirectory(dataDir), "models.json"));
    expect(file.startsWith(path.join(dataDir, "agent-credentials", "home", ".pi", "agent"))).toBe(
      true,
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(file, "utf8")) as {
      providers: Record<string, { baseUrl: string; models: Array<{ id: string }> }>;
    };
    expect(Object.keys(written.providers)).toEqual(["soak-fake"]);
    expect(written.providers["soak-fake"]?.baseUrl).toBe("http://127.0.0.1:4321/v1");
    // Rewriting its own provider is allowed (a new port); another provider is not touched.
    writeFakePiModels(dataDir, "http://127.0.0.1:4322/v1");
    writeFileSync(file, JSON.stringify({ providers: { openai: {} } }));
    expect(() => writeFakePiModels(dataDir, "http://127.0.0.1:4323/v1")).toThrow(
      "already names other providers",
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ providers: { openai: {} } });
    const other = temporary();
    mkdirSync(profilePiAgentDirectory(other), { recursive: true });
    expect(existsSync(path.join(profilePiAgentDirectory(other), "models.json"))).toBe(false);
  });
});
