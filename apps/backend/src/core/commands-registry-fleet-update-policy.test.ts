import { expect, mock, test } from "bun:test";
import { DEFAULT_FLEET_UPDATE_POLICY } from "@orkestrator/protocol/fleet-currency";
import { registrarFrom } from "./commands-registry-contracts.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerHostMaintenanceCommands } from "./commands-registry-host.js";
import { isNodeRoutingExcludedCommand } from "./nodes/node-routing.js";
import { grantAdmits } from "./nodes/workspace-grant-test-support.js";

/** Plan item 5006: the command node's update policy commands. */

function setup() {
  const handlers = new Map<string, CommandHandler>();
  registerHostMaintenanceCommands(
    registrarFrom((name, handler) => {
      handlers.set(name, handler);
    }),
  );
  const policy = mock(async () => DEFAULT_FLEET_UPDATE_POLICY);
  const setChannel = mock(async (channel: string, enabled: boolean) => ({
    version: 1,
    channels: { ...DEFAULT_FLEET_UPDATE_POLICY.channels, [channel]: enabled },
  }));
  const context = {
    nodePortal: { fleetUpdates: { policy, setChannel } },
  } as unknown as CommandContext;
  return { handlers, context, policy, setChannel };
}

test("the update policy reads off by default and changes one channel", async () => {
  const { handlers, context, setChannel } = setup();
  expect(await handlers.get("get_fleet_update_policy")!({}, context)).toEqual(
    DEFAULT_FLEET_UPDATE_POLICY,
  );
  expect(
    await handlers.get("set_fleet_update_policy")!({ channel: "beta", enabled: true }, context),
  ).toEqual({ version: 1, channels: { stable: false, beta: true, unstable: false } });
  expect(setChannel).toHaveBeenCalledWith("beta", true);
});

test("a bad channel or flag is refused before it reaches the policy", async () => {
  const { handlers, context, setChannel } = setup();
  for (const args of [
    { channel: "nightly", enabled: true },
    { channel: "stable", enabled: "yes" },
    { channel: "stable" },
  ]) {
    await expect(
      Promise.resolve().then(() => handlers.get("set_fleet_update_policy")!(args, context)),
    ).rejects.toThrow();
  }
  expect(setChannel).not.toHaveBeenCalled();
});

test("a backend without the command-node portal says so", async () => {
  const { handlers } = setup();
  await expect(
    Promise.resolve().then(() =>
      handlers.get("get_fleet_update_policy")!({}, {} as unknown as CommandContext),
    ),
  ).rejects.toThrow("The command-node portal is not available in this backend.");
});

test("the update policy belongs to the command node: never routed to a node or a workspace", () => {
  for (const command of ["get_fleet_update_policy", "set_fleet_update_policy"]) {
    expect(isNodeRoutingExcludedCommand(command)).toBe(true);
    expect(grantAdmits(command)).toBe(false);
  }
});
