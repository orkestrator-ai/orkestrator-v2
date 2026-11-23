import { expect, mock, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrkestratorBackend } from "./index.js";
import { readHealthRows } from "./health-summary.js";
import { BackgroundCheckpointer } from "./storage/checkpointer.js";
import { openBackendDatabase } from "./storage/stores.js";

function createBackend(dataDir: string) {
  return new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    agentTools: {
      start: async () => undefined,
      stop: async () => undefined,
      connection: () => ({ url: "http://127.0.0.1:43210/mcp", token: "test-token" }),
      revokeEnvironment: () => undefined,
    },
    startupReapers: { localServers: async () => [], claudeTmuxRuntimes: async () => [] },
  });
}

test("a real backend reports its database figures and leaves a clean-exit marker on shutdown", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-diagnostics-"));
  try {
    const backend = createBackend(dataDir);
    await backend.init();
    // The gateway reaches these through optional methods, so a type cannot catch a gap.
    expect(backend.databaseStats().main?.fileBytes).toBeGreaterThan(0);
    expect(backend.databaseStats().leaseWaits.bucketsMs.length).toBeGreaterThan(0);
    const gatewaySnapshot = { gateway: true };
    backend.attachGatewayMetrics(() => gatewaySnapshot);
    expect(backend.diagnostics.metricsSnapshot()).toBe(gatewaySnapshot);

    // Off under the test runner by default, like snapshots.
    backend.diagnostics.health.start();
    backend.diagnostics.health.sample();
    await backend.shutdown();

    const database = openBackendDatabase(dataDir);
    try {
      expect(readHealthRows(database).map((row) => row.kind)).toEqual([
        "started",
        "sample",
        "clean-exit",
      ]);
    } finally {
      database.close();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);

test("a failed shutdown drain closes diagnostics without a clean-exit marker", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-diagnostics-failed-"));
  try {
    const backend = createBackend(dataDir);
    await backend.init();
    backend.diagnostics.health.start();
    const close = spyOn(backend.diagnostics, "close");
    const drain = spyOn(backend["runtime"].localServers, "shutdown").mockRejectedValue(
      new Error("fixture drain failure"),
    );
    await expect(backend.shutdown()).rejects.toThrow("fixture drain failure");
    expect(close).toHaveBeenCalledWith({ clean: false });
    drain.mockRestore();
    close.mockRestore();
    const database = openBackendDatabase(dataDir);
    try {
      expect(readHealthRows(database).map((row) => row.kind)).toEqual(["started"]);
    } finally {
      database.close();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);

test("shutdown waits for the WAL worker and scrubs the deleted frames before marking a clean exit", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-checkpoint-drain-"));
  const backend = createBackend(dataDir);
  await backend.init();
  backend.diagnostics.health.start();

  const workers: BackgroundCheckpointer[] = [];
  const start = BackgroundCheckpointer.start;
  const startSpy = spyOn(BackgroundCheckpointer, "start").mockImplementation((file, options) => {
    const worker = start(file, { ...options, intervalMs: 10 });
    if (worker) workers.push(worker);
    return worker;
  });
  const checkpoint = Promise.withResolvers<void>();
  const close = Promise.withResolvers<void>();
  const held: Array<() => void> = [];
  const postMessage = Worker.prototype.postMessage;
  // Hold the in-flight checkpoint and its following close at the transport
  // boundary so the test controls their ordering without timing disk I/O.
  const post = spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    message: { type: string },
  ) {
    if (message.type === "checkpoint" || message.type === "close") {
      held.push(() => postMessage.call(this, message));
      if (message.type === "checkpoint") checkpoint.resolve();
      else close.resolve();
    } else {
      postMessage.call(this, message);
    }
  });
  const release = () => {
    post.mockRestore();
    for (const send of held.splice(0)) send();
  };
  const writer = openBackendDatabase(dataDir, { backgroundCheckpoint: true });
  const reader = new Database(writer.path);
  const observer = openBackendDatabase(dataDir);
  let shutdown: Promise<void> | undefined;
  try {
    const marker = "WAL-SCRUB-DELETED-FIXTURE";
    writer.writeStore("fixture", { marker });
    reader.exec("BEGIN");
    reader.query("SELECT revision FROM stores WHERE name = 'fixture'").get();
    writer.writeStore("fixture", {});
    writer.scrubDeletedContent();
    expect(writer.hasDeferredScrub()).toBe(true);
    const wal = Bun.file(`${writer.path}-wal`);
    expect(Buffer.from(await wal.arrayBuffer()).includes(marker)).toBe(true);

    await checkpoint.promise;
    shutdown = backend.shutdown();
    await close.promise;
    reader.exec("ROLLBACK");
    expect(writer.hasDeferredScrub()).toBe(true);
    expect(readHealthRows(observer).map((row) => row.kind)).toEqual(["started"]);
    // Let all later worker messages through, including test cleanup.
    release();
    await shutdown;

    expect(writer.hasDeferredScrub()).toBe(false);
    expect((await wal.exists()) && Buffer.from(await wal.arrayBuffer()).includes(marker)).toBe(
      false,
    );
    expect(readHealthRows(observer).map((row) => row.kind)).toEqual(["started", "clean-exit"]);
  } finally {
    reader.close();
    release();
    await (shutdown ?? backend.shutdown()).catch(() => undefined);
    writer.close();
    observer.close();
    await Promise.all(workers.map((worker) => worker.exited));
    startSpy.mockRestore();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);

test("a blocked WAL privacy scrub fails shutdown without marking a clean exit", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-checkpoint-blocked-"));
  const backend = createBackend(dataDir);
  await backend.init();
  backend.diagnostics.health.start();
  const writer = openBackendDatabase(dataDir, { backgroundCheckpoint: true });
  const reader = new Database(writer.path);
  try {
    writer.writeStore("fixture", { marker: "blocked WAL scrub" });
    reader.exec("BEGIN");
    reader.query("SELECT revision FROM stores WHERE name = 'fixture'").get();
    writer.writeStore("fixture", {});
    writer.scrubDeletedContent();
    expect(writer.hasDeferredScrub()).toBe(true);

    await expect(backend.shutdown()).rejects.toThrow("Storage WAL privacy scrub is incomplete");
    expect(readHealthRows(writer).map((row) => row.kind)).toEqual(["started"]);
  } finally {
    reader.close();
    writer.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);

test("a rejecting Control MCP stop and a throwing earlier stop still close diagnostics and storage", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-diagnostics-close-"));
  const logs = captureLogs();
  try {
    const backend = createBackend(dataDir);
    await backend.init();
    backend.diagnostics.health.start();
    // A synchronous stop before the drain, then an awaited close after it.
    spyOn(backend["machineLoad"], "stop").mockImplementation(() => {
      throw new Error("fixture sampler failure");
    });
    spyOn(backend["controlMcp"], "stop").mockRejectedValue(new Error("fixture control failure"));
    const agentToolsStop = spyOn(backend["agentTools"], "stop");
    const diagnosticsClose = spyOn(backend.diagnostics, "close");
    const storageClose = spyOn(backend["context"].storage, "close");

    // The drain succeeded, so the first failed close fails the attempt.
    await expect(backend.shutdown()).rejects.toThrow("fixture control failure");
    expect(agentToolsStop).toHaveBeenCalledTimes(1);
    expect(diagnosticsClose).toHaveBeenCalledWith({ clean: true });
    expect(storageClose).toHaveBeenCalledTimes(1);
    expect(
      logs
        .records()
        .filter((record) => record.event === "shutdown.step-failed")
        .map((record) => record.fields?.step),
    ).toEqual(["machine-load", "control-mcp"]);
    const database = openBackendDatabase(dataDir);
    try {
      expect(readHealthRows(database).map((row) => row.kind)).toEqual(["started", "clean-exit"]);
    } finally {
      database.close();
    }
  } finally {
    logs.restore();
    mock.restore();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);

test("shutdown clears the web annotation close cap once close settles", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-annotation-cap-"));
  const capTimers: unknown[] = [];
  const cleared = new Set<unknown>();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  try {
    const backend = createBackend(dataDir);
    await backend.init();
    const annotationsClose = spyOn(backend["webAnnotations"], "close");
    spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const timer = realSetTimeout(handler, ms, ...args);
      if (ms === 5_000) capTimers.push(timer);
      return timer;
    }) as typeof setTimeout);
    spyOn(globalThis, "clearTimeout").mockImplementation(((timer?: unknown) => {
      cleared.add(timer);
      realClearTimeout(timer as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout);

    await backend.shutdown();

    expect(annotationsClose).toHaveBeenCalledTimes(1);
    expect(capTimers.length).toBeGreaterThan(0);
    // The former `Promise.race` left its 5 s timer pending after every shutdown.
    expect(capTimers.filter((timer) => !cleared.has(timer))).toEqual([]);
  } finally {
    mock.restore();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);
