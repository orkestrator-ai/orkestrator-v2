/**
 * `appendNativeAgentTurnOutcome` writes from outside the backend, the way the
 * live coordinator suite's `account-switch` case seeds a usage-limited tab in
 * a running profile. A running `StorageService` must see the outcome, and the
 * usage-limit reader must list the tab, without a restart.
 */
import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readProjectUsageLimits } from "./agent-usage-limits.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { createEnvironment, StorageService } from "./storage.js";
import { appendNativeAgentTurnOutcome } from "./storage-test-support.js";

const directories: string[] = [];
const services: StorageService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

test("a seeded usage-limit outcome reaches a running backend's usage-limit reader", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-seeded-turn-outcome-"));
  directories.push(dataDir);
  const storage = new StorageService(dataDir);
  services.push(storage);
  await storage.init();
  const environment = await storage.addEnvironment({
    ...createEnvironment("project-1"),
    name: "Limited worker",
  });
  const identity = {
    environmentId: environment.id,
    agent: "claude" as const,
    logicalSessionKey: `env-${environment.id}:startup-agent`,
  };
  await storage.getOrCreateNativeAgentSession(
    {
      key: nativeAgentSessionStorageKey(
        identity.environmentId,
        identity.agent,
        identity.logicalSessionKey,
      ),
      ...identity,
    },
    async () => "provider-session",
  );
  const sources = { storage, planUsage: () => undefined };
  expect((await readProjectUsageLimits(sources, "project-1")).limitedTabs).toEqual([]);

  expect(
    appendNativeAgentTurnOutcome(dataDir, identity, {
      requestId: "seeded",
      outcome: "failed",
      error: "You've hit your usage limit.",
      failureKind: "usage-limit",
      observedAt: "2026-11-13T10:00:00.000Z",
    }),
  ).toBe(true);

  const limits = await readProjectUsageLimits(sources, "project-1");
  expect(limits.limitedTabs).toEqual([
    expect.objectContaining({
      environmentId: environment.id,
      tabId: "startup-agent",
      agent: "claude",
      signal: "provider",
    }),
  ]);
});

test("a session that does not exist is reported, not created", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-seeded-turn-outcome-"));
  directories.push(dataDir);
  const storage = new StorageService(dataDir);
  services.push(storage);
  await storage.init();
  expect(
    appendNativeAgentTurnOutcome(
      dataDir,
      { environmentId: "missing", agent: "codex", logicalSessionKey: "env-missing:tab" },
      {
        requestId: "seeded",
        outcome: "failed",
        error: "limit",
        observedAt: "2026-11-13T10:00:00.000Z",
      },
    ),
  ).toBe(false);
  expect(await storage.listNativeAgentSessions()).toEqual([]);
});
