import { describe, expect, test } from "bun:test";
import type { CommandContext } from "../commands-context.js";
import type { RegistryWriterState } from "../registry-writer-lease.js";
import { SCHEDULE_HANDLERS } from "./actions-schedules.js";
import type { PublicActionContext, ReadActionHandler } from "./types.js";

/**
 * `schedule.list` carries whether this backend fires the schedules it lists,
 * the same `scheduler` answer as `list_scheduled_jobs` (#2280). The end-to-end
 * listing is covered by `public-api-schedules.test.ts`.
 */

const list = SCHEDULE_HANDLERS.find(
  (handler) => handler.action === "schedule.list",
) as ReadActionHandler;

function context(state: RegistryWriterState | undefined): PublicActionContext {
  return {
    authority: "operator",
    command: {
      storage: { loadConfig: async () => ({ global: { experimentalScheduling: true } }) },
      scheduledJobs: { list: () => [] },
      ...(state ? { registryWriterLease: { state: () => state } } : {}),
    } as unknown as CommandContext,
  } as unknown as PublicActionContext;
}

async function listed(state: RegistryWriterState | undefined) {
  const { result } = await list.run(list.parse({}), context(state));
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}

describe("schedule.list scheduler status", () => {
  test.each([
    ["held", { firing: true }],
    ["lost", { firing: false, reason: "writer-lease-lost" }],
    ["busy", { firing: false, reason: "another-backend" }],
    ["schema-incompatible", { firing: false, reason: "newer-data-directory" }],
  ] as const)("a %s writer lease lists with %o", async (state, expected) => {
    expect(await listed(state)).toEqual({
      schedules: [],
      total: 0,
      offset: 0,
      scheduler: expected,
    });
  });

  test("a backend with no writer guard fires", async () => {
    expect((await listed(undefined)).scheduler).toEqual({ firing: true });
  });

  test("a cleanly released lease says nothing either way", async () => {
    expect(await listed("released")).not.toHaveProperty("scheduler");
  });
});
