import { expect, mock, test } from "bun:test";
import {
  isNodeExcludedCommand,
  isWorkspaceExcludedCommand,
  NodeOutcomeLedger,
  MAX_NODE_OUTCOMES,
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

test("a coordinator's mailed images are its own node's to send, and node-link only to receive", () => {
  expect(isNodeExcludedCommand("transfer_coordinator_attachments")).toBe(true);
  for (const command of ["prepare_node_mail_attachments", "place_node_mail_attachments"]) {
    expect(isNodeExcludedCommand(command)).toBe(false);
    expect(isWorkspaceExcludedCommand(command)).toBe(true);
  }
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
    "restart_controller_build_pipeline_step",
  ]) {
    expect(isNodeExcludedCommand(command)).toBe(false);
    expect(isWorkspaceExcludedCommand(command)).toBe(true);
  }
});

test("worker turn controls are node-link only on the leaf and never leave the command node", () => {
  for (const command of [
    "stop_controller_worker_turn",
    "list_controller_worker_commands",
    "run_controller_worker_command",
  ]) {
    expect(isNodeExcludedCommand(command)).toBe(false);
    expect(isWorkspaceExcludedCommand(command)).toBe(true);
  }
  for (const command of [
    "stop_coordinator_worker_turn",
    "list_coordinator_worker_commands",
    "run_coordinator_worker_command",
  ])
    expect(isNodeExcludedCommand(command)).toBe(true);
});

test("setup approval: the fan-out stays on the command node, each node's record is node-link only", () => {
  expect(isNodeExcludedCommand("approve_setup_commands_on_nodes")).toBe(true);
  expect(isWorkspaceExcludedCommand("approve_setup_commands_on_nodes")).toBe(true);
  expect(isNodeExcludedCommand("approve_project_setup_commands")).toBe(false);
  expect(isWorkspaceExcludedCommand("approve_project_setup_commands")).toBe(true);
  // The user approving in a leaf's realm acts on that leaf through their grant.
  expect(isWorkspaceExcludedCommand("approve_environment_setup")).toBe(false);
});

test("workspace Stop is allowed locally while peer routing and controller stop stay fenced", async () => {
  expect(isWorkspaceExcludedCommand("stop_coordinator_worker_turn")).toBe(false);
  expect(isWorkspaceExcludedCommand("stop_controller_worker_turn")).toBe(true);
  const invoke = mock(async () => ({}));
  await expect(
    routeToNode({
      nodeId: "bk_leaf" as never,
      link: { connected: true, invoke: invoke as never },
      command: "stop_coordinator_worker_turn",
      args: {},
      outcomes: new NodeOutcomeLedger(),
    }),
  ).rejects.toThrow("cannot be run on another node");
  expect(invoke).not.toHaveBeenCalled();
});

test("outcome notifications name both affected nodes on eviction and skip no-op mutations", async () => {
  const changed = mock((_nodeId: string) => {});
  const ledger = new NodeOutcomeLedger(undefined, changed);
  const entry = { nodeId: "bk_old" as never, command: "stop_environment", requestKey: "first" };
  const first = await ledger.record(entry);
  await ledger.record(entry);
  expect(changed).toHaveBeenCalledTimes(1);
  for (let i = 1; i < MAX_NODE_OUTCOMES; i++) {
    await ledger.record({ ...entry, nodeId: "bk_new" as never, requestKey: String(i) });
  }
  changed.mockClear();
  await ledger.record({ ...entry, nodeId: "bk_new" as never, requestKey: "overflow" });
  expect(changed.mock.calls.map(([nodeId]) => nodeId)).toEqual(["bk_new", "bk_old"]);
  expect(await ledger.dismiss(first.outcomeId)).toBe(false);
  expect(changed).toHaveBeenCalledTimes(2);
  const remaining = ledger.list()[0]!;
  expect(await ledger.dismiss(remaining.outcomeId)).toBe(true);
  expect(changed.mock.calls.at(-1)).toEqual(["bk_new"]);
});
