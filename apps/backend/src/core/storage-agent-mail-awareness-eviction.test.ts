import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import {
  AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX,
  agentMailboxId,
} from "@orkestrator/protocol/agent-mail";
import { fixture } from "./agent-mail-service-test-support.js";
import { readStoredValue } from "./storage-test-support.js";
import type { PersistedAgentMailStore } from "./storage-agent-mail-store.js";
import type { StorageService } from "./storage.js";

const mailboxId = agentMailboxId("recipient", "agent");

function awareness(storage: StorageService, requestId: string) {
  return storage.sendAgentMail(
    {
      kind: "system",
      projectId: "project",
      source: "workflow",
      resourceId: `account-auto-switch:${requestId}`,
    },
    { requestId, toEnvironmentId: "recipient", toTabId: "agent", body: "Account changed" },
    { rideAlong: true },
  );
}

function work(storage: StorageService, requestId: string) {
  return storage.sendAgentMail(
    { kind: "user" },
    {
      requestId,
      toEnvironmentId: "recipient",
      toTabId: "agent",
      body: "Please review this report",
    },
  );
}

function persisted(dataDir: string) {
  return readStoredValue<PersistedAgentMailStore>(dataDir, "agent-mail.json")!;
}

async function fill(storage: StorageService, count: number) {
  for (let index = 0; index < count; index++) await awareness(storage, `fill-${index}`);
}

describe("full-mailbox awareness eviction", () => {
  test("evicts pending awareness and removes only its pendingInject entry", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const oldest = await awareness(storage, "oldest");
      const retained = await awareness(storage, "retained");
      await fill(storage, AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX - 2);
      const before = persisted(dataDir);
      expect(before.pendingInject.some((entry) => entry.messageId === oldest.id)).toBe(true);
      const admitted = await work(storage, "new-work");
      const after = persisted(dataDir);
      expect(after.mailboxes[mailboxId]!.messages).toHaveLength(
        AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX,
      );
      expect(after.mailboxes[mailboxId]!.messages.some((message) => message.id === oldest.id)).toBe(
        false,
      );
      expect(after.pendingInject.some((entry) => entry.messageId === oldest.id)).toBe(false);
      expect(after.pendingInject.find((entry) => entry.messageId === retained.id)).toEqual(
        before.pendingInject.find((entry) => entry.messageId === retained.id),
      );
      expect(after.pendingInject.some((entry) => entry.messageId === admitted.id)).toBe(true);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test.each(["verifying", "user-released", "submitting"] as const)(
    "preserves %s awareness, evicting the next eligible notice instead",
    async (state) => {
      const { storage, dataDir } = await fixture();
      try {
        const protectedNotice = await awareness(storage, "protected");
        if (state === "user-released") {
          await storage.retryAgentMailInject("recipient", "agent", protectedNotice.id);
        } else {
          const descriptor = (await storage.getAgentMailMailbox("recipient", "agent")).descriptor;
          expect(
            await storage.beginAgentMailInject(
              mailboxId,
              protectedNotice.id,
              descriptor.incarnationId,
              undefined,
              { joinCoalescing: true },
            ),
          ).not.toBeNull();
          if (state === "verifying") {
            await storage.finishAgentMailInject(mailboxId, protectedNotice.id, {
              outcome: "verify",
              requestId: "unconfirmed-dispatch",
            });
          }
        }
        const evictable = await awareness(storage, "evictable");
        await fill(storage, AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX - 2);
        const before = persisted(dataDir);
        const originalMessage = before.mailboxes[mailboxId]!.messages.find(
          (message) => message.id === protectedNotice.id,
        )!;
        const originalEntry = before.pendingInject.find(
          (entry) => entry.messageId === protectedNotice.id,
        )!;
        if (state === "verifying")
          expect(originalEntry.verifyRequestId).toBe("unconfirmed-dispatch");
        if (state === "user-released") expect(originalMessage.userReleasedAt).toBeString();
        if (state === "submitting")
          expect(originalMessage).toMatchObject({
            placement: "inject-held",
            placementReason: "submitting",
          });
        await work(storage, "new-work");
        const after = persisted(dataDir);
        expect(after.mailboxes[mailboxId]!.messages).toHaveLength(
          AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX,
        );
        expect(
          after.mailboxes[mailboxId]!.messages.find((message) => message.id === protectedNotice.id),
        ).toEqual(originalMessage);
        expect(after.pendingInject.find((entry) => entry.messageId === protectedNotice.id)).toEqual(
          originalEntry,
        );
        expect(
          after.mailboxes[mailboxId]!.messages.some((message) => message.id === evictable.id),
        ).toBe(false);
        expect(after.pendingInject.some((entry) => entry.messageId === evictable.id)).toBe(false);
      } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  test("refuses admission when every message is actionable and leaves the mailbox intact", async () => {
    const { storage, dataDir } = await fixture();
    try {
      for (let index = 0; index < AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX; index++) {
        await work(storage, `work-${index}`);
      }
      const before = persisted(dataDir);
      await expect(work(storage, "overflow")).rejects.toMatchObject({
        code: "mailbox-backlog-full",
      });
      const after = persisted(dataDir);
      expect(after.mailboxes[mailboxId]).toEqual(before.mailboxes[mailboxId]);
      expect(after.pendingInject).toEqual(before.pendingInject);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
