import { describe, expect, test } from "bun:test";
import {
  ENVIRONMENT_ATTENTION_EVENT,
  isEnvironmentAttentionEvent,
  type EnvironmentAttentionEvent,
} from "@orkestrator/protocol/environment-attention";
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";
import { installStorageEventFanout } from "./backend-event-fanout.js";
import { createEnvironment } from "./storage.js";
import { withTemporaryStorage } from "./storage-test-support.js";

describe("environment attention events", () => {
  test("one event per unread edge an agent or terminal raises, never for a re-light or a manual mark", async () => {
    await withTemporaryStorage(async (storage) => {
      const events: EnvironmentAttentionEvent[] = [];
      storage.addEnvironmentAttentionListener((event) => events.push(event));
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const at = () => new Date().toISOString();

      await storage.recordEnvironmentSessionCompletion(environment.id, at());
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        environmentId: environment.id,
        projectId: "project-1",
        reason: "agent_finished",
      });
      expect(isEnvironmentAttentionEvent(events[0])).toBe(true);

      // Already unread: the badge is re-lit, not raised again.
      await storage.recordEnvironmentSessionCompletion(environment.id, at(), "agent_failed");
      expect(events).toHaveLength(1);

      await storage.setEnvironmentUnread(environment.id, false);
      await storage.setEnvironmentUnread(environment.id, true);
      expect(events).toHaveLength(1);

      await storage.setEnvironmentUnread(environment.id, false);
      await storage.recordEnvironmentAgentAttention(environment.id, ["question-1"], at());
      await storage.setEnvironmentUnread(environment.id, false);
      await storage.recordEnvironmentCompletion(
        environment.id,
        new Date(Date.now() + 1000).toISOString(),
      );
      expect(events.map((event) => event.reason)).toEqual([
        "agent_finished",
        "agent_question",
        "terminal_finished",
      ]);
      expect(new Set(events.map((event) => event.attentionId)).size).toBe(3);
    });
  });

  test("an activity aggregate ending its work raises attention once", async () => {
    await withTemporaryStorage(async (storage) => {
      const events: EnvironmentAttentionEvent[] = [];
      storage.addEnvironmentAttentionListener((event) => events.push(event));
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const start = Date.now() + 1_000;
      await storage.setEnvironmentAgentActivity(
        environment.id,
        "working",
        new Date(start).toISOString(),
        "native-agent",
      );
      expect(events).toHaveLength(0);
      await storage.setEnvironmentAgentActivity(
        environment.id,
        "idle",
        new Date(start + 1_000).toISOString(),
        "native-agent",
      );
      expect(events.map((event) => event.reason)).toEqual(["agent_finished"]);
    });
  });

  test("the fan-out emits attention edges and resource changes to clients", async () => {
    await withTemporaryStorage(async (storage) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const observed: unknown[] = [];
      installStorageEventFanout(
        storage,
        (event, payload) => emitted.push({ event, payload }),
        (change) => observed.push(change),
      );
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      await storage.recordEnvironmentSessionCompletion(environment.id, new Date().toISOString());
      const attention = emitted.filter((entry) => entry.event === ENVIRONMENT_ATTENTION_EVENT);
      expect(attention).toHaveLength(1);
      expect(isEnvironmentAttentionEvent(attention[0]!.payload)).toBe(true);
      expect(emitted.some((entry) => entry.event === RESOURCE_CHANGED_EVENT)).toBe(true);
      expect(observed.length).toBe(
        emitted.filter((entry) => entry.event === RESOURCE_CHANGED_EVENT).length,
      );
    });
  });
});
