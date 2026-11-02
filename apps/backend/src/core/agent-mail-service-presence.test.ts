import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import type { MailboxPresence } from "@orkestrator/protocol/agent-mail";
import { AgentMailService } from "./agent-mail-service.js";
import { fixture, replaceRecipientTab } from "./agent-mail-service-test-support.js";
import type { StorageService } from "./storage.js";

/**
 * A presence refresh skips the per-mailbox reads of an environment that is not
 * running, and records the presence those reads would have answered.
 */
function presenceService(storage: StorageService, presence: () => MailboxPresence) {
  const reads = { native: 0, tmux: 0 };
  const service = new AgentMailService(
    storage,
    {
      reconcileMailInject: async () => "unknown",
      sessionActivitySnapshot: () => "idle",
      mailInjectPresence: async () => {
        reads.native += 1;
        return presence();
      },
      dispatchMailInject: async (input) => ({ outcome: "accepted", requestId: input.requestId }),
    },
    {
      mailInjectPresence: async () => {
        reads.tmux += 1;
        return presence() as "idle";
      },
      dispatchMailInject: async () => ({ outcome: "accepted" }),
    },
  );
  return { service, reads };
}

async function recipientPresence(storage: StorageService) {
  return (await storage.getAgentMailMailbox("recipient", "agent")).descriptor.presence;
}

describe("mail presence for environments that are not running", () => {
  test("a stopped environment's native mailbox reads nothing and is environment_stopped", async () => {
    const { storage, dataDir } = await fixture();
    const { service, reads } = presenceService(storage, () => "idle");
    try {
      await service.init();
      reads.native = 0;
      await service.refreshPresence();
      expect(reads.native).toBe(2);
      expect(await recipientPresence(storage)).toBe("idle");

      await storage.updateEnvironment("recipient", { status: "stopped" });
      reads.native = 0;
      await service.refreshPresence();
      // Only the running sender's mailbox was read.
      expect(reads.native).toBe(1);
      expect(await recipientPresence(storage)).toBe("environment_stopped");

      // Running again: the mailbox is read again on the next pass.
      await storage.updateEnvironment("recipient", { status: "running" });
      reads.native = 0;
      await service.refreshPresence();
      expect(reads.native).toBe(2);
      expect(await recipientPresence(storage)).toBe("idle");
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("an environment being deleted is skipped like a stopped one", async () => {
    const { storage, dataDir } = await fixture();
    const { service, reads } = presenceService(storage, () => "idle");
    try {
      await service.init();
      await storage.updateEnvironment("recipient", {
        deletionRequestedAt: new Date().toISOString(),
      });
      reads.native = 0;
      await service.refreshPresence();
      expect(reads.native).toBe(1);
      expect(await recipientPresence(storage)).toBe("environment_stopped");
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a stopped or still-preparing environment's tmux mailbox reads nothing and is environment_unready", async () => {
    const { storage, dataDir } = await fixture();
    const { service, reads } = presenceService(storage, () => "idle");
    try {
      await replaceRecipientTab(storage, "claude-tmux");
      await service.init();
      await storage.updateEnvironment("recipient", { status: "stopped" });
      reads.tmux = 0;
      await service.refreshPresence();
      expect(reads.tmux).toBe(0);
      expect(await recipientPresence(storage)).toBe("environment_unready");

      // Running but setup not settled is what the tmux read answers unready too.
      await storage.updateEnvironment("recipient", {
        status: "running",
        setupPhase: "running",
        setupScriptsComplete: false,
      });
      await service.refreshPresence();
      expect(reads.tmux).toBe(0);
      expect(await recipientPresence(storage)).toBe("environment_unready");

      await storage.updateEnvironment("recipient", {
        setupPhase: "ready",
        setupScriptsComplete: true,
      });
      await service.refreshPresence();
      expect(reads.tmux).toBe(1);
      expect(await recipientPresence(storage)).toBe("idle");
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a change to a stopped presence still resets the inject backoff, as the read did", async () => {
    const { storage, dataDir } = await fixture();
    const { service } = presenceService(storage, () => "idle");
    const reset = spyOn(storage, "resetAgentMailInjectBackoff");
    try {
      await service.init();
      await service.refreshPresence();
      reset.mockClear();
      await storage.updateEnvironment("recipient", { status: "stopped" });
      await service.refreshPresence();
      expect(reset).toHaveBeenCalledTimes(1);
      await service.refreshPresence();
      expect(reset).toHaveBeenCalledTimes(1);
    } finally {
      reset.mockRestore();
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("reads each environment once per pass, and an unreadable one falls back to the mailbox read", async () => {
    const { storage, dataDir } = await fixture();
    const { service, reads } = presenceService(storage, () => "idle");
    const getEnvironment = spyOn(storage, "getEnvironment");
    try {
      await service.init();
      getEnvironment.mockClear();
      await service.refreshPresence();
      expect(getEnvironment.mock.calls.map(([id]) => id).sort()).toEqual(["recipient", "sender"]);

      getEnvironment.mockImplementation(async () => {
        throw new Error("unreadable row");
      });
      reads.native = 0;
      await service.refreshPresence();
      // No shortcut on an error: each mailbox reads (and handles it) itself.
      expect(reads.native).toBe(2);
    } finally {
      getEnvironment.mockRestore();
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
