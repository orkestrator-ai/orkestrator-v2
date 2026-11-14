import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configureLogger } from "@orkestrator/protocol/logger";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import {
  QUEUED_TURN_LOG_SESSION_LIMIT,
  QueuedTurnPhaseLog,
} from "./native-agent-queued-turn-log.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

const QUEUED_TEXT = "private queued prompt";
const MESSAGE_TEXT = "private transcript text";

describe("queued turn phase log", () => {
  let logs: LogCapture;

  beforeEach(() => {
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
  });

  const lines = () => logs.records().filter((record) => record.event === "queue.turn-not-running");

  const observation = (phase: string | undefined, queued: number, sessionKey = "session-a") => ({
    agent: "claude",
    environmentId: "env-1",
    sessionKey,
    phase,
    queued,
  });

  test("writes once per change of phase while a queue is held", () => {
    configureLogger({ areaLevels: { "native-agent": "debug" } });
    const tracker = new QueuedTurnPhaseLog();

    tracker.observe(observation("recovering", 1));
    tracker.observe(observation("recovering", 2));
    tracker.observe(observation("error", 2));

    expect(lines().map((record) => record.fields)).toEqual([
      { agent: "claude", environmentId: "env-1", phase: "recovering", queued: 1 },
      { agent: "claude", environmentId: "env-1", phase: "error", queued: 2 },
    ]);
    expect(lines().every((record) => record.level === "debug")).toBe(true);
  });

  test("a running turn or an empty queue writes nothing and re-arms the line", () => {
    configureLogger({ areaLevels: { "native-agent": "debug" } });
    const tracker = new QueuedTurnPhaseLog();

    tracker.observe(observation("running", 3));
    tracker.observe(observation("idle", 0));
    expect(lines()).toEqual([]);

    tracker.observe(observation("idle", 1));
    tracker.observe(observation("running", 1));
    tracker.observe(observation("idle", 1));
    tracker.observe(observation("idle", 0));
    tracker.observe(observation("idle", 1));

    expect(lines().map((record) => record.fields?.phase)).toEqual(["idle", "idle", "idle"]);
    expect(tracker.size()).toBe(1);
  });

  test("an absent phase is written as unknown", () => {
    configureLogger({ areaLevels: { "native-agent": "debug" } });
    new QueuedTurnPhaseLog().observe(observation(undefined, 1));
    expect(lines().map((record) => record.fields?.phase)).toEqual(["unknown"]);
  });

  test("nothing is written or remembered below debug", () => {
    const tracker = new QueuedTurnPhaseLog();
    tracker.observe(observation("recovering", 1));
    expect(lines()).toEqual([]);
    expect(tracker.size()).toBe(0);

    // Raising Log Detail later still writes the state already in force.
    configureLogger({ areaLevels: { "native-agent": "debug" } });
    tracker.observe(observation("recovering", 1));
    expect(lines()).toHaveLength(1);
  });

  test("remembers a bounded number of sessions", () => {
    configureLogger({ areaLevels: { "native-agent": "debug" } });
    const tracker = new QueuedTurnPhaseLog();
    for (let index = 0; index < QUEUED_TURN_LOG_SESSION_LIMIT + 10; index += 1) {
      tracker.observe(observation("idle", 1, `session-${index}`));
    }
    expect(tracker.size()).toBe(QUEUED_TURN_LOG_SESSION_LIMIT);
    // The evicted oldest session writes again; a remembered one does not.
    tracker.observe(observation("idle", 1, "session-0"));
    tracker.observe(observation("idle", 1, `session-${QUEUED_TURN_LOG_SESSION_LIMIT + 9}`));
    expect(lines()).toHaveLength(QUEUED_TURN_LOG_SESSION_LIMIT + 11);
  });
});

describe("projection queued turn logging", () => {
  let logs: LogCapture;

  beforeEach(() => {
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
  });

  const lines = () => logs.records().filter((record) => record.event === "queue.turn-not-running");

  const identity = {
    environmentId: "env-1",
    agent: "claude" as const,
    logicalSessionKey: "env-env-1:tab-queued-turn-log",
  };

  function stubWithPhase(read: () => { status: "running" | "idle" | "error"; phase?: string }) {
    return createProviderStub("claude", {
      interactiveSnapshot: async () => {
        const { status, phase } = read();
        return {
          status,
          ...(phase ? { phase: phase as "recovering" } : {}),
          messages: [
            {
              id: "assistant",
              role: "assistant",
              content: MESSAGE_TEXT,
              parts: [{ type: "text", content: MESSAGE_TEXT }],
              createdAt: new Date(0).toISOString(),
            },
          ],
        };
      },
      steerSupported: async () => true,
    });
  }

  test("both projection reads write one content-free line per change of phase", async () => {
    configureLogger({ areaLevels: { "native-agent": "debug" } });
    let state: { status: "running" | "idle" | "error"; phase?: string } = {
      status: "running",
      phase: "recovering",
    };
    const stub = stubWithPhase(() => state);

    await withService(
      { prefix: "orkestrator-queued-turn-log-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        await storage.savePromptQueue(`claude\0${identity.logicalSessionKey}`, "env-1", [
          { id: "queued-1", text: QUEUED_TEXT, planModeEnabled: false },
        ]);

        const recovering = await service.getProjection(identity);
        expect(recovering?.turn.phase).toBe("recovering");
        expect(recovering?.queue?.items).toHaveLength(1);
        const state1 = await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
        if (state1.status !== "snapshot") throw new Error("expected snapshot");
        expect(state1.value.turn.phase).toBe("recovering");
        expect(lines()).toHaveLength(1);

        state = { status: "running" };
        const running = await service.getProjection(identity);
        expect(running?.turn.phase).toBe("running");
        expect(lines()).toHaveLength(1);

        state = { status: "running", phase: "recovering" };
        await service.getSessionStateUpdate({ ...identity, viewVersion: 1, forceSnapshot: true });
        expect(lines()).toHaveLength(2);
      },
    );

    expect(lines().map((record) => record.fields)).toEqual([
      { agent: "claude", environmentId: "env-1", phase: "recovering", queued: 1 },
      { agent: "claude", environmentId: "env-1", phase: "recovering", queued: 1 },
    ]);
    const written = lines()
      .map((record) => JSON.stringify(record))
      .join("\n");
    expect(written).not.toContain(QUEUED_TEXT);
    expect(written).not.toContain(MESSAGE_TEXT);
    expect(written).not.toContain("queued-1");
    expect(written).not.toContain("provider-session");
    expect(written).not.toContain(identity.logicalSessionKey);
  });

  test("a running turn with a queue writes nothing", async () => {
    configureLogger({ areaLevels: { "native-agent": "debug" } });
    const stub = stubWithPhase(() => ({ status: "running" }));

    await withService(
      { prefix: "orkestrator-queued-turn-running-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        await storage.savePromptQueue(`claude\0${identity.logicalSessionKey}`, "env-1", [
          { id: "queued-1", text: QUEUED_TEXT, planModeEnabled: false },
        ]);
        const projection = await service.getProjection(identity);
        expect(projection?.turn.phase).toBe("running");
        expect(projection?.queue?.items).toHaveLength(1);
      },
    );

    expect(lines()).toEqual([]);
  });

  test("the line is off at the default level", async () => {
    const stub = stubWithPhase(() => ({ status: "running", phase: "recovering" }));

    await withService(
      { prefix: "orkestrator-queued-turn-default-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        await storage.savePromptQueue(`claude\0${identity.logicalSessionKey}`, "env-1", [
          { id: "queued-1", text: QUEUED_TEXT, planModeEnabled: false },
        ]);
        expect((await service.getProjection(identity))?.turn.phase).toBe("recovering");
      },
    );

    expect(lines()).toEqual([]);
  });
});
