/**
 * Plan item 5002: for a node shown in the window's own tree the title bar's
 * meters and process popover are ordinary components on that node's scope.
 */
import { afterEach, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WindowScopeProvider } from "@/lib/node-scope/providers";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { useInTreeNodesStore } from "@/stores/inTreeNodesStore";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { NodeTitleBarUsage, useShownInTreeNode } from "./ShownNodeTitleBar";

const LEAF_A = "bk_leaf-a" as BackendId;
const LEAF_B = "bk_leaf-b" as BackendId;
const windows: WindowScope[] = [];

function usage(cpuPercent: number) {
  return {
    cpuPercent,
    ramPercent: 40,
    gpuPercent: null,
    diskPercent: 50,
    sampledAt: new Date().toISOString(),
  };
}

function windowWithLeaves() {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  const command = new FakeNodeClient({
    nodeId: "bk_command" as BackendId,
    invoke: { get_system_usage: usage(99), get_environment_process_usage: null },
  });
  const a = new FakeNodeClient({
    nodeId: LEAF_A,
    invoke: {
      get_system_usage: usage(11),
      get_environment_process_usage: { environments: [], sampledAt: new Date().toISOString() },
    },
  });
  const b = new FakeNodeClient({
    nodeId: LEAF_B,
    invoke: { get_system_usage: usage(22) },
  });
  windowScope.open({ role: "command", client: command });
  const scopeA = windowScope.open({ role: "leaf", client: a });
  const scopeB = windowScope.open({ role: "leaf", client: b });
  return { windowScope, command, a, b, scopeA, scopeB };
}

/** What `AppShell` does: the shown node's meters while it is in the window's tree. */
function TitleBarMeters({ nodeId }: { nodeId: string | null }) {
  const shown = useShownInTreeNode(nodeId);
  return shown ? <NodeTitleBarUsage scope={shown.scope} /> : <div data-testid="own-meters" />;
}

afterEach(() => {
  cleanup();
  for (const windowScope of windows.splice(0)) windowScope.dispose();
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
  resetReadCoordinatorForTests();
});

function cpuReading() {
  return screen.getByRole("img", { name: /Central processing unit \(CPU\) usage/ }).textContent;
}

test("the meters read the shown in-tree node's scope and switch with the shown node", async () => {
  const { windowScope, command, a, b } = windowWithLeaves();
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
  const view = render(
    <WindowScopeProvider windowScope={windowScope}>
      <TitleBarMeters nodeId={LEAF_A} />
    </WindowScopeProvider>,
  );
  await waitFor(() => expect(cpuReading()).toBe("11%"));
  expect(a.calls("get_system_usage").length).toBeGreaterThan(0);

  view.rerender(
    <WindowScopeProvider windowScope={windowScope}>
      <TitleBarMeters nodeId={LEAF_B} />
    </WindowScopeProvider>,
  );
  await waitFor(() => expect(cpuReading()).toBe("22%"));
  expect(b.calls("get_system_usage").length).toBeGreaterThan(0);
  // Nothing was read through the command node for either leaf.
  expect(command.calls("get_system_usage")).toEqual([]);

  // A node the window shows by a realm keeps the window's other path.
  act(() => useInTreeNodesStore.setState({ useRealmsForRemoteMachines: true }));
  expect(screen.getByTestId("own-meters")).toBeTruthy();
});

test("while the in-tree node's scope opens the meters read nothing and show dashes", () => {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  windowScope.open({
    role: "command",
    client: new FakeNodeClient({ nodeId: "bk_command" as BackendId }),
  });
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
  render(
    <WindowScopeProvider windowScope={windowScope}>
      <TitleBarMeters nodeId={LEAF_A} />
    </WindowScopeProvider>,
  );
  expect(screen.getByTestId("node-system-usage-opening")).toBeTruthy();
  expect(cpuReading()).toBe("—");
});

test("the process popover is the node's, and focus returns to its trigger on dismissal", async () => {
  const { windowScope, a } = windowWithLeaves();
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
  render(
    <WindowScopeProvider windowScope={windowScope}>
      <TitleBarMeters nodeId={LEAF_A} />
    </WindowScopeProvider>,
  );
  await waitFor(() => expect(cpuReading()).toBe("11%"));
  const trigger = screen.getByRole("button", { name: "Open environment process usage" });
  fireEvent.click(trigger);
  const popover = screen.getByRole("dialog", { name: "Environment process usage" });
  expect(popover.getAttribute("aria-hidden")).toBe("false");
  await screen.findByText("No running environment processes");
  expect(a.calls("get_environment_process_usage").length).toBeGreaterThan(0);

  // Escape closes it where it sits and gives focus back to the meters.
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(popover.getAttribute("aria-hidden")).toBe("true"));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Open environment process usage" }),
  );

  // So does its close button.
  fireEvent.click(screen.getByRole("button", { name: "Open environment process usage" }));
  const close = screen
    .getAllByRole("button", { name: "Close environment process usage" })
    .find((button) => popover.contains(button))!;
  fireEvent.click(close);
  await waitFor(() => expect(popover.getAttribute("aria-hidden")).toBe("true"));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Open environment process usage" }),
  );
});
