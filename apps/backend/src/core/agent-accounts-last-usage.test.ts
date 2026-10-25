import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import {
  forgetAgentAccountUsage,
  rememberAgentAccountUsage,
  resetAgentAccountLastUsageForTests,
  withLastKnownUsage,
} from "./agent-accounts-last-usage.js";

let root: string;
const reading: PlanUsageSnapshot = {
  platform: "claude",
  status: "ok",
  plan: "max",
  windows: [{ window: "five_hour", usedPercent: 42 }],
  fetchedAt: "2026-10-01T00:00:00.000Z",
};
const failure: PlanUsageSnapshot = {
  platform: "claude",
  status: "error",
  windows: [],
  message: "HTTP 429",
  fetchedAt: "2026-10-02T00:00:00.000Z",
};
const now = Date.parse(failure.fetchedAt);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "ork-last-usage-"));
  resetAgentAccountLastUsageForTests();
});
afterEach(async () => {
  resetAgentAccountLastUsageForTests();
  await fs.rm(root, { recursive: true, force: true });
});

for (const contents of [
  "{broken",
  "null",
  "[]",
  "42",
  '"text"',
  '{"claude:account":{"status":"ok"}}',
]) {
  test(`ignores malformed persisted usage: ${contents}`, async () => {
    await fs.writeFile(path.join(root, "last-usage.json"), contents);
    expect(await withLastKnownUsage(root, "claude", "account", failure, now)).toBe(failure);
    await rememberAgentAccountUsage(root, "claude", "account", reading);
    resetAgentAccountLastUsageForTests();
    expect(await withLastKnownUsage(root, "claude", "account", failure, now)).toMatchObject({
      stale: true,
      plan: "max",
      windows: reading.windows,
    });
  });
}

test("rehydrates from disk and preserves quotas, timestamp and failure explanation", async () => {
  await rememberAgentAccountUsage(root, "claude", "account", reading);
  resetAgentAccountLastUsageForTests();
  expect(await withLastKnownUsage(root, "claude", "account", failure, now)).toEqual({
    ...reading,
    stale: true,
    message: "HTTP 429",
  });
  await forgetAgentAccountUsage(root, "claude", "account");
  resetAgentAccountLastUsageForTests();
  expect(await withLastKnownUsage(root, "claude", "account", failure, now)).toBe(failure);
});

test("deduplicates fetchedAt and never persists errors or stale fallbacks", async () => {
  await rememberAgentAccountUsage(root, "claude", "account", reading);
  const write = spyOn(fs, "writeFile");
  try {
    await rememberAgentAccountUsage(root, "claude", "account", {
      ...reading,
      plan: "older",
      fetchedAt: new Date(0).toISOString(),
    });
    await rememberAgentAccountUsage(root, "claude", "account", { ...reading, plan: "duplicate" });
    await rememberAgentAccountUsage(root, "claude", "account", failure);
    await rememberAgentAccountUsage(root, "claude", "account", {
      ...reading,
      stale: true,
      fetchedAt: failure.fetchedAt,
    });
    expect(write).not.toHaveBeenCalled();
  } finally {
    write.mockRestore();
  }
  resetAgentAccountLastUsageForTests();
  expect((await withLastKnownUsage(root, "claude", "account", failure, now)).plan).toBe("max");
});

test("swallows a write failure and retries the same reading on the next save", async () => {
  const original = fs.writeFile.bind(fs);
  const write = spyOn(fs, "writeFile").mockImplementationOnce(async () => {
    throw new Error("disk unavailable");
  });
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await expect(
      rememberAgentAccountUsage(root, "claude", "account", reading),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(root)).toEqual([]);
    write.mockImplementation(original);
    await rememberAgentAccountUsage(root, "claude", "account", reading);
  } finally {
    write.mockRestore();
    warn.mockRestore();
  }
  resetAgentAccountLastUsageForTests();
  expect((await withLastKnownUsage(root, "claude", "account", failure, now)).windows).toEqual(
    reading.windows,
  );
});

test("a failed deletion write is retried even when the in-memory entry is already gone", async () => {
  await rememberAgentAccountUsage(root, "claude", "account", reading);
  const write = spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk unavailable"));
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await forgetAgentAccountUsage(root, "claude", "account");
  } finally {
    write.mockRestore();
    warn.mockRestore();
  }
  await forgetAgentAccountUsage(root, "claude", "account");
  expect(await fs.readdir(root)).toEqual(["last-usage.json"]);
  resetAgentAccountLastUsageForTests();
  expect(await withLastKnownUsage(root, "claude", "account", failure, now)).toBe(failure);
});
