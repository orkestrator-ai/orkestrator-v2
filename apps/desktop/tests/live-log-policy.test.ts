import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, resetLogger } from "@orkestrator/protocol/logger";
import { installProductionApplicationLogging } from "../electron/application-logging";
import { logPolicyChangedRecord } from "@orkestrator/protocol/node/log-policy";
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";
import { createLiveLogPolicy } from "../electron/live-log-policy";
import { relayBackendLine } from "../electron/backend-process";

const dirs: string[] = [];
afterEach(async () => {
  resetLogger();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), "desktop-live-policy-"));
  dirs.push(dataDir);
  const save = (enabled: boolean, level = "info") =>
    writeFile(
      join(dataDir, "config.json"),
      JSON.stringify({ global: { debugLogging: enabled, logDetail: { level, areaLevels: {} } } }),
    );
  await save(false);
  const logging = installProductionApplicationLogging({ dataDir });
  const timers = new Map<() => void, number>();
  const handler = createLiveLogPolicy({
    dataDir,
    logging,
    env: {},
    schedule: (callback, delay) => {
      timers.set(callback, delay);
      return () => {
        timers.delete(callback);
      };
    },
  });
  const saved = async () => {
    await logging.flush();
    const files = await readdir(logging.logDirectory);
    return (
      await Promise.all(files.map((file) => readFile(join(logging.logDirectory, file), "utf8")))
    ).join("");
  };
  return { dataDir, save, logging, handler, saved, timers };
}

function audit(enabled: boolean) {
  return JSON.stringify(
    logPolicyChangedRecord({
      saving: { enabled, retentionDays: 7 },
      detail: { level: "info", areaLevels: {} },
    }),
  );
}

test("the real relay re-reads changed config and saves both on/off audit lines with the installed writer", async () => {
  const h = await harness();
  try {
    await h.save(true, "debug");
    relayBackendLine("stdout", audit(true), h.handler.apply);
    expect(h.logging.settings().enabled).toBe(true);
    expect(createLogger("updater").isEnabled("debug")).toBe(true);
    await h.save(false, "info");
    relayBackendLine("stdout", audit(false), h.handler.apply);
    expect(h.logging.settings().enabled).toBe(false);
    expect(createLogger("updater").isEnabled("debug")).toBe(false);
    const lines = await h.saved();
    expect(lines.match(/policy.changed/g)).toHaveLength(2);
    expect(lines.indexOf("capture.started")).toBeLessThan(lines.indexOf("policy.changed"));
    expect(lines.lastIndexOf("policy.changed")).toBeLessThan(lines.indexOf("capture.stopped"));
  } finally {
    h.handler.dispose();
    await h.logging.stop();
  }
});

test("config events debounce a delayed re-read, ignore other resources, and cancel on disposal", async () => {
  const h = await harness();
  try {
    await h.save(true, "debug");
    h.handler.onEvent(RESOURCE_CHANGED_EVENT, { resource: "environments" });
    expect(h.timers.size).toBe(0);
    h.handler.onEvent(RESOURCE_CHANGED_EVENT, { resource: "config" });
    h.handler.onEvent(RESOURCE_CHANGED_EVENT, { resource: "config" });
    expect(h.timers.size).toBe(1);
    expect(h.logging.settings().enabled).toBe(false);
    const [callback, delay] = Array.from(h.timers)[0]!;
    expect(delay).toBe(2000);
    h.timers.delete(callback);
    callback();
    expect(h.logging.settings().enabled).toBe(true);
    expect(createLogger("updater").isEnabled("debug")).toBe(true);
    h.handler.onEvent(RESOURCE_CHANGED_EVENT, { resource: "config" });
    h.handler.dispose();
    expect(h.timers.size).toBe(0);
  } finally {
    h.handler.dispose();
    await h.logging.stop();
  }
});

test("an unreadable config keeps the current writer and levels while retaining the relay audit", async () => {
  const h = await harness();
  try {
    await h.save(true, "debug");
    h.handler.apply();
    await writeFile(join(h.dataDir, "config.json"), "{ torn");
    relayBackendLine("stdout", audit(false), h.handler.apply);
    expect(h.logging.settings().enabled).toBe(true);
    expect(createLogger("updater").isEnabled("debug")).toBe(true);
    expect(await h.saved()).toContain("policy.changed");
  } finally {
    h.handler.dispose();
    await h.logging.stop();
  }
});
