import { registrarFrom } from "./commands-registry-contracts.js";
import { expect, mock, test } from "bun:test";
import {
  emptyPortalLayout,
  PORTAL_LAYOUT_CHANGED_EVENT,
} from "@orkestrator/protocol/portal-layout";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerNodeCommands } from "./commands-registry-nodes.js";
import { eventSink } from "./backend-emit.js";

function setup() {
  const handlers = new Map<string, CommandHandler>();
  registerNodeCommands(
    registrarFrom((name, handler) => {
      handlers.set(name, handler);
    }),
  );
  const layout = { ...emptyPortalLayout(), revision: 1, machineOrder: ["bk_a"] };
  const updatePortalLayout = mock(async () => layout);
  const getPortalLayout = mock(async () => layout);
  const emit = mock((_event: string, _payload: unknown) => {});
  const context = {
    storage: {
      nodes: {
        updatePortalLayout,
        getPortalLayout,
      },
    },
    emit: eventSink(emit),
  } as unknown as CommandContext;
  return { handlers, context, layout, updatePortalLayout, getPortalLayout, emit };
}

test("portal layout update validates arguments before storage or event publication", async () => {
  const { handlers, context, updatePortalLayout, emit } = setup();
  for (const input of [{ machineOrder: "wrong" }, { projectFolders: { malformed: 42 } }]) {
    await expect(handlers.get("update_portal_layout")!(input, context)).rejects.toThrow();
  }
  expect(updatePortalLayout).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
});

test("successful portal layout mutation publishes the authoritative stored revision", async () => {
  const { handlers, context, layout, updatePortalLayout, emit } = setup();
  expect(await handlers.get("update_portal_layout")!({ machineOrder: ["bk_a"] }, context)).toEqual(
    layout,
  );
  expect(updatePortalLayout).toHaveBeenCalledWith({ machineOrder: ["bk_a"] });
  expect(emit).toHaveBeenCalledWith(PORTAL_LAYOUT_CHANGED_EVENT, layout);
  updatePortalLayout.mockRejectedValueOnce(new Error("storage failed"));
  await expect(
    handlers.get("update_portal_layout")!({ machineOrder: [] }, context),
  ).rejects.toThrow("storage failed");
  expect(emit).toHaveBeenCalledTimes(1);
});

// The node commands are defined (plan item 7009): unknown keys are dropped, not refused.
test("portal layout update drops unknown keys before parsing", async () => {
  const { handlers, context, updatePortalLayout } = setup();
  await handlers.get("update_portal_layout")!({ machineOrder: ["bk_a"], revision: 1 }, context);
  expect(updatePortalLayout).toHaveBeenCalledWith({ machineOrder: ["bk_a"] });
});

test("portal layout read drops unexpected arguments", async () => {
  const { handlers, context, layout } = setup();
  expect(await handlers.get("get_portal_layout")!({ extra: true }, context)).toEqual(layout);
  expect(await handlers.get("get_portal_layout")!({}, context)).toEqual(layout);
});

test("setup fan-out validates arguments before accessing the portal", async () => {
  const { handlers, context } = setup();
  for (const input of [
    {},
    { nodeId: 1, projectId: "p", hash: "a".repeat(64) },
    { nodeId: "bk_a", projectId: false, hash: "a".repeat(64) },
    { nodeId: "bk_a", projectId: "p", hash: null },
  ]) {
    await expect(
      handlers.get("approve_setup_commands_on_nodes")!(input, context),
    ).rejects.toThrow();
  }
});

test("invoke_on_node passes the call's signal to the portal, and nothing without one", async () => {
  const { handlers } = setup();
  const invokeOnNode = mock(async () => ({ outcome: "ok", result: 1 }));
  const context = { nodePortal: { invokeOnNode } } as unknown as CommandContext;
  const args = { nodeId: "bk_leaf", command: "get_machine_load", args: {} };
  const signal = new AbortController().signal;
  await handlers.get("invoke_on_node")!(args, context, { signal });
  await handlers.get("invoke_on_node")!(args, context);
  expect(invokeOnNode.mock.calls as unknown[][]).toEqual([[args, { signal }], [args]]);
});
