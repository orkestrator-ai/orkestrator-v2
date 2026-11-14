import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import type { AgentMailNotice } from "@orkestrator/protocol/agent-mail";
import { AgentMailService } from "./agent-mail-service.js";
import { fixture } from "./agent-mail-service-test-support.js";
import { RIDE_ALONG_MAX_AGE_MS } from "./storage-agent-mail-injects.js";
import type { StorageService } from "./storage.js";

const SWITCH_NOTICE: AgentMailNotice = {
  resource: { kind: "account-switch", id: "claude", label: "mini" },
  accountSwitch: { provider: "Claude Code", from: "a@example.com", to: "b@example.com" },
  state: "account-switched",
  tone: "info",
};

const WORKFLOW = {
  kind: "system" as const,
  projectId: "project",
  source: "workflow" as const,
  resourceId: "account-auto-switch:claude",
};

function riderTo(storage: StorageService, requestId: string) {
  return storage.sendAgentMail(
    WORKFLOW,
    {
      requestId,
      toEnvironmentId: "recipient",
      toTabId: "agent",
      subject: "Claude Code moved to b@example.com on mini",
      body: "Automatic account switching moved Claude Code.",
    },
    { notice: SWITCH_NOTICE, rideAlong: true },
  );
}

function service(storage: StorageService, prompts: string[]) {
  return new AgentMailService(
    storage,
    {
      reconcileMailInject: async () => "unknown",
      sessionActivitySnapshot: () => "idle",
      mailInjectPresence: async () => "idle",
      dispatchMailInject: async (input) => {
        prompts.push(input.prompt);
        return { outcome: "accepted", requestId: input.requestId };
      },
    },
    { dispatchMailInject: async () => ({ outcome: "accepted" }) },
  );
}

describe("a notice that rides along", () => {
  test("never starts a turn of its own", async () => {
    const { storage, dataDir } = await fixture();
    const prompts: string[] = [];
    const mail = service(storage, prompts);
    try {
      const rider = await riderTo(storage, "rider-alone");
      expect(rider.placement).toBe("pending-inject");
      await mail.init();
      await mail.drainInjects();
      expect(prompts).toEqual([]);
      expect(await storage.getAgentMailMessage("recipient", "agent", rider.id)).toMatchObject({
        placement: "pending-inject",
      });
      // Not listed for a caller that does not ask for riders, so nothing else
      // can claim it as a wake.
      expect(await storage.listPendingAgentMailInjects()).toEqual([]);
      expect(
        await storage.listPendingAgentMailInjects(100, { includeCoalescing: true }),
      ).toHaveLength(1);
    } finally {
      await mail.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("is delivered inside the batch another message starts, in one turn", async () => {
    const { storage, dataDir } = await fixture();
    const prompts: string[] = [];
    const mail = service(storage, prompts);
    try {
      const rider = await riderTo(storage, "rider-first");
      const message = await storage.sendAgentMail(
        { kind: "tab", environmentId: "sender", projectId: "project", tabId: "agent" },
        {
          requestId: "starts-the-turn",
          toEnvironmentId: "recipient",
          toTabId: "agent",
          body: "A worker finished.",
        },
      );
      await mail.init();
      await mail.drainInjects();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("account-switch");
      expect(prompts[0]).toContain("A worker finished.");
      for (const id of [rider.id, message.id]) {
        expect(await storage.getAgentMailMessage("recipient", "agent", id)).toMatchObject({
          placement: "injected",
        });
      }
    } finally {
      await mail.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("lapses after a day instead of waking anyone or piling up", async () => {
    const { storage, dataDir } = await fixture();
    const prompts: string[] = [];
    const mail = service(storage, prompts);
    const realNow = Date.now;
    try {
      const rider = await riderTo(storage, "rider-stale");
      Date.now = () => realNow() + RIDE_ALONG_MAX_AGE_MS + 60_000;
      expect(
        await storage.listPendingAgentMailInjects(100, { includeCoalescing: true }),
      ).toHaveLength(0);
      // The next rider sweeps the stale one out of the queue.
      await riderTo(storage, "rider-fresh");
      expect(await storage.getAgentMailMessage("recipient", "agent", rider.id)).toMatchObject({
        placement: "expired",
      });
      await mail.init();
      await mail.drainInjects();
      expect(prompts).toEqual([]);
    } finally {
      Date.now = realNow;
      await mail.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
