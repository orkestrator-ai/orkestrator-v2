import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import type { MailboxPresence } from "@orkestrator/protocol/agent-mail";
import {
  COORDINATOR_WORKSPACE_VERSION,
  COORDINATOR_EXECUTION_POLICY,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
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
  test("running native mailboxes still read presence while setup is incomplete", async () => {
    const { storage, dataDir } = await fixture();
    const { service, reads } = presenceService(storage, () => "waiting");
    try {
      await service.init();
      await storage.updateEnvironment("recipient", {
        status: "running",
        setupPhase: "running",
        setupScriptsComplete: false,
      });
      reads.native = 0;
      await service.refreshPresence();
      expect(reads.native).toBe(2);
      expect(await recipientPresence(storage)).toBe("waiting");
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("coordinator mailboxes read their provider without an environment row", async () => {
    const { storage, dataDir } = await fixture();
    const { service, reads } = presenceService(storage, () => "waiting");
    const runtimeId = coordinatorRuntimeId("coordinator-1", "conversation-1");
    const now = new Date().toISOString();
    try {
      await storage.coordinators.mutateCoordinatorWorkspace("project", () => ({
        version: COORDINATOR_WORKSPACE_VERSION,
        id: "coordinator-1",
        projectId: "project",
        executionPolicy: COORDINATOR_EXECUTION_POLICY,
        lifecycleState: "ready",
        conversations: [
          {
            id: "conversation-1",
            tabId: "coordinator-tab",
            logicalSessionKey: `env-${runtimeId}:coordinator-tab`,
            agent: "codex",
            title: "Coordinator",
            createdAt: now,
            mailboxIncarnationId: "coordinator-incarnation-1",
          },
        ],
        selectedConversationId: "conversation-1",
        repositoryContextRevision: 0,
        createdAt: now,
        updatedAt: now,
      }));
      await storage.synchronizeAgentMailboxes();
      await service.init();
      const environment = spyOn(storage, "getEnvironment");
      try {
        reads.native = 0;
        await service.refreshPresence();
        expect(reads.native).toBe(3);
        expect(environment.mock.calls.map(([id]) => id)).not.toContain(runtimeId);
        expect(
          (await storage.getAgentMailMailbox(runtimeId, "coordinator-tab")).descriptor.presence,
        ).toBe("waiting");
      } finally {
        environment.mockRestore();
      }
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

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

  test("one config read and one environment read a pass, handed to each gate (todo 7567 task 2)", async () => {
    const { storage, dataDir } = await fixture();
    const known: Array<{ environmentId: string; environment: unknown }> = [];
    const service = new AgentMailService(
      storage,
      {
        reconcileMailInject: async () => "unknown",
        sessionActivitySnapshot: () => "idle",
        mailInjectPresence: async (input, given = {}) => {
          known.push({ environmentId: input.environmentId, environment: given.environment });
          return "idle";
        },
        dispatchMailInject: async (input) => ({ outcome: "accepted", requestId: input.requestId }),
      },
      { dispatchMailInject: async () => ({ outcome: "accepted" }) },
    );
    const loadConfig = spyOn(storage, "loadConfig");
    const listMailboxes = spyOn(storage, "listAgentMailboxes");
    const getEnvironment = spyOn(storage, "getEnvironment");
    try {
      await service.init();
      loadConfig.mockClear();
      listMailboxes.mockClear();
      getEnvironment.mockClear();
      known.length = 0;
      await service.refreshPresence();
      // The listing reuses the pass's config: one revision check, not two.
      expect(loadConfig).toHaveBeenCalledTimes(1);
      expect(listMailboxes.mock.calls.every(([options]) => options?.config !== undefined)).toBe(
        true,
      );
      // Each gate takes the row the pass read rather than reading it again.
      expect(getEnvironment.mock.calls.map(([id]) => id).sort()).toEqual(["recipient", "sender"]);
      expect(known.map((entry) => entry.environmentId).sort()).toEqual(["recipient", "sender"]);
      for (const entry of known) {
        expect((entry.environment as { id?: string } | undefined)?.id).toBe(entry.environmentId);
      }
    } finally {
      loadConfig.mockRestore();
      listMailboxes.mockRestore();
      getEnvironment.mockRestore();
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a tmux delivery hands the presence it read to its dispatch, and none when it read none", async () => {
    const { storage, dataDir } = await fixture();
    try {
      await replaceRecipientTab(storage, "claude-tmux");
      const deliver = async (withPresence: boolean, requestId: string) => {
        await storage.sendAgentMail(
          { kind: "tab", environmentId: "sender", projectId: "project", tabId: "agent" },
          { requestId, toEnvironmentId: "recipient", toTabId: "agent", body: requestId },
        );
        const dispatches: Array<Record<string, unknown>> = [];
        const service = new AgentMailService(
          storage,
          {
            reconcileMailInject: async () => "unknown",
            sessionActivitySnapshot: () => "unknown",
            dispatchMailInject: async (input) => ({
              outcome: "accepted",
              requestId: input.requestId,
            }),
          },
          {
            ...(withPresence ? { mailInjectPresence: async () => "idle" as const } : {}),
            dispatchMailInject: async (input) => {
              dispatches.push(input);
              return { outcome: "accepted" };
            },
          },
        );
        try {
          await service.init();
          await service.drainInjects();
        } finally {
          await service.shutdown();
        }
        return dispatches;
      };
      // The dispatch skips the reads the presence gate has just made (BG-15).
      const read = await deliver(true, "with-presence");
      expect(read).toHaveLength(1);
      expect(read[0]).toMatchObject({ presence: "idle" });
      // No presence gate: the dispatch must make those reads itself.
      const unread = await deliver(false, "without-presence");
      expect(unread).toHaveLength(1);
      expect(unread[0]).not.toHaveProperty("presence");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
