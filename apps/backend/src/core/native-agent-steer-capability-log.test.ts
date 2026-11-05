import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configureLogger } from "@orkestrator/protocol/logger";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

const MESSAGE_TEXT = "private transcript text";

function runningStub(steerSupported: () => Promise<boolean>) {
  return createProviderStub("claude", {
    interactiveSnapshot: async () => ({
      status: "running",
      messages: [
        {
          id: "assistant",
          role: "assistant",
          content: MESSAGE_TEXT,
          parts: [{ type: "text", content: MESSAGE_TEXT }],
          createdAt: new Date(0).toISOString(),
        },
      ],
    }),
    steerSupported,
  });
}

describe("projection steer capability logging", () => {
  let logs: LogCapture;

  beforeEach(() => {
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
  });

  const clearedRecords = () =>
    logs.records().filter((record) => record.event === "steer.capability-cleared");

  const identity = {
    environmentId: "env-1",
    agent: "claude" as const,
    logicalSessionKey: "env-env-1:tab-steer-capability-log",
  };

  test("a full projection that clears steering logs a debug line and stays cleared", async () => {
    configureLogger({ areaLevels: { "native-agent": "debug" } });
    const stub = runningStub(async () => false);

    await withService(
      { prefix: "orkestrator-steer-log-projection-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.capabilities.actions?.steer).toBe(false);
      },
    );

    expect(clearedRecords()).toMatchObject([
      {
        level: "debug",
        area: "native-agent",
        fields: { agent: "claude", environmentId: "env-1", status: "running" },
      },
    ]);
    const written = clearedRecords().map((record) => JSON.stringify(record));
    expect(written.join("\n")).not.toContain("provider-session");
    expect(written.join("\n")).not.toContain(MESSAGE_TEXT);
  });

  test("a state read that clears steering logs the same debug line", async () => {
    configureLogger({ areaLevels: { "native-agent": "debug" } });
    const stub = runningStub(async () => false);

    await withService(
      { prefix: "orkestrator-steer-log-state-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const update = await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
        if (update.status !== "snapshot") throw new Error("expected snapshot");
        expect(update.value.capabilities.actions?.steer).toBe(false);
      },
    );

    expect(clearedRecords()).toMatchObject([
      {
        level: "debug",
        area: "native-agent",
        fields: { agent: "claude", environmentId: "env-1", status: "running" },
      },
    ]);
  });

  test("a provider's rejected qualification is still cleared and logged", async () => {
    configureLogger({ areaLevels: { "native-agent": "debug" } });
    const stub = runningStub(async () => {
      throw new Error("qualification rejected");
    });

    await withService(
      { prefix: "orkestrator-steer-log-rejected-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.capabilities.actions?.steer).toBe(false);
      },
    );

    expect(clearedRecords()).toHaveLength(1);
  });

  test("a qualified bridge logs nothing and keeps steering", async () => {
    configureLogger({ areaLevels: { "native-agent": "debug" } });
    const stub = runningStub(async () => true);

    await withService(
      { prefix: "orkestrator-steer-log-qualified-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.capabilities.actions?.steer).toBe(true);
        const update = await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
        if (update.status !== "snapshot") throw new Error("expected snapshot");
        expect(update.value.capabilities.actions?.steer).toBe(true);
      },
    );

    expect(clearedRecords()).toEqual([]);
  });

  test("the line is off at the default level", async () => {
    const stub = runningStub(async () => false);

    await withService(
      { prefix: "orkestrator-steer-log-default-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.capabilities.actions?.steer).toBe(false);
      },
    );

    expect(clearedRecords()).toEqual([]);
  });
});
