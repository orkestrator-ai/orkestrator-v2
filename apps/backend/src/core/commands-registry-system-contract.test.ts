/**
 * The `system` commands are registered with their definitions (plan item
 * 7009): the registry holds each definition and advertises the domain in the
 * hello, every key a handler reads survives decoding (a defined command drops
 * the keys it does not declare), and an in-process caller's schedule actor
 * still reaches the scheduled-job service.
 */
import { expect, mock, test } from "bun:test";
import { SYSTEM_COMMANDS } from "@orkestrator/protocol/contract/domains/system";
import type { ScheduleOwner } from "@orkestrator/protocol/scheduled-jobs";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { withScheduleActor } from "./commands-registry-scheduled-jobs.js";

test("registers every system command with its definition", () => {
  const registry = createCommandRegistry();
  for (const def of SYSTEM_COMMANDS) {
    expect({ name: def.name, defined: registry.contracts.get(def.name) === def }).toEqual({
      name: def.name,
      defined: true,
    });
  }
  expect(registry.helloDomains().system).toEqual({ min: 1, max: 1 });
});

const snapshot = {
  revision: 3,
  version: "2.36.0",
  updater: { kind: "desktop", available: true, reason: null },
  job: null,
  ghChannel: "pinned",
  updateChannel: "stable",
};
const job = {
  id: "job-1",
  state: "requested",
  fromVersion: "2.36.0",
  requestedVersion: "2.37.0",
  targetVersion: null,
  drain: "when-idle",
  requestedAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
};

test("request_host_update hands every key it reads to the service and drops the rest", async () => {
  const requestUpdate = mock((_input: unknown) => job);
  const context = {
    hostMaintenance: { requestUpdate, snapshot: () => snapshot },
  } as unknown as CommandContext;
  expect(
    await createCommandRegistry().get("request_host_update")!(
      { version: "2.37.0", drain: "when-idle", maxWaitSeconds: 600, unknownKey: true },
      context,
    ),
  ).toEqual({ job, snapshot });
  expect(requestUpdate).toHaveBeenCalledWith({
    requestedVersion: "2.37.0",
    drain: "when-idle",
    maxWaitSeconds: 600,
  });
});

const schedule = {
  id: "s1",
  name: "Nightly",
  ownerKey: "coordinator:p1:c1:v1",
  state: "active",
  nextFireAt: null,
  fireCount: 0,
  revision: 2,
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
  fires: [],
};

function scheduleContext(service: Record<string, unknown>): CommandContext {
  return {
    storage: {
      loadConfig: async () => ({ global: { experimentalScheduling: true } }),
      loadEnvironments: async () => [
        { id: "e1", projectId: "p1" },
        { id: "e2", projectId: "p2" },
      ],
    },
    scheduledJobs: service,
  } as unknown as CommandContext;
}

test("create_scheduled_job keeps its timing keys, request key and the in-process actor", async () => {
  const create = mock(async (..._input: unknown[]) => ({ job: schedule, replayed: false }));
  const coordinator: ScheduleOwner = {
    kind: "coordinator",
    projectId: "p1",
    coordinatorId: "c1",
    conversationId: "v1",
    role: "main",
  };
  const args = {
    requestId: "r1",
    at: "2026-11-08T03:00:00.000Z",
    timeZone: "Europe/London",
    name: "Nightly",
    catchUpMinutes: 5,
    paused: true,
    action: { kind: "action", action: "ping", input: {} },
  };
  const command = createCommandRegistry().get("create_scheduled_job")!;
  await expect(
    command(
      withScheduleActor({ ...args, unknownKey: 1 }, coordinator),
      scheduleContext({ create }),
    ),
  ).resolves.toEqual({ schedule, replayed: false });
  expect(create.mock.calls[0]).toEqual([
    coordinator,
    {
      at: args.at,
      timeZone: args.timeZone,
      name: args.name,
      catchUpMinutes: 5,
      paused: true,
      action: args.action,
    },
    "r1",
  ]);
  // Without an attached actor the caller is the operator, as over the gateway.
  await command(args, scheduleContext({ create }));
  expect(create.mock.calls[1]?.[0]).toEqual({ kind: "operator" });
});

test("update_scheduled_job keeps the schedule, its timing keys and the expected revision", async () => {
  const update = mock(async (..._input: unknown[]) => schedule);
  await createCommandRegistry().get("update_scheduled_job")!(
    { scheduleId: "s1", cron: "0 4 * * *", everySeconds: undefined, expectedRevision: 2, x: 1 },
    scheduleContext({ update }),
  );
  expect(update.mock.calls[0]).toEqual([
    { kind: "operator" },
    "s1",
    { cron: "0 4 * * *", expectedRevision: 2 },
  ]);
});

test("list_scheduled_jobs keeps its filter keys", async () => {
  const list = mock((..._input: unknown[]) => []);
  await createCommandRegistry().get("list_scheduled_jobs")!(
    { projectId: "p1", environmentId: "e1", state: "paused", ownerKind: "agent", x: 1 },
    scheduleContext({ list }),
  );
  expect(list.mock.calls[0]).toEqual([
    { kind: "operator" },
    {
      projectId: "p1",
      environmentId: "e1",
      state: "paused",
      ownerKind: "agent",
      projectEnvironmentIds: new Set(["e1"]),
    },
  ]);
});

test("argument failures keep the handlers' own messages", async () => {
  const registry = createCommandRegistry();
  await expect(
    Promise.resolve().then(() =>
      registry.get("get_environment_disk_usage")!({ environmentId: 7 }, {} as CommandContext),
    ),
  ).rejects.toThrow("Expected environmentId to be a string");
  expect(() =>
    registry.get("set_host_update_channel")!({ channel: "nightly" }, {
      hostMaintenance: {},
    } as unknown as CommandContext),
  ).toThrow("channel must be stable, beta or unstable");
  await expect(
    registry.get("get_scheduled_job")!({}, scheduleContext({})) as Promise<unknown>,
  ).rejects.toThrow("scheduleId is required");
});
