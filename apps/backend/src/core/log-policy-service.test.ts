import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configureLogger,
  createLogger,
  resetLogger,
  type LogOutput,
} from "@orkestrator/protocol/logger";
import { BRIDGE_LOG_POLICY_ROUTE, parseBridgeLogPolicy } from "@orkestrator/protocol/log-policy";
import { LogPolicyService, type BridgeLogPolicyTarget } from "./log-policy-service.js";

const directories: string[] = [];

afterEach(async () => {
  resetLogger();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Answer = Response | ((body: Record<string, unknown>) => Response | Promise<Response>);

const target: BridgeLogPolicyTarget = {
  agent: "claude",
  baseUrl: "http://127.0.0.1:4000",
  authToken: "token-a",
};

async function harness(
  options: {
    global?: Record<string, unknown>;
    targets?: BridgeLogPolicyTarget[];
    answers?: Answer[];
    env?: NodeJS.ProcessEnv;
    sleep?: (delay: number) => Promise<void>;
    listRunningBridges?: (
      onTarget?: (target: BridgeLogPolicyTarget) => void,
    ) => Promise<BridgeLogPolicyTarget[]>;
  } = {},
) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "log-policy-service-"));
  directories.push(dataDir);
  const writeGlobal = (global: Record<string, unknown>) =>
    writeFile(path.join(dataDir, "config.json"), JSON.stringify({ global }));
  await writeGlobal(options.global ?? {});
  const logged: LogOutput[] = [];
  configureLogger({ sink: (output) => logged.push(output) });
  const requests: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
  const answers = [...(options.answers ?? [])];
  const writer: Array<{ enabled: boolean; retentionDays: number }> = [];
  let listCalls = 0;
  const service = new LogPolicyService({
    dataDir,
    logging: { updateSettings: (next) => writer.push(next) },
    listRunningBridges: async (onTarget) => {
      listCalls += 1;
      return options.listRunningBridges?.(onTarget) ?? options.targets ?? [target];
    },
    env: options.env ?? {},
    now: () => 1_000,
    sleep: options.sleep ?? (async () => undefined),
    retryDelaysMs: [1],
    fetch: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      requests.push({
        url,
        auth: (init.headers as Record<string, string>).Authorization!,
        body,
      });
      const answer = answers.shift();
      if (typeof answer === "function") return answer(body);
      return answer ?? Response.json({ applied: true });
    }) as unknown as typeof fetch,
  });
  const settle = async () => {
    for (let index = 0; index < 20; index += 1) await Bun.sleep(1);
  };
  return {
    dataDir,
    service,
    writeGlobal,
    logged,
    requests,
    writer,
    settle,
    audits: () => logged.filter((output) => output.record?.event === "policy.changed"),
    get listCalls() {
      return listCalls;
    },
  };
}

describe("LogPolicyService", () => {
  test("a start applies what is stored and pushes it, with no audit line", async () => {
    const h = await harness({
      global: { debugLogging: true, logDetail: { level: "warn", areaLevels: {} } },
    });
    h.service.start();
    await h.settle();
    expect(h.audits()).toHaveLength(0);
    expect(createLogger("updater").isEnabled("info")).toBe(false);
    expect(h.writer).toEqual([{ enabled: true, retentionDays: 7 }]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.url).toBe(`${target.baseUrl}${BRIDGE_LOG_POLICY_ROUTE}`);
    expect(h.requests[0]!.auth).toBe("Bearer token-a");
    expect(parseBridgeLogPolicy(h.requests[0]!.body)).toMatchObject({ level: "warn" });
  });

  test("a change applies to the backend and bridges, with one content-free audit line", async () => {
    const h = await harness();
    const log = createLogger("updater");
    h.service.start();
    await h.settle();
    await h.writeGlobal({ logDetail: { level: "info", areaLevels: { updater: "debug" } } });
    h.service.configChanged();
    await h.settle();

    expect(log.isEnabled("debug")).toBe(true);
    expect(h.requests.at(-1)!.body).toMatchObject({
      level: "info",
      areaLevels: { updater: "debug" },
    });
    expect(h.audits()).toHaveLength(1);
    expect(h.audits()[0]!.record!.fields).toEqual({
      saving: false,
      retentionDays: 7,
      level: "info",
      areaLevels: "updater=debug",
    });
  });

  test("the audit line survives a level that would filter it", async () => {
    const h = await harness();
    h.service.start();
    await h.settle();
    await h.writeGlobal({ logDetail: { level: "error", areaLevels: {} } });
    h.service.configChanged();
    expect(h.audits()).toHaveLength(1);
  });

  test("a config write that leaves logging alone does nothing", async () => {
    const h = await harness({ global: { terminalScrollback: 1 } });
    h.service.start();
    await h.settle();
    const requests = h.requests.length;
    await h.writeGlobal({ terminalScrollback: 2 });
    h.service.configChanged();
    await h.settle();
    expect(h.audits()).toHaveLength(0);
    expect(h.requests).toHaveLength(requests);
  });

  test("a saving change reaches the writer and audits, without troubling any bridge", async () => {
    const h = await harness();
    h.service.start();
    await h.settle();
    const requests = h.requests.length;
    await h.writeGlobal({
      debugLogging: true,
      debugLogRetentionDays: 3,
      logDetail: { level: "info", areaLevels: {} },
    });
    h.service.configChanged();
    await h.settle();
    expect(h.writer.at(-1)).toEqual({ enabled: true, retentionDays: 3 });
    expect(h.audits()).toHaveLength(1);
    expect(h.requests).toHaveLength(requests);
  });

  test("an unreadable config leaves everything as it was", async () => {
    const h = await harness({ global: { debugLogging: true } });
    h.service.start();
    await h.settle();
    const writes = h.writer.length;
    await writeFile(path.join(h.dataDir, "config.json"), "{ torn");
    h.service.configChanged();
    await h.settle();
    expect(h.writer).toHaveLength(writes);
    expect(h.audits()).toHaveLength(0);
  });

  test.each([[404], [405]])(
    "a %i is a bridge that predates the route: no retry, no warning",
    async (status) => {
      const h = await harness({ answers: [new Response("", { status })] });
      h.service.start();
      await h.settle();
      expect(h.requests).toHaveLength(1);
      expect(h.logged.filter((output) => output.record?.level === "warn")).toHaveLength(0);
      // Nor does a repeated start ask it again.
      h.service.bridgeStarted(target);
      await h.settle();
      expect(h.requests).toHaveLength(1);
    },
  );

  test("a failure retries, then warns once, and the next start resends", async () => {
    const failure = () => new Response("", { status: 500 });
    const h = await harness({ answers: [failure(), failure()] });
    h.service.start();
    await h.settle();
    expect(h.requests).toHaveLength(2);
    const warnings = h.logged.filter((output) => output.record?.event === "policy.push-failed");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.record!.fields).toEqual({ agent: "claude", reason: "http-500" });
    expect(warnings[0]!.line).not.toContain("token-a");

    h.service.bridgeStarted(target);
    await h.settle();
    expect(h.requests).toHaveLength(3);
  });

  test("a bridge that already took this policy gets nothing on a repeated start", async () => {
    const h = await harness();
    h.service.start();
    await h.settle();
    h.service.bridgeStarted(target);
    h.service.bridgeStarted(target);
    await h.settle();
    expect(h.requests).toHaveLength(1);
  });

  test("a replaced bridge at the same address counts as new", async () => {
    const h = await harness();
    h.service.start();
    await h.settle();
    h.service.bridgeStarted({ ...target, authToken: "token-b" });
    await h.settle();
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.auth).toBe("Bearer token-b");
  });

  test("a bridge holding a newer sequence moves this one past it", async () => {
    const h = await harness({
      answers: [Response.json({ applied: false, stale: true, seq: 5_000 })],
    });
    h.service.start();
    await h.settle();
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.body.seq).toBe(5_001);
  });

  test("a change during a slow delivery is sent straight after it", async () => {
    let release: (response: Response) => void = () => undefined;
    const h = await harness({
      answers: [() => new Promise<Response>((resolve) => (release = resolve))],
    });
    h.service.start();
    await h.settle();
    await h.writeGlobal({ logDetail: { level: "debug", areaLevels: {} } });
    h.service.configChanged();
    await h.settle();
    expect(h.requests).toHaveLength(1);
    release(Response.json({ applied: true }));
    await h.settle();
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.body.level).toBe("debug");
  });

  test("a superseded final failure gives the new sequence a fresh retry budget", async () => {
    const held = Promise.withResolvers<Response>();
    const failed = () => new Response("", { status: 500 });
    const h = await harness({
      answers: [failed(), () => held.promise, failed(), Response.json({ applied: true })],
    });
    h.service.start();
    await h.settle();
    expect(h.requests).toHaveLength(2);
    await h.writeGlobal({ logDetail: { level: "debug", areaLevels: {} } });
    h.service.configChanged();
    await h.settle();
    held.resolve(failed());
    await h.settle();
    expect(h.requests.map((request) => request.body.level)).toEqual([
      "info",
      "info",
      "debug",
      "debug",
    ]);
    expect(h.requests[2]!.body.seq).toBe(h.requests[3]!.body.seq);
    expect(h.requests[2]!.body.seq).toBeGreaterThan(h.requests[1]!.body.seq as number);
    expect(h.logged.filter((output) => output.record?.event === "policy.push-failed")).toHaveLength(
      0,
    );
  });

  test("later targets get first attempts while an earlier target sleeps between retries", async () => {
    const retry = Promise.withResolvers<void>();
    const targets = Array.from({ length: 10 }, (_, index) => ({
      ...target,
      baseUrl: `http://127.0.0.1:${5000 + index}`,
    }));
    const h = await harness({
      targets,
      answers: [new Response("", { status: 500 })],
      sleep: () => retry.promise,
    });
    h.service.start();
    await h.settle();
    expect(new Set(h.requests.map((request) => request.url)).size).toBe(10);
    retry.resolve();
    await h.settle();
    expect(h.requests).toHaveLength(11);
  });

  test("HTTP concurrency stays bounded even with more than eight ready targets", async () => {
    const held = Promise.withResolvers<Response>();
    const targets = Array.from({ length: 12 }, (_, index) => ({
      ...target,
      authToken: `token-${index}`,
    }));
    const h = await harness({
      targets,
      answers: Array.from({ length: 8 }, () => async () => (await held.promise).clone()),
    });
    h.service.start();
    await h.settle();
    expect(h.requests).toHaveLength(8);
    held.resolve(Response.json({ applied: true }));
    await h.settle();
    expect(h.requests).toHaveLength(12);
  });

  test("streams discovered targets before the remaining discovery finishes", async () => {
    const discovery = Promise.withResolvers<BridgeLogPolicyTarget[]>();
    const h = await harness({
      listRunningBridges: async (onTarget) => {
        onTarget?.(target);
        return discovery.promise;
      },
    });
    h.service.start();
    await h.settle();
    expect(h.requests).toHaveLength(1);
    discovery.resolve([target]);
    await h.settle();
    expect(h.requests).toHaveLength(1);
  });

  test("backend environment overrides stay local and do not mask stored bridge changes", async () => {
    const h = await harness({ env: { ORKESTRATOR_LOG_LEVEL: "debug" } });
    h.service.start();
    await h.settle();
    expect(createLogger("updater").isEnabled("debug")).toBe(true);
    expect(h.requests[0]!.body.level).toBe("info");
    await h.writeGlobal({ logDetail: { level: "error", areaLevels: {} } });
    h.service.configChanged();
    await h.settle();
    expect(createLogger("updater").isEnabled("debug")).toBe(true);
    expect(h.requests.at(-1)!.body.level).toBe("error");
  });

  test("a failed bridge listing costs one warning and nothing else", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "log-policy-service-"));
    directories.push(dataDir);
    const logged: LogOutput[] = [];
    configureLogger({ sink: (output) => logged.push(output) });
    const service = new LogPolicyService({
      dataDir,
      logging: null,
      listRunningBridges: () => Promise.reject(new Error("docker down")),
      env: {},
    });
    service.start();
    await Bun.sleep(5);
    expect(logged.map((output) => output.record?.event)).toEqual(["policy.push-failed"]);
  });

  test("nothing is sent once stopped", async () => {
    const h = await harness();
    h.service.start();
    await h.settle();
    const requests = h.requests.length;
    h.service.stop();
    h.service.bridgeStarted({ ...target, authToken: "token-b" });
    await h.writeGlobal({ logDetail: { level: "debug", areaLevels: {} } });
    h.service.configChanged();
    await h.settle();
    expect(h.requests).toHaveLength(requests);
    expect(h.audits()).toHaveLength(0);
  });
});

test("backend lifecycle wires a real config save and removes its listener on shutdown", async () => {
  const { StorageService } = await import("./storage.js");
  const { startLogPolicyService } = await import("./log-policy-service.js");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "log-policy-wiring-"));
  directories.push(dataDir);
  const storage = new StorageService(dataDir, { snapshots: false });
  await storage.init();
  const writes: boolean[] = [];
  let reads = 0;
  const lifecycle = startLogPolicyService(
    {
      getDataDir: () => dataDir,
      addResourceChangeListener: (listener) =>
        storage.addResourceChangeListener((change) => {
          reads++;
          listener(change);
        }),
    },
    {
      logging: { updateSettings: (settings) => writes.push(settings.enabled) },
      listRunningBridges: async () => [],
      env: {},
    },
  );
  try {
    const config = await storage.loadConfig();
    await storage.saveConfig({ ...config, global: { ...config.global, debugLogging: true } });
    expect(reads).toBeGreaterThan(0);
    expect(writes.at(-1)).toBe(true);
    lifecycle.stop();
    const count = reads;
    await storage.saveConfig({ ...config, global: { ...config.global, debugLogging: false } });
    expect(reads).toBe(count);
    expect(writes.at(-1)).toBe(true);
  } finally {
    lifecycle.stop();
    storage.close();
  }
});

test.each([Number.MAX_SAFE_INTEGER, -1, 1_000_000_000_000])(
  "an implausible stale sequence %s stays isolated to its bridge",
  async (seq) => {
    const h = await harness({
      targets: [target, { ...target, agent: "pi", baseUrl: "http://127.0.0.1:4001" }],
      answers: [Response.json({ stale: true, seq })],
    });
    h.service.start();
    await h.settle();
    expect(h.requests.every((request) => Number.isSafeInteger(request.body.seq))).toBe(true);
    expect(h.requests.find((request) => request.url.includes(":4001"))!.body.seq).toBe(1000);
    await h.writeGlobal({ logDetail: { level: "debug", areaLevels: {} } });
    h.service.configChanged();
    await h.settle();
    expect(h.requests.at(-1)!.body.seq).toBe(1001);
    h.service.stop();
  },
);

test("continually rising stale answers have a bounded recovery budget", async () => {
  const stale = (body: Record<string, unknown>) =>
    Response.json({ stale: true, seq: Number(body.seq) + 1 });
  const h = await harness({ answers: Array.from({ length: 10 }, () => stale) });
  h.service.start();
  await h.settle();
  expect(h.requests).toHaveLength(3); // one recovery plus the ordinary retry budget
  expect(h.logged.filter((output) => output.record?.event === "policy.push-failed")).toHaveLength(
    1,
  );
  h.service.stop();
});

test("an honest stale recovery remains monotonic across later settings without affecting peers", async () => {
  const h = await harness({
    targets: [target, { ...target, agent: "pi", baseUrl: "http://127.0.0.1:4001" }],
    answers: [Response.json({ stale: true, seq: 5000 })],
  });
  h.service.start();
  await h.settle();
  await h.writeGlobal({ logDetail: { level: "debug", areaLevels: {} } });
  h.service.configChanged();
  await h.settle();
  expect(
    h.requests
      .filter((request) => request.url.includes(":4000"))
      .map((request) => request.body.seq),
  ).toEqual([1000, 5001, 5002]);
  expect(
    h.requests
      .filter((request) => request.url.includes(":4001"))
      .map((request) => request.body.seq),
  ).toEqual([1000, 1001]);
});

test("oversized chunked answers are cancelled and reported without consuming the rest", async () => {
  let cancelled = false;
  let chunks = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        chunks++;
        controller.enqueue(new Uint8Array(2048));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  const h = await harness({ answers: [response, Response.json(null)] });
  h.service.start();
  await h.settle();
  expect(cancelled).toBe(true);
  expect(chunks).toBeLessThanOrEqual(4);
  expect(h.requests).toHaveLength(2);
  expect(
    h.logged.find((output) => output.record?.event === "policy.push-failed")?.record?.fields
      ?.reason,
  ).toBe("malformed-answer");
});
