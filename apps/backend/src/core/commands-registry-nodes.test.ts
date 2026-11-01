import { expect, mock, test } from "bun:test";
import {
  emptyPortalLayout,
  PORTAL_LAYOUT_CHANGED_EVENT,
} from "@orkestrator/protocol/portal-layout";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerNodeCommands } from "./commands-registry-nodes.js";

function setup() {
  const handlers = new Map<string, CommandHandler>();
  registerNodeCommands((name, handler) => {
    handlers.set(name, handler);
  });
  const layout = { ...emptyPortalLayout(), revision: 1, machineOrder: ["bk_a"] };
  const updatePortalLayout = mock(async () => layout);
  const getPortalLayout = mock(async () => layout);
  const emit = mock(() => {});
  const context = {
    storage: {
      nodes: {
        updatePortalLayout,
        getPortalLayout,
      },
    },
    emit,
  } as unknown as CommandContext;
  return { handlers, context, layout, updatePortalLayout, getPortalLayout, emit };
}

test("portal layout update validates arguments before storage or event publication", async () => {
  const { handlers, context, updatePortalLayout, emit } = setup();
  for (const input of [
    { unknown: true },
    { machineOrder: "wrong" },
    { projectFolders: { malformed: 42 } },
    { revision: 1 },
  ]) {
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

test("portal layout read rejects unexpected arguments", async () => {
  const { handlers, context, getPortalLayout, layout } = setup();
  await expect(handlers.get("get_portal_layout")!({ extra: true }, context)).rejects.toThrow();
  expect(getPortalLayout).not.toHaveBeenCalled();
  expect(await handlers.get("get_portal_layout")!({}, context)).toEqual(layout);
});

test("setup fan-out validates arguments before accessing the portal", async () => {
  const { handlers, context } = setup();
  for (const input of [
    {},
    { nodeId: 1, projectId: "p", hash: "a".repeat(64) },
    { nodeId: "bk_a", projectId: false, hash: "a".repeat(64) },
    { nodeId: "bk_a", projectId: "p", hash: null },
    { nodeId: "bk_a", projectId: "p", hash: "a".repeat(64), extra: true },
  ]) {
    await expect(
      handlers.get("approve_setup_commands_on_nodes")!(input, context),
    ).rejects.toThrow();
  }
});
