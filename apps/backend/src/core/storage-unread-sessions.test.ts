import { describe, expect, test } from "bun:test";
import { createEnvironment } from "./storage.js";
import { withTemporaryStorage } from "./storage-test-support.js";

const SESSION_A = "env-1:tab-a";
const SESSION_B = "env-1:tab-b";

function at(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("unread work attributed to agent sessions", () => {
  test("a session's result is acknowledged only by acknowledging that session", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const completed = await storage.recordEnvironmentSessionCompletion(
        environment.id,
        at(1_000),
        "agent_finished",
        undefined,
        SESSION_A,
      );
      expect(completed).toMatchObject({ hasUnreadWork: true, unreadSessionKeys: [SESSION_A] });
      const token = completed.lastActivityAt!;

      // Showing another tab of the environment does not consume the badge.
      const other = await storage.setEnvironmentUnread(environment.id, false, token, [SESSION_B]);
      expect(other).toMatchObject({ hasUnreadWork: true, unreadSessionKeys: [SESSION_A] });

      const legacyAutomaticClear = await storage.setEnvironmentUnread(environment.id, false, token);
      expect(legacyAutomaticClear.unreadSessionKeys).toEqual([SESSION_A]);

      const viewed = await storage.setEnvironmentUnread(environment.id, false, token, [SESSION_A]);
      expect(viewed.hasUnreadWork).toBe(false);
      expect(viewed).not.toHaveProperty("unreadSessionKeys");
      expect(viewed).not.toHaveProperty("unreadReason");
      expect((await storage.getEnvironment(environment.id))?.hasUnreadWork).toBe(false);
    });
  });

  test("two sessions' results clear one at a time, and an old view cannot clear a newer result", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const first = await storage.recordEnvironmentSessionCompletion(
        environment.id,
        at(1_000),
        "agent_finished",
        undefined,
        SESSION_A,
      );
      const second = await storage.recordEnvironmentAgentAttention(
        environment.id,
        ["codex:question"],
        at(2_000),
        "agent_question",
        SESSION_B,
      );
      expect(second.environment.unreadSessionKeys).toEqual([SESSION_A, SESSION_B]);

      // Viewed against the first result's token: the newer one is not cleared.
      const stale = await storage.setEnvironmentUnread(
        environment.id,
        false,
        first.lastActivityAt!,
        [SESSION_A, SESSION_B],
      );
      expect(stale.unreadSessionKeys).toEqual([SESSION_A, SESSION_B]);

      const token = second.environment.lastActivityAt!;
      const partly = await storage.setEnvironmentUnread(environment.id, false, token, [SESSION_A]);
      expect(partly).toMatchObject({
        hasUnreadWork: true,
        unreadReason: "agent_question",
        unreadSessionKeys: [SESSION_B],
      });
      const done = await storage.setEnvironmentUnread(environment.id, false, token, [SESSION_B]);
      expect(done.hasUnreadWork).toBe(false);
    });
  });

  for (const terminalFirst of [true, false]) {
    test(`keeps both sources of unread work (terminal first: ${terminalFirst})`, async () => {
      await withTemporaryStorage(async (storage) => {
        const { id } = await storage.addEnvironment(createEnvironment("project-1"));
        const terminal = (offset: number) => storage.recordEnvironmentCompletion(id, at(offset));
        const session = (offset: number) =>
          storage.recordEnvironmentSessionCompletion(
            id,
            at(offset),
            "agent_finished",
            undefined,
            SESSION_A,
          );
        const first = terminalFirst ? terminal : session;
        const second = terminalFirst ? session : terminal;
        await first(1_000);
        const mixed = await second(2_000);
        expect(mixed).toMatchObject({
          unreadEnvironmentReason: "terminal_finished",
          unreadSessionKeys: [SESSION_A],
        });

        const viewedEnvironment = await storage.setEnvironmentUnread(
          id,
          false,
          mixed.lastActivityAt,
          [],
        );
        expect(viewedEnvironment).toMatchObject({
          hasUnreadWork: true,
          unreadSessionKeys: [SESSION_A],
          unreadReason: "agent_finished",
        });
        expect(viewedEnvironment).not.toHaveProperty("unreadEnvironmentReason");
        expect(viewedEnvironment.unreadRevision).toBeGreaterThan(mixed.unreadRevision!);
      });
    });
  }

  test("a question takes priority and clearing it reveals the remaining completion", async () => {
    await withTemporaryStorage(async (storage) => {
      const { id } = await storage.addEnvironment(createEnvironment("project-1"));
      await storage.recordEnvironmentAgentAttention(
        id,
        ["q"],
        at(1_000),
        "agent_question",
        SESSION_B,
      );
      const mixed = await storage.recordEnvironmentSessionCompletion(
        id,
        at(2_000),
        "agent_finished",
        undefined,
        SESSION_A,
      );
      expect(mixed.unreadReason).toBe("agent_question");
      const remaining = await storage.setEnvironmentUnread(id, false, mixed.lastActivityAt, [
        SESSION_B,
      ]);
      expect(remaining).toMatchObject({
        hasUnreadWork: true,
        unreadReason: "agent_finished",
        unreadSessionKeys: [SESSION_A],
      });
    });
  });

  test("a direct unread write preserves attributed work and a direct clear removes it", async () => {
    await withTemporaryStorage(async (storage) => {
      const { id } = await storage.addEnvironment(createEnvironment("project-1"));
      await storage.recordEnvironmentSessionCompletion(
        id,
        at(1_000),
        "agent_finished",
        undefined,
        SESSION_A,
      );
      const marked = await storage.updateEnvironment(id, { hasUnreadWork: true });
      expect(marked).toMatchObject({
        unreadSessionKeys: [SESSION_A],
        unreadEnvironmentReason: "marked_unread",
      });
      const cleared = await storage.updateEnvironment(id, { hasUnreadWork: false });
      expect(cleared.hasUnreadWork).toBe(false);
      expect(cleared).not.toHaveProperty("unreadSessionKeys");
      expect(cleared).not.toHaveProperty("unreadSessionEntries");
      expect(cleared).not.toHaveProperty("unreadEnvironmentReason");
    });
  });

  test("a clear without session keys acknowledges every session, and marking unread is environment-wide", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      await storage.recordEnvironmentSessionCompletion(
        environment.id,
        at(1_000),
        "agent_finished",
        undefined,
        SESSION_A,
      );
      const cleared = await storage.setEnvironmentUnread(environment.id, false);
      expect(cleared.hasUnreadWork).toBe(false);
      expect(cleared).not.toHaveProperty("unreadSessionKeys");

      const marked = await storage.setEnvironmentUnread(environment.id, true);
      expect(marked).toMatchObject({ hasUnreadWork: true, unreadReason: "marked_unread" });
      expect(marked).not.toHaveProperty("unreadSessionKeys");
    });
  });

  test("overflow retains the tracked sessions and requires an explicit full clear", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      let latest = environment;
      for (let index = 0; index < 33; index += 1) {
        latest = await storage.recordEnvironmentSessionCompletion(
          environment.id,
          at(1_000 + index),
          "agent_finished",
          undefined,
          `env-1:tab-${index}`,
        );
        if (index < 31) expect(latest.unreadSessionKeys).toHaveLength(index + 1);
      }
      expect(latest.hasUnreadWork).toBe(true);
      expect(latest.unreadSessionKeys).toHaveLength(32);
      expect(latest.unreadSessionOverflow).toBe(true);
      const remaining = await storage.setEnvironmentUnread(
        environment.id,
        false,
        latest.lastActivityAt,
        latest.unreadSessionKeys,
      );
      expect(remaining).toMatchObject({ hasUnreadWork: true, unreadSessionOverflow: true });
      const cleared = await storage.setEnvironmentUnread(environment.id, false);
      expect(cleared.hasUnreadWork).toBe(false);
    });
  });

  test("rejects malformed session keys", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      await expect(storage.setEnvironmentUnread(environment.id, false, null, [""])).rejects.toThrow(
        "sessionKeys must be",
      );
      await expect(
        storage.setEnvironmentUnread(
          environment.id,
          false,
          null,
          Array.from({ length: 33 }, (_, index) => `key-${index}`),
        ),
      ).rejects.toThrow("sessionKeys must be");
    });
  });
});
