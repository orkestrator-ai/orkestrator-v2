import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { PROJECT_COPY_CHANGED_EVENT } from "@orkestrator/protocol/project-copy";
import type { BackendId } from "@orkestrator/protocol/federation";
import { listMachineAgentAccounts } from "@/lib/backend/agent-accounts";
import { loadHandoverPlan } from "@/lib/command-handover";
import { invoke } from "@/lib/native/backend";
import { listen } from "@/lib/native/events";
import { appCommandScope } from "@/lib/node-scope-slots";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { invokeGlobalConfigCommand, settingsParent } from "./command-node-config";
import { commandScopeListen } from "./command-scope";
import { getFleetUpdatePolicy } from "./fleet-update-policy";
import { getPortalLayout, startPortalLayout } from "./portal-layout";
import {
  dismissNodeOutcome,
  listNodeActionRequests,
  listNodeOutcomes,
  portalStore,
  resolveNodeActionRequest,
} from "./portal-store";
import {
  copyProjectToNode,
  getProjectCopyOptions,
  listenProjectCopies,
  listProjectCopies,
} from "./project-copy";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const listenMock = listen as unknown as ReturnType<typeof mock>;
const initialPortal = portalStore.getState();
const NODE_ACTION_REQUESTS_CHANGED_EVENT = "node-action-requests-changed";

/**
 * Counts every read of `window.orkestratorPortal`, the portal global earlier
 * releases' separate workspace documents had (a presence check is a read too).
 */
function watchPortalGlobal(value: unknown = undefined) {
  let reads = 0;
  Object.defineProperty(window, "orkestratorPortal", {
    configurable: true,
    get() {
      reads += 1;
      return value;
    },
  });
  return { reads: () => reads };
}

function answerAsCommandNode(command: string, args?: Record<string, unknown>): unknown {
  switch (command) {
    case "get_node_status":
      return { nodeId: "bk_command", mode: "command", controllers: [] };
    case "get_node_summaries":
      return { selfId: "bk_command", nodes: [] };
    case "list_node_action_requests":
    case "list_node_outcomes":
    case "list_project_copies":
      return [];
    case "get_portal_layout":
      return { revision: 3, machineOrder: ["bk_leaf"] };
    case "get_fleet_update_policy":
      return { channels: {} };
    case "preview_command_handover":
      return { nodeId: args?.nodeId, machines: [] };
    case "get_config":
      return { global: {}, repositories: {} };
    case "copy_project_to_node":
      return { copyId: "copy-1", stage: "queued", ...args };
    default:
      return {};
  }
}

beforeEach(() => {
  resetWindowScopeForTests();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
    answerAsCommandNode(command, args),
  );
  listenMock.mockClear();
});

afterEach(() => {
  delete (window as { orkestratorPortal?: unknown }).orkestratorPortal;
  resetWindowScopeForTests();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  listenMock.mockImplementation(() => Promise.resolve(() => {}));
  portalStore.store.setState(initialPortal);
});

/** Every portal API once, as the sidebar, Settings and the dialogs call them. */
async function callEveryPortalApi() {
  await portalStore.refresh();
  await listNodeActionRequests();
  await resolveNodeActionRequest("request-1", "approve");
  await listNodeOutcomes("bk_leaf");
  await dismissNodeOutcome("outcome-1");
  await getProjectCopyOptions("bk_leaf", "project-1");
  await listProjectCopies();
  (await listenProjectCopies(() => undefined))();
  const stopLayout = startPortalLayout();
  await new Promise((resolve) => setTimeout(resolve, 0));
  stopLayout();
  await getFleetUpdatePolicy();
  await loadHandoverPlan({ nodeId: "bk_leaf", name: "Leaf" } as never).catch(() => undefined);
  await invokeGlobalConfigCommand("get_config", undefined, null);
  await listMachineAgentAccounts();
  await portalStore.invokeOnNode("bk_leaf" as BackendId, "get_backend_profile");
  (await commandScopeListen(NODE_ACTION_REQUESTS_CHANGED_EVENT, () => undefined))();
}

describe("portal APIs are command-scope calls (plan item 5004)", () => {
  test("an app window never reads the portal global; every portal API calls its command scope", async () => {
    const portal = watchPortalGlobal({ invoke: mock(), listen: mock() });
    await callEveryPortalApi();
    expect(settingsParent(appCommandScope())).toBeNull();
    expect(portal.reads()).toBe(0);
    const commands = invokeMock.mock.calls.map(([command]) => command);
    for (const command of [
      "get_node_status",
      "get_node_summaries",
      "list_node_action_requests",
      "resolve_node_action_request",
      "list_node_outcomes",
      "dismiss_node_outcome",
      "get_project_copy_options",
      "list_project_copies",
      "get_portal_layout",
      "get_fleet_update_policy",
      "preview_command_handover",
      "get_config",
      "list_machine_agent_accounts",
      "invoke_on_node",
    ])
      expect(commands).toContain(command);
    expect(listenMock.mock.calls.map(([event]) => event)).toEqual(
      expect.arrayContaining([PROJECT_COPY_CHANGED_EVENT, NODE_ACTION_REQUESTS_CHANGED_EVENT]),
    );
    expect(getPortalLayout().machineOrder).toEqual(["bk_leaf"]);
  });

  test("a node shown in the window's tree reaches the same command scope, never the portal global", async () => {
    const portal = watchPortalGlobal({ invoke: mock(), listen: mock() });
    const leafClient = new FakeNodeClient({ nodeId: "bk_leaf" as BackendId });
    const leaf = getWindowScope().open({ role: "leaf", client: leafClient });
    expect(settingsParent(leaf)?.scope).toBe(appCommandScope());
    await callEveryPortalApi();
    expect(portal.reads()).toBe(0);
    expect(leafClient.invocations).toEqual([]);
  });

  test("a project is copied across nodes through the command scope", async () => {
    watchPortalGlobal();
    const input = {
      requestKey: "copy-key",
      source: { nodeId: "bk_laptop", projectId: "project-1" },
      target: { nodeId: "bk_server", location: "/srv/app" },
      paths: [".env"],
      rememberFiles: true,
    };
    const record = await copyProjectToNode(input);
    expect(invokeMock).toHaveBeenCalledWith("copy_project_to_node", input);
    expect(record).toMatchObject({ copyId: "copy-1", source: input.source, target: input.target });
  });
});
