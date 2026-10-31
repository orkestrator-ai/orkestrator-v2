import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createEnvironment, StorageService } from "../src/core/storage";
import { readStoredValue, seedStore } from "../src/core/storage-test-support";
import { createTempDir, removeTempDirs } from "./storage-test-helpers";

afterEach(removeTempDirs);

describe("Electron StorageService", () => {
  test("records environment activity atomically and only advances timestamps", async () => {
    const dataDir = await createTempDir("ork-storage-environment-activity-");
    const firstStorage = new StorageService(dataDir);
    const secondStorage = new StorageService(dataDir);
    await Promise.all([firstStorage.init(), secondStorage.init()]);

    const environment = await firstStorage.addEnvironment(createEnvironment("project-1"));
    expect((await secondStorage.getEnvironment(environment.id))?.lastActivityAt).toBe(
      environment.createdAt,
    );
    await firstStorage.updateEnvironment(environment.id, { lastActivityAt: undefined });

    await expect(
      firstStorage.recordEnvironmentActivity(environment.id, "2026-07-23T11:00:00+01:00"),
    ).resolves.toMatchObject({ lastActivityAt: "2026-07-23T10:00:00.000Z" });
    await expect(
      secondStorage.recordEnvironmentActivity(environment.id, "2026-07-23T10:00:00.000Z"),
    ).resolves.toMatchObject({ lastActivityAt: "2026-07-23T10:00:00.000Z" });
    await expect(
      secondStorage.recordEnvironmentActivity(environment.id, "2026-07-22T10:00:00.000Z"),
    ).resolves.toMatchObject({ lastActivityAt: "2026-07-23T10:00:00.000Z" });

    await firstStorage.updateEnvironment(environment.id, { lastActivityAt: undefined });
    expect((await secondStorage.getEnvironment(environment.id))?.lastActivityAt).toBeUndefined();

    const newer = "2026-07-25T10:00:00.000Z";
    const older = "2026-07-24T10:00:00.000Z";
    await Promise.all([
      firstStorage.recordEnvironmentActivity(environment.id, newer),
      secondStorage.recordEnvironmentActivity(environment.id, older),
    ]);
    expect((await firstStorage.getEnvironment(environment.id))?.lastActivityAt).toBe(newer);

    await firstStorage.updateEnvironment(environment.id, { lastActivityAt: undefined });
    await Promise.all([
      secondStorage.recordEnvironmentActivity(environment.id, older),
      firstStorage.recordEnvironmentActivity(environment.id, newer),
    ]);
    expect((await secondStorage.getEnvironment(environment.id))?.lastActivityAt).toBe(newer);

    await expect(firstStorage.recordEnvironmentActivity(environment.id, "invalid")).rejects.toThrow(
      "occurredAt must be a valid ISO timestamp",
    );
    await expect(firstStorage.recordEnvironmentActivity("missing", newer)).rejects.toThrow(
      "Environment not found: missing",
    );
  });

  test("stores and aggregates monotonic agent activity observations", async () => {
    const dataDir = await createTempDir("ork-storage-agent-activity-");
    const firstStorage = new StorageService(dataDir);
    const secondStorage = new StorageService(dataDir);
    await Promise.all([firstStorage.init(), secondStorage.init()]);

    const environment = await firstStorage.addEnvironment(createEnvironment("project-1"));
    const createdTime = Date.parse(environment.agentActivityUpdatedAt!);
    const frontendWorkingAt = new Date(createdTime + 1_000).toISOString();
    const terminalIdleAt = new Date(createdTime + 2_000).toISOString();
    const terminalWorkingAt = new Date(createdTime + 3_000).toISOString();
    const frontendIdleAt = new Date(createdTime + 4_000).toISOString();
    const terminalStoppedAt = new Date(createdTime + 5_000).toISOString();

    await expect(
      firstStorage.setEnvironmentAgentActivity(environment.id, "working", frontendWorkingAt),
    ).resolves.toMatchObject({
      agentActivityState: "working",
      agentActivityUpdatedAt: frontendWorkingAt,
    });
    await expect(
      secondStorage.setEnvironmentAgentActivity(
        environment.id,
        "idle",
        terminalIdleAt,
        "claude-terminal",
      ),
    ).resolves.toMatchObject({
      agentActivityState: "working",
      agentActivityUpdatedAt: terminalIdleAt,
    });
    await expect(
      secondStorage.setEnvironmentAgentActivity(
        environment.id,
        "working",
        terminalWorkingAt,
        "claude-terminal",
      ),
    ).resolves.toMatchObject({
      agentActivityState: "working",
      agentActivityUpdatedAt: terminalWorkingAt,
    });
    await expect(
      firstStorage.setEnvironmentAgentActivity(environment.id, "idle", frontendIdleAt),
    ).resolves.toMatchObject({
      agentActivityState: "working",
      agentActivityUpdatedAt: frontendIdleAt,
    });
    await expect(
      secondStorage.setEnvironmentAgentActivity(
        environment.id,
        "idle",
        new Date(createdTime + 2_500).toISOString(),
        "claude-terminal",
      ),
    ).resolves.toMatchObject({
      agentActivityState: "working",
      agentActivityUpdatedAt: frontendIdleAt,
    });
    await expect(
      secondStorage.setEnvironmentAgentActivity(
        environment.id,
        "idle",
        terminalStoppedAt,
        "claude-terminal",
      ),
    ).resolves.toMatchObject({
      agentActivityState: "idle",
      agentActivityUpdatedAt: terminalStoppedAt,
    });

    const workingAgainAt = new Date(createdTime + 6_000).toISOString();
    await firstStorage.setEnvironmentAgentActivity(environment.id, "working", workingAgainAt);
    await expect(
      secondStorage.updateEnvironment(environment.id, { status: "stopped" }),
    ).resolves.toMatchObject({
      status: "stopped",
      agentActivityState: "idle",
      agentActivitySources: {},
    });
    const stoppedEnvironment = (await firstStorage.getEnvironment(environment.id))!;
    expect(Date.parse(stoppedEnvironment.agentActivityUpdatedAt!)).toBeGreaterThan(
      Date.parse(workingAgainAt),
    );
    await expect(
      firstStorage.setEnvironmentAgentActivity(environment.id, "working", workingAgainAt),
    ).resolves.toMatchObject({
      agentActivityState: "idle",
      agentActivityUpdatedAt: stoppedEnvironment.agentActivityUpdatedAt,
      agentActivitySources: {},
    });

    await expect(
      firstStorage.setEnvironmentAgentActivity(environment.id, "busy" as never, frontendIdleAt),
    ).rejects.toThrow("state must be idle, working, or waiting");
    await expect(
      firstStorage.setEnvironmentAgentActivity(environment.id, "working", "invalid"),
    ).rejects.toThrow("occurredAt must be a valid ISO timestamp");
    await expect(
      firstStorage.setEnvironmentAgentActivity(
        environment.id,
        "working",
        frontendIdleAt,
        "unknown-source" as never,
      ),
    ).rejects.toThrow(
      "source must be frontend, claude-terminal, claude-tmux, native-agent, multi-review, or graph-run",
    );
  });

  test("accepts backend-owned multi-review activity without renderer observer ids", async () => {
    const dataDir = await createTempDir("ork-storage-multi-review-activity-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const occurredAt = new Date(
      Date.parse(environment.agentActivityUpdatedAt!) + 1_000,
    ).toISOString();

    await expect(
      storage.setEnvironmentAgentActivity(environment.id, "working", occurredAt, "multi-review"),
    ).resolves.toMatchObject({
      agentActivityState: "working",
      agentActivitySources: {
        "multi-review": { state: "working", updatedAt: occurredAt },
      },
    });

    await expect(
      storage.setEnvironmentAgentActivity(
        environment.id,
        "idle",
        new Date(Date.parse(occurredAt) + 1_000).toISOString(),
        "multi-review",
        "renderer-observer-id",
      ),
    ).rejects.toThrow(
      "observerId must be a non-blank string of at most 256 characters for frontend activity",
    );
  });

  test("accepts backend-owned native activity without renderer observer ids", async () => {
    const dataDir = await createTempDir("ork-storage-native-agent-activity-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const occurredAt = new Date(
      Date.parse(environment.agentActivityUpdatedAt!) + 1_000,
    ).toISOString();

    await expect(
      storage.setEnvironmentAgentActivity(environment.id, "waiting", occurredAt, "native-agent"),
    ).resolves.toMatchObject({
      agentActivityState: "waiting",
      agentActivitySources: {
        "native-agent": { state: "waiting", updatedAt: occurredAt },
      },
    });

    await expect(
      storage.setEnvironmentAgentActivity(
        environment.id,
        "working",
        new Date(Date.parse(occurredAt) + 1_000).toISOString(),
        "native-agent",
        "renderer-observer-id",
      ),
    ).rejects.toThrow(
      "observerId must be a non-blank string of at most 256 characters for frontend activity",
    );
    // A renderer supplying an observer id is claiming a lease only `frontend`
    // can hold. The rejected call must leave no trace: accepting it under any
    // other source would let a renderer drive the backend-owned projection.
    await expect(storage.getEnvironment(environment.id)).resolves.toMatchObject({
      agentActivityState: "waiting",
      agentActivitySources: {
        "native-agent": { state: "waiting", updatedAt: occurredAt },
      },
    });
  });

  test("aggregates native-agent and frontend observations as a max", async () => {
    // Neither source can retire the other's indicator: the backend sweep runs
    // whether or not a tab is mounted, and a mounted tab sees turns the sweep
    // has not polled yet. Taking either one alone would blank a live turn.
    const dataDir = await createTempDir("ork-storage-agent-native-aggregate-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const createdTime = Date.parse(environment.agentActivityUpdatedAt!);
    let elapsed = 0;
    const next = () => new Date(createdTime + (elapsed += 1_000)).toISOString();

    for (const [nativeState, frontendState, aggregate] of [
      ["working", "idle", "working"],
      ["idle", "working", "working"],
      ["waiting", "idle", "waiting"],
      ["idle", "waiting", "waiting"],
      ["idle", "idle", "idle"],
    ] as const) {
      await storage.setEnvironmentAgentActivity(
        environment.id,
        nativeState,
        next(),
        "native-agent",
      );
      await expect(
        storage.setEnvironmentAgentActivity(environment.id, frontendState, next(), "frontend"),
      ).resolves.toMatchObject({
        agentActivityState: aggregate,
        agentActivitySources: {
          "native-agent": { state: nativeState },
          frontend: { state: frontendState },
        },
      });
    }
  });

  test("aggregates independently leased renderer observations", async () => {
    const dataDir = await createTempDir("ork-storage-agent-observers-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const baseTime = Date.now();
    const at = (offset: number) => new Date(baseTime + offset).toISOString();
    const observerA = "opaque-renderer-token-a";
    const observerB = "opaque-renderer-token-b";

    await storage.setEnvironmentAgentActivity(
      environment.id,
      "working",
      at(1),
      "frontend",
      observerA,
    );
    await storage.setEnvironmentAgentActivity(
      environment.id,
      "working",
      at(2),
      "frontend",
      observerB,
    );
    const afterACompletes = await storage.setEnvironmentAgentActivity(
      environment.id,
      "idle",
      at(3),
      "frontend",
      observerA,
    );

    expect(afterACompletes.agentActivityState).toBe("working");
    expect(afterACompletes.frontendAgentActivityObservers).toMatchObject({
      [createHash("sha256").update(observerA).digest("hex")]: {
        state: "idle",
        updatedAt: at(3),
        leaseExpiresAt: expect.any(String),
      },
      [createHash("sha256").update(observerB).digest("hex")]: {
        state: "working",
        updatedAt: at(2),
        leaseExpiresAt: expect.any(String),
      },
    });
    expect(JSON.stringify(afterACompletes.frontendAgentActivityObservers)).not.toContain(observerA);
    expect(JSON.stringify(afterACompletes.frontendAgentActivityObservers)).not.toContain(observerB);

    await expect(
      storage.setEnvironmentAgentActivity(environment.id, "idle", at(4), "frontend", observerB),
    ).resolves.toMatchObject({ agentActivityState: "idle" });
  });

  test("expires abandoned renderer observations and republishes the aggregate", async () => {
    const dataDir = await createTempDir("ork-storage-agent-observer-expiry-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const updated = await storage.setEnvironmentAgentActivity(
      environment.id,
      "working",
      new Date().toISOString(),
      "frontend",
      "abandoned-renderer-token",
    );
    const observer = Object.values(updated.frontendAgentActivityObservers ?? {})[0]!;
    const announced: string[] = [];
    storage.setResourceChangeListener((change) => announced.push(change.id));

    await expect(
      storage.expireFrontendAgentActivityLeases(Date.parse(observer.leaseExpiresAt) + 1),
    ).resolves.toEqual([environment.id]);

    await expect(storage.getEnvironment(environment.id)).resolves.toMatchObject({
      agentActivityState: "idle",
      frontendAgentActivityObservers: {},
    });
    expect(announced).toEqual([environment.id]);
  });

  test("preserves waiting precedence and rejects an equal source timestamp", async () => {
    const dataDir = await createTempDir("ork-storage-agent-waiting-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const createdTime = Date.parse(environment.agentActivityUpdatedAt!);
    const waitingAt = new Date(createdTime + 1_000).toISOString();
    const terminalIdleAt = new Date(createdTime + 2_000).toISOString();

    await storage.setEnvironmentAgentActivity(environment.id, "waiting", waitingAt);
    await expect(
      storage.setEnvironmentAgentActivity(
        environment.id,
        "idle",
        terminalIdleAt,
        "claude-terminal",
      ),
    ).resolves.toMatchObject({
      agentActivityState: "waiting",
      agentActivityUpdatedAt: terminalIdleAt,
    });

    await expect(
      storage.setEnvironmentAgentActivity(environment.id, "idle", waitingAt),
    ).resolves.toMatchObject({
      agentActivityState: "waiting",
      agentActivityUpdatedAt: terminalIdleAt,
      agentActivitySources: {
        frontend: { state: "waiting", updatedAt: waitingAt },
      },
    });
  });

  test("keeps serialized backend terminal observations monotonic across clock ties", async () => {
    const dataDir = await createTempDir("ork-storage-agent-terminal-clock-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const occurredAt = new Date(Date.parse(environment.createdAt) + 1_000).toISOString();

    await storage.setEnvironmentAgentActivity(
      environment.id,
      "working",
      occurredAt,
      "claude-terminal",
    );
    const updated = await storage.setEnvironmentAgentActivity(
      environment.id,
      "idle",
      occurredAt,
      "claude-terminal",
    );

    expect(updated.agentActivityState).toBe("idle");
    expect(Date.parse(updated.agentActivitySources!["claude-terminal"]!.updatedAt)).toBe(
      Date.parse(occurredAt) + 1,
    );
  });

  test("keeps every one of a run of same-millisecond backend observations, in order", async () => {
    const dataDir = await createTempDir("ork-storage-agent-terminal-run-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const occurredAt = new Date(Date.parse(environment.createdAt) + 1_000).toISOString();
    const earlier = new Date(Date.parse(occurredAt) - 1).toISOString();

    // Three serialized sweeps in one millisecond: the second's token is bumped
    // to T+1, and the third, still observed at T, must not be mistaken for an
    // observation older than T+1.
    for (const state of ["working", "waiting", "idle"] as const) {
      await storage.setEnvironmentAgentActivity(environment.id, state, occurredAt, "native-agent");
    }
    const latest = (await storage.getEnvironment(environment.id))!;
    expect(latest.agentActivityState).toBe("idle");
    expect(latest.agentActivitySources!["native-agent"]).toMatchObject({
      state: "idle",
      updatedAt: new Date(Date.parse(occurredAt) + 2).toISOString(),
      observedAt: occurredAt,
    });

    // An observation genuinely older than the held one is still stale.
    const stale = await storage.setEnvironmentAgentActivity(
      environment.id,
      "working",
      earlier,
      "native-agent",
    );
    expect(stale.agentActivityState).toBe("idle");
  });

  test("bounds client clocks and recovers poisoned legacy activity timestamps", async () => {
    const dataDir = await createTempDir("ork-storage-agent-clock-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const maximumDate = "+275760-09-13T00:00:00.000Z";

    await expect(
      storage.setEnvironmentAgentActivity(environment.id, "working", maximumDate),
    ).rejects.toThrow("occurredAt must not be more than 5 minutes in the future");

    seedStore(dataDir, "environments.json", [
      {
        ...environment,
        agentActivityState: "working",
        agentActivityUpdatedAt: maximumDate,
        agentActivitySources: {
          frontend: {
            state: "working",
            updatedAt: maximumDate,
          },
          "claude-terminal": {
            state: "invalid-legacy-state",
            updatedAt: "not-a-date",
          },
        },
      },
    ]);

    const occurredAt = new Date().toISOString();
    await expect(
      storage.setEnvironmentAgentActivity(environment.id, "idle", occurredAt),
    ).resolves.toMatchObject({
      agentActivityState: "idle",
      agentActivityUpdatedAt: occurredAt,
      agentActivitySources: {
        frontend: { state: "idle", updatedAt: occurredAt },
      },
    });

    seedStore(dataDir, "environments.json", [
      {
        ...environment,
        status: "running",
        agentActivityState: "working",
        agentActivityUpdatedAt: maximumDate,
        agentActivitySources: {
          frontend: { state: "working", updatedAt: maximumDate },
        },
      },
    ]);
    await expect(
      storage.updateEnvironment(environment.id, { status: "error" }),
    ).resolves.toMatchObject({
      status: "error",
      agentActivityState: "idle",
      agentActivitySources: {},
    });
    const reset = await storage.getEnvironment(environment.id);
    expect(Number.isFinite(Date.parse(reset!.agentActivityUpdatedAt!))).toBe(true);
    expect(reset!.agentActivityUpdatedAt).not.toBe(maximumDate);
  });

  test("accepts legacy environments without activity fields", async () => {
    const dataDir = await createTempDir("ork-storage-agent-legacy-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = createEnvironment("project-1");
    delete environment.agentActivityState;
    delete environment.agentActivityUpdatedAt;
    delete environment.agentActivitySources;
    seedStore(dataDir, "environments.json", [environment]);

    const legacy = await storage.getEnvironment(environment.id);
    expect(legacy?.id).toBe(environment.id);
    expect(legacy).not.toHaveProperty("agentActivityState");
    expect(legacy).not.toHaveProperty("agentActivityUpdatedAt");
    const occurredAt = new Date().toISOString();
    await expect(
      storage.setEnvironmentAgentActivity(environment.id, "working", occurredAt),
    ).resolves.toMatchObject({
      agentActivityState: "working",
      agentActivityUpdatedAt: occurredAt,
      agentActivitySources: {
        frontend: { state: "working", updatedAt: occurredAt },
      },
    });
  });

  test("only clears activity for statuses that end the agent's run", async () => {
    // "stopping" is a request, not an outcome, and "creating"/"running" are
    // mid-flight. Wiping activity on any of those would blank a live turn.
    const dataDir = await createTempDir("ork-storage-agent-status-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const workingAt = new Date(
      Date.parse(environment.agentActivityUpdatedAt!) + 1_000,
    ).toISOString();
    const working = {
      agentActivityState: "working",
      agentActivitySources: {
        frontend: { state: "working", updatedAt: workingAt },
      },
    };

    for (const status of ["creating", "running", "stopping"] as const) {
      await storage.setEnvironmentAgentActivity(environment.id, "working", workingAt);
      await expect(storage.updateEnvironment(environment.id, { status })).resolves.toMatchObject({
        status,
        ...working,
      });
    }

    await expect(
      storage.updateEnvironment(environment.id, { name: "Renamed" }),
    ).resolves.toMatchObject(working);
  });

  test("bounds the accepted clock skew at exactly five minutes", async () => {
    const dataDir = await createTempDir("ork-storage-agent-skew-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));

    // Comfortably inside the window, so a slow test runner cannot flip it.
    await expect(
      storage.setEnvironmentAgentActivity(
        environment.id,
        "working",
        new Date(Date.now() + 4 * 60_000).toISOString(),
      ),
    ).resolves.toMatchObject({ agentActivityState: "working" });

    await expect(
      storage.setEnvironmentAgentActivity(
        environment.id,
        "idle",
        new Date(Date.now() + 6 * 60_000).toISOString(),
      ),
    ).rejects.toThrow("occurredAt must not be more than 5 minutes in the future");
  });

  test("rejects the loose date forms Date.parse would otherwise accept", async () => {
    // The error message promises an ISO timestamp. Accepting "Jul 27 2026"
    // would let two clients mint tokens that do not order against each other.
    const dataDir = await createTempDir("ork-storage-agent-iso-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));

    for (const occurredAt of ["Jul 27 2026 12:00:00", "2026-07-27", "2026/07/27 12:00:00"]) {
      expect(Number.isFinite(Date.parse(occurredAt))).toBe(true);
      await expect(
        storage.setEnvironmentAgentActivity(environment.id, "working", occurredAt),
      ).rejects.toThrow("occurredAt must be a valid ISO timestamp");
    }

    expect((await storage.getEnvironment(environment.id))?.agentActivityState).toBe("idle");
  });

  test("orders a source's first report against the aggregate token", async () => {
    // A source with no snapshot of its own still has to lose to a newer
    // aggregate. Exempting it would let a delayed or retried report resurrect
    // a state the environment has already left.
    const dataDir = await createTempDir("ork-storage-agent-first-report-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const createdTime = Date.parse(environment.agentActivityUpdatedAt!);
    const terminalIdleAt = new Date(createdTime + 5_000).toISOString();
    const staleFrontendWorkingAt = new Date(createdTime + 1_000).toISOString();

    await storage.setEnvironmentAgentActivity(
      environment.id,
      "idle",
      terminalIdleAt,
      "claude-terminal",
    );

    await expect(
      storage.setEnvironmentAgentActivity(environment.id, "working", staleFrontendWorkingAt),
    ).resolves.toMatchObject({
      agentActivityState: "idle",
      agentActivityUpdatedAt: terminalIdleAt,
    });
    expect((await storage.getEnvironment(environment.id))?.agentActivitySources).not.toHaveProperty(
      "frontend",
    );

    // A report that is genuinely newer than the aggregate still lands.
    const freshFrontendWorkingAt = new Date(createdTime + 6_000).toISOString();
    await expect(
      storage.setEnvironmentAgentActivity(environment.id, "working", freshFrontendWorkingAt),
    ).resolves.toMatchObject({
      agentActivityState: "working",
      agentActivityUpdatedAt: freshFrontendWorkingAt,
    });
  });

  test("bumps a tied terminal report that has no prior source of its own", async () => {
    // The state right after a stop/reset: sources are empty but the aggregate
    // token survives, and the first poll back can land in the same millisecond.
    const dataDir = await createTempDir("ork-storage-agent-tie-aggregate-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    await storage.updateEnvironment(environment.id, { status: "stopped" });
    const reset = (await storage.getEnvironment(environment.id))!;
    expect(reset.agentActivitySources).toEqual({});

    const updated = await storage.setEnvironmentAgentActivity(
      environment.id,
      "working",
      reset.agentActivityUpdatedAt!,
      "claude-terminal",
    );

    expect(updated.agentActivityState).toBe("working");
    expect(Date.parse(updated.agentActivitySources!["claude-terminal"]!.updatedAt)).toBe(
      Date.parse(reset.agentActivityUpdatedAt!) + 1,
    );

    // A frontend tie against the same token is still simply rejected: only the
    // serialized backend poller earns the monotonic bump.
    await expect(
      storage.setEnvironmentAgentActivity(environment.id, "idle", reset.agentActivityUpdatedAt!),
    ).resolves.toMatchObject({ agentActivityState: "working" });
  });

  test("clears renderer-reported activity without touching backend observations", async () => {
    // Backend startup is the one moment where every renderer is provably gone.
    // Nothing else can lower a stale `frontend: working` — the aggregate is a
    // max — so without this an environment stays blue across restarts forever.
    const dataDir = await createTempDir("ork-storage-agent-clear-frontend-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const stuck = await storage.addEnvironment(createEnvironment("project-1"));
    const untouched = await storage.addEnvironment(createEnvironment("project-1"));
    const createdTime = Date.parse(stuck.agentActivityUpdatedAt!);
    const terminalWaitingAt = new Date(createdTime + 1_000).toISOString();
    const frontendWorkingAt = new Date(createdTime + 2_000).toISOString();
    const observerWorkingAt = new Date(createdTime + 3_000).toISOString();

    await storage.setEnvironmentAgentActivity(
      stuck.id,
      "waiting",
      terminalWaitingAt,
      "claude-terminal",
    );
    await storage.setEnvironmentAgentActivity(stuck.id, "working", frontendWorkingAt);
    await storage.setEnvironmentAgentActivity(
      untouched.id,
      "working",
      new Date(createdTime + 4_000).toISOString(),
      "claude-terminal",
    );
    await storage.setEnvironmentAgentActivity(
      stuck.id,
      "working",
      observerWorkingAt,
      "frontend",
      "renderer-to-clear",
    );

    const announced: string[] = [];
    storage.setResourceChangeListener((change) => {
      announced.push(`${change.resource}:${change.id}`);
    });
    await expect(storage.clearFrontendAgentActivity()).resolves.toEqual([stuck.id]);
    expect(announced).toEqual([`environment:${stuck.id}`]);

    const cleared = (await storage.getEnvironment(stuck.id))!;
    // The backend's own observation survives and becomes the aggregate.
    expect(cleared.agentActivityState).toBe("waiting");
    expect(cleared.agentActivitySources).toEqual({
      "claude-terminal": {
        state: "waiting",
        updatedAt: terminalWaitingAt,
        observedAt: terminalWaitingAt,
      },
    });
    expect(cleared.frontendAgentActivityObservers).toEqual({});
    // The token moves forward so a frontend hydrating from this snapshot
    // prefers it over any observation it made before the restart.
    expect(Date.parse(cleared.agentActivityUpdatedAt!)).toBeGreaterThan(
      Date.parse(observerWorkingAt),
    );

    await expect(storage.getEnvironment(untouched.id)).resolves.toMatchObject({
      agentActivityState: "working",
    });
  });

  test("clears renderer activity without disturbing the native-agent projection", async () => {
    // This runs at every backend start, immediately before the first reconcile
    // sweep. Wiping `native-agent` here would blank the sidebar for every
    // environment until a sweep succeeded — and a bridge that is slow to come
    // back would leave it blank for much longer than that.
    const dataDir = await createTempDir("ork-storage-agent-clear-native-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const createdTime = Date.parse(environment.agentActivityUpdatedAt!);
    const nativeWaitingAt = new Date(createdTime + 1_000).toISOString();
    const frontendWorkingAt = new Date(createdTime + 2_000).toISOString();

    await storage.setEnvironmentAgentActivity(
      environment.id,
      "waiting",
      nativeWaitingAt,
      "native-agent",
    );
    await expect(
      storage.setEnvironmentAgentActivity(
        environment.id,
        "working",
        frontendWorkingAt,
        "frontend",
        "renderer-to-clear",
      ),
    ).resolves.toMatchObject({ agentActivityState: "working" });

    await expect(storage.clearFrontendAgentActivity()).resolves.toEqual([environment.id]);

    const cleared = (await storage.getEnvironment(environment.id))!;
    // State and token both survive intact; only `frontend` is dropped, and the
    // recomputed aggregate is the survivor's own state.
    expect(cleared.agentActivitySources).toEqual({
      "native-agent": { state: "waiting", updatedAt: nativeWaitingAt, observedAt: nativeWaitingAt },
    });
    expect(cleared.agentActivityState).toBe("waiting");
    expect(cleared.frontendAgentActivityObservers).toEqual({});
  });

  test("clearing renderer activity is a no-op when nothing was reported", async () => {
    const dataDir = await createTempDir("ork-storage-agent-clear-noop-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const before = (await storage.getEnvironment(environment.id))!;

    const announced: string[] = [];
    storage.setResourceChangeListener((change) => announced.push(change.id));
    await expect(storage.clearFrontendAgentActivity()).resolves.toEqual([]);

    expect(announced).toEqual([]);
    expect(await storage.getEnvironment(environment.id)).toEqual(before);
  });

  test("ignores stored key order when deciding whether an activity write changed anything", async () => {
    // The backend rebuilds the source map in a fixed order while the persisted
    // file keeps whatever order it was written in. If the change check were
    // order-sensitive, every ~10s lease renewal would look structural and be
    // broadcast to every connected client, which is the storm this check exists
    // to prevent.
    const dataDir = await createTempDir("ork-storage-agent-key-order-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const createdTime = Date.parse(environment.createdAt);
    const reportedAt = new Date(createdTime + 1_000).toISOString();

    const stored = readStoredValue<Array<Record<string, unknown>>>(dataDir, "environments.json")!;
    stored[0]!.agentActivityState = "working";
    stored[0]!.agentActivityUpdatedAt = reportedAt;
    stored[0]!.agentActivitySources = {
      "claude-terminal": { state: "working", updatedAt: reportedAt },
      frontend: { state: "working", updatedAt: reportedAt },
    };
    seedStore(dataDir, "environments.json", stored);

    const announced: string[] = [];
    storage.setResourceChangeListener((change) => announced.push(change.id));

    // Same states everywhere, only the token moves forward.
    await storage.setEnvironmentAgentActivity(
      environment.id,
      "working",
      new Date(createdTime + 2_000).toISOString(),
      "claude-terminal",
    );
    expect(announced).toEqual([]);

    // A real per-source transition is announced even though the aggregate —
    // still "working" thanks to the frontend source — has not moved.
    await storage.setEnvironmentAgentActivity(
      environment.id,
      "idle",
      new Date(createdTime + 3_000).toISOString(),
      "claude-terminal",
    );
    expect(announced).toEqual([environment.id]);
    await expect(storage.getEnvironment(environment.id)).resolves.toMatchObject({
      agentActivityState: "working",
    });
  });

  test("serializes concurrent agent observations to the newest source timestamp", async () => {
    const dataDir = await createTempDir("ork-storage-agent-concurrent-");
    const firstStorage = new StorageService(dataDir);
    const secondStorage = new StorageService(dataDir);
    await Promise.all([firstStorage.init(), secondStorage.init()]);
    const environment = await firstStorage.addEnvironment(createEnvironment("project-1"));
    const createdTime = Date.parse(environment.createdAt);
    const older = new Date(createdTime + 1_000).toISOString();
    const newer = new Date(createdTime + 2_000).toISOString();

    await Promise.all([
      firstStorage.setEnvironmentAgentActivity(environment.id, "working", newer),
      secondStorage.setEnvironmentAgentActivity(environment.id, "waiting", older),
    ]);

    await expect(firstStorage.getEnvironment(environment.id)).resolves.toMatchObject({
      agentActivityState: "working",
      agentActivityUpdatedAt: newer,
      agentActivitySources: {
        frontend: {
          state: "working",
          updatedAt: newer,
        },
      },
    });
  });
});
