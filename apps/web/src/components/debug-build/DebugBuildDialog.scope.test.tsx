import { afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { NodeScopeProvider, WindowScopeProvider } from "@/lib/node-scope/providers";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { useDebugBuildStore } from "@/stores/debugBuildStore";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { DebugBuildDialogHost } from "./DebugBuildDialog";

const scopes: WindowScope[] = [];
afterEach(() => {
  cleanup();
  useDebugBuildStore.getState().close();
  for (const scope of scopes.splice(0)) scope.dispose();
});

function windowWithLeaf() {
  const windowScope = new WindowScope();
  scopes.push(windowScope);
  const commandClient = new FakeNodeClient({
    nodeId: "bk_command" as BackendId,
    invoke: { create_debug_build: { taskId: "t-c", pipelineId: "p-c", projectId: "project-c" } },
  });
  const command = windowScope.open({ role: "command", client: commandClient });
  const leafClient = new FakeNodeClient({
    nodeId: "bk_leaf" as BackendId,
    invoke: {
      create_debug_build: { taskId: "t-leaf", pipelineId: "p-leaf", projectId: "project-leaf" },
    },
  });
  const leaf = windowScope.open({ role: "leaf", client: leafClient });
  const view = render(
    <WindowScopeProvider windowScope={windowScope}>
      <NodeScopeProvider scope={command}>
        <DebugBuildDialogHost />
      </NodeScopeProvider>
    </WindowScopeProvider>,
  );
  return { windowScope, command, commandClient, leaf, leafClient, view };
}

function openFor(nodeId: string | null) {
  useDebugBuildStore
    .getState()
    .beginCapture({ nodeId, projectId: "project-leaf", environmentId: "env-leaf" });
  useDebugBuildStore.getState().showDialog({ screenshot: null, captureError: null });
}

test("an environment on another node is filed on that node, not the command node", async () => {
  openFor("bk_leaf");
  const { commandClient, leafClient } = windowWithLeaf();
  fireEvent.change(screen.getByLabelText(/Problem \/ objective/), {
    target: { value: "The leaf's preview is blank" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create pipeline environment" }));
  });
  await waitFor(() => expect(leafClient.calls("create_debug_build")).toHaveLength(1));
  expect(leafClient.calls("create_debug_build")[0]!.args).toMatchObject({
    environmentId: "env-leaf",
    problem: "The leaf's preview is blank",
  });
  expect(commandClient.calls("create_debug_build")).toEqual([]);
  await waitFor(() => expect(useDebugBuildStore.getState().open).toBe(false));
});

test("a node that is not in the window is reported, and nothing is sent anywhere", async () => {
  openFor("bk_gone");
  const { commandClient, leafClient } = windowWithLeaf();
  expect(screen.getByRole("alert").textContent).toContain("no longer shown in this window");
  fireEvent.change(screen.getByLabelText(/Problem \/ objective/), { target: { value: "x" } });
  const submit = screen.getByRole("button", { name: "Create pipeline environment" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  await act(async () => {
    fireEvent.click(submit);
  });
  expect(commandClient.calls("create_debug_build")).toEqual([]);
  expect(leafClient.calls("create_debug_build")).toEqual([]);
});

test("a node that leaves while the dialog is open disables submit instead of sending elsewhere", async () => {
  openFor("bk_leaf");
  const { commandClient, leaf, leafClient } = windowWithLeaf();
  fireEvent.change(screen.getByLabelText(/Problem \/ objective/), { target: { value: "x" } });
  await act(async () => {
    leaf.dispose();
  });
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  const submit = screen.getByRole("button", { name: "Create pipeline environment" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  expect(commandClient.calls("create_debug_build")).toEqual([]);
  expect(leafClient.calls("create_debug_build")).toEqual([]);
});
