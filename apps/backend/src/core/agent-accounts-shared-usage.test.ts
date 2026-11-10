import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentAccountSharedUsage } from "./agent-accounts-shared-usage.js";
import type { SharedUsageReading } from "@orkestrator/protocol/agent-account-shared-usage";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const dir = await mkdtemp(path.join(tmpdir(), "ork-shared-store-"));
  roots.push(dir);
  return dir;
}
const now = Date.now();
function reading(minutesAgo: number, percent: number): SharedUsageReading {
  return {
    identity: { platform: "codex", email: "login@example.com", organizationId: "org" },
    fetchedAt: new Date(now - minutesAgo * 60_000).toISOString(),
    source: { nodeId: "bk_reader", nodeName: "reader" },
    windows: [{ window: "primary", usedPercent: percent }],
  };
}

test("concurrent newest-wins writes survive a new runtime while the source is offline", async () => {
  const dir = await root();
  const store = new AgentAccountSharedUsage();
  await Promise.all([
    store.record(dir, [reading(3, 10)], now),
    store.record(dir, [reading(1, 90)], now),
    store.record(dir, [reading(2, 40)], now),
  ]);
  const restored = await new AgentAccountSharedUsage().all(dir);
  expect(restored).toEqual([reading(1, 90)]);
  expect(JSON.parse(await readFile(path.join(dir, "shared-usage.json"), "utf8"))).toEqual(restored);
});

test("a failed save keeps memory and retries an unchanged reading after storage recovers", async () => {
  const dir = await root();
  const blocked = path.join(dir, "accounts");
  await writeFile(blocked, "blocked");
  const store = new AgentAccountSharedUsage();
  await store.record(blocked, [reading(1, 90)], now);
  expect(await store.all(blocked)).toEqual([reading(1, 90)]);
  await rm(blocked);
  await mkdir(blocked);
  expect(await store.record(blocked, [reading(1, 90)], now)).toEqual([]);
  expect(await new AgentAccountSharedUsage().all(blocked)).toEqual([reading(1, 90)]);
});
