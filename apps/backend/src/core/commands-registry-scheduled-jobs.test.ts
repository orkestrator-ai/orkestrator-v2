import { describe, expect, test } from "bun:test";
import type { CommandContext } from "./commands-context.js";
import { registrarFrom } from "./commands-registry-contracts.js";
import {
  registerScheduledJobCommands,
  schedulerStatus,
} from "./commands-registry-scheduled-jobs.js";
import type { RegistryWriterState } from "./registry-writer-lease.js";

type Handler = (args: Record<string, unknown>, context: CommandContext) => Promise<unknown>;

function commands(): Map<string, Handler> {
  const registered = new Map<string, Handler>();
  // The commands are defined (plan item 7009): the registrar decodes their arguments.
  registerScheduledJobCommands(
    registrarFrom((name, handler) => registered.set(name, handler as Handler)),
  );
  return registered;
}

function context(state: RegistryWriterState | undefined): CommandContext {
  return {
    storage: {
      loadConfig: async () => ({ global: { experimentalScheduling: true } }),
    },
    scheduledJobs: { list: () => [] },
    ...(state ? { registryWriterLease: { state: () => state } } : {}),
  } as unknown as CommandContext;
}

describe("schedulerStatus", () => {
  test.each([
    ["held", { firing: true }],
    ["lost", { firing: false, reason: "writer-lease-lost" }],
    ["released", undefined],
    ["busy", { firing: false, reason: "another-backend" }],
    ["schema-incompatible", { firing: false, reason: "newer-data-directory" }],
  ] as const)("a %s writer lease answers %o", (state, expected) => {
    expect(schedulerStatus({ state: () => state })).toEqual(expected);
  });

  test("a backend with no writer guard fires, as its scheduler does", () => {
    expect(schedulerStatus(undefined)).toEqual({ firing: true });
  });
});

describe("list_scheduled_jobs", () => {
  test("says whether this backend fires the schedules it lists", async () => {
    const list = commands().get("list_scheduled_jobs")!;
    expect(await list({}, context("lost"))).toMatchObject({
      schedules: [],
      scheduler: { firing: false, reason: "writer-lease-lost" },
    });
    expect(JSON.parse(JSON.stringify(await list({}, context("released"))))).not.toHaveProperty(
      "scheduler",
    );
    expect(await list({}, context("held"))).toMatchObject({ scheduler: { firing: true } });
    expect(await list({}, context(undefined))).toMatchObject({ scheduler: { firing: true } });
  });
});
