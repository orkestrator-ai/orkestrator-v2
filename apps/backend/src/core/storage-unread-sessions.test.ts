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

  test("unattributed work makes the badge environment-wide, and it stays so", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      await storage.recordEnvironmentSessionCompletion(
        environment.id,
        at(1_000),
        "agent_finished",
        undefined,
        SESSION_A,
      );
      const terminal = await storage.recordEnvironmentCompletion(environment.id, at(2_000));
      expect(terminal.hasUnreadWork).toBe(true);
      expect(terminal).not.toHaveProperty("unreadSessionKeys");

      // A later session result does not narrow an environment-wide badge.
      const later = await storage.recordEnvironmentSessionCompletion(
        environment.id,
        at(3_000),
        "agent_finished",
        undefined,
        SESSION_B,
      );
      expect(later).not.toHaveProperty("unreadSessionKeys");

      // Any acknowledgement clears an environment-wide badge.
      const cleared = await storage.setEnvironmentUnread(
        environment.id,
        false,
        later.lastActivityAt!,
        [SESSION_A],
      );
      expect(cleared.hasUnreadWork).toBe(false);
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

  test("an attribution list that would overflow falls back to environment-wide", async () => {
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
      expect(latest).not.toHaveProperty("unreadSessionKeys");
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
