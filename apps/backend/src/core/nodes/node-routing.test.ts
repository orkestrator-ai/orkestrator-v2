import { expect, mock, test } from "bun:test";
import {
  isNodeExcludedCommand,
  isWorkspaceExcludedCommand,
  NodeOutcomeLedger,
  routeToNode,
} from "./node-routing.js";

test.each([
  "create_control_mcp_credential",
  "rotate_control_mcp_credential",
  "revoke_control_mcp_credential",
])("%s never crosses a grant, relay or peer-node boundary", async (command) => {
  expect(isNodeExcludedCommand(command)).toBe(true);
  expect(isWorkspaceExcludedCommand(command)).toBe(true);
  const invoke = mock(async <T>() => ({ token: "must-not-return" }) as T);
  await expect(
    routeToNode({
      nodeId: "bk_leaf" as never,
      link: { connected: true, invoke: async <T>() => (await invoke()) as T },
      command,
      args: {},
      outcomes: new NodeOutcomeLedger(),
    }),
  ).rejects.toThrow("cannot be run on another node");
  expect(invoke).not.toHaveBeenCalled();
});

test("controller PR publication is node-link only, never workspace-grant access", () => {
  expect(isNodeExcludedCommand("create_controller_pr")).toBe(false);
  expect(isWorkspaceExcludedCommand("create_controller_pr")).toBe(true);
  expect(isNodeExcludedCommand("create_coordinator_pr")).toBe(true);
  expect(isNodeExcludedCommand("resolve_controller_conflicts")).toBe(false);
  expect(isWorkspaceExcludedCommand("resolve_controller_conflicts")).toBe(true);
  expect(isNodeExcludedCommand("resolve_coordinator_conflicts")).toBe(true);
});

test("controller worker surfaces are node-link only, never workspace-grant access", () => {
  for (const command of [
    "launch_controller_terminal",
    "open_controller_browser",
    "edit_controller_worker_tab",
  ]) {
    expect(isNodeExcludedCommand(command)).toBe(false);
    expect(isWorkspaceExcludedCommand(command)).toBe(true);
  }
});
