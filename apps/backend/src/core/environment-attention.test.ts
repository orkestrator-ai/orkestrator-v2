import { eventSink } from "./backend-emit.js";
import { describe, expect, test } from "bun:test";
import {
  COORDINATOR_WAKE_ATTENTION_EVENT,
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

  test("a question raises attention even while the badge is lit for finished work, once", async () => {
    await withTemporaryStorage(async (storage) => {
      const events: EnvironmentAttentionEvent[] = [];
      storage.addEnvironmentAttentionListener((event) => events.push(event));
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const at = () => new Date().toISOString();

      await storage.recordEnvironmentSessionCompletion(environment.id, at());
      // Finished work is unread; an agent now asks a question.
      await storage.recordEnvironmentAgentAttention(environment.id, ["question-1"], at());
      // A second question while one is already shown is not raised again.
      await storage.recordEnvironmentAgentAttention(environment.id, ["question-2"], at());
      await storage.recordEnvironmentSessionCompletion(environment.id, at(), "agent_waiting");
      expect(events.map((event) => event.reason)).toEqual(["agent_finished", "agent_question"]);

      // A failure badge, then a session parks on an approval.
      await storage.setEnvironmentUnread(environment.id, false);
      await storage.recordEnvironmentSessionCompletion(environment.id, at(), "agent_failed");
      await storage.recordEnvironmentSessionCompletion(environment.id, at(), "agent_waiting");
      // Finishing after the question does not raise: the badge was already lit.
      await storage.recordEnvironmentSessionCompletion(environment.id, at());
      expect(events.map((event) => event.reason)).toEqual([
        "agent_finished",
        "agent_question",
        "agent_failed",
        "agent_waiting",
      ]);
      // Setup approval is not a client attention reason at all.
      await storage.setEnvironmentUnread(environment.id, false);
      await storage.recordEnvironmentAgentAttention(
        environment.id,
        ["setup-1"],
        at(),
        "setup_approval",
      );
      expect(events).toHaveLength(4);
    });
  });

  for (const reason of [undefined, "marked_unread"] as const) {
    for (const next of ["agent_waiting", "agent_question"] as const) {
      test(`a manually unread badge (${reason}) escalates to ${next} once`, async () => {
        await withTemporaryStorage(async (storage) => {
          const events: EnvironmentAttentionEvent[] = [];
          storage.addEnvironmentAttentionListener((event) => events.push(event));
          const environment = createEnvironment("project-1");
          environment.hasUnreadWork = true;
          environment.unreadReason = reason;
          await storage.addEnvironment(environment);
          const at = new Date().toISOString();
          if (next === "agent_question") {
            await storage.recordEnvironmentAgentAttention(environment.id, ["q1"], at);
            await storage.recordEnvironmentAgentAttention(environment.id, ["q2"], at);
          } else {
            await storage.recordEnvironmentSessionCompletion(environment.id, at, next);
            await storage.recordEnvironmentSessionCompletion(environment.id, at, next);
          }
          expect(events.map((event) => event.reason)).toEqual([next]);
        });
      });
    }
  }

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

      // Lit for finished work, the aggregate then parks waiting on the user.
      await storage.setEnvironmentAgentActivity(
        environment.id,
        "working",
        new Date(start + 2_000).toISOString(),
        "native-agent",
      );
      await storage.setEnvironmentAgentActivity(
        environment.id,
        "waiting",
        new Date(start + 3_000).toISOString(),
        "native-agent",
      );
      expect(events.map((event) => event.reason)).toEqual(["agent_finished", "agent_waiting"]);
    });
  });

  test("the fan-out emits attention edges and resource changes to clients", async () => {
    await withTemporaryStorage(async (storage) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const observed: unknown[] = [];
      installStorageEventFanout(
        storage,
        eventSink((event, payload) => emitted.push({ event, payload })),
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
      const wake = {
        attentionId: "delegation-wake:a:t",
        projectId: "project-1",
        coordinatorId: "c",
        occurredAt: new Date().toISOString(),
      };
      storage.notifyCoordinatorWake(wake);
      expect(emitted.at(-1)).toEqual({ event: COORDINATOR_WAKE_ATTENTION_EVENT, payload: wake });
    });
  });
});
