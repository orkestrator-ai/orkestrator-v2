import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { portalStore } from "@/lib/portal/portal-store";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { AccountMachineScope, useAccountMachine, useAccountMachineStore } from "./account-machine";
import type { NodeSummary } from "@orkestrator/protocol/node-summaries";

const originalPortal = portalStore.getState();
const originalRemote = useRemoteWorkspaceStore.getState();
let start: ReturnType<typeof spyOn>;
function node(id: string, name: string, state = "connected"): NodeSummary {
  return {
    nodeId: id,
    view: { displayName: name, colorToken: "teal", connection: { state } },
    projects: [],
    environments: [],
    freshness: "current",
    loadedAt: 1,
    truncated: false,
  } as unknown as NodeSummary;
}
beforeEach(() => {
  start = spyOn(portalStore, "start").mockImplementation(() => () => {});
  portalStore.store.setState({
    selfId: "self" as never,
    self: null,
    nodes: [node("leaf", "Leaf"), node("off", "Offline", "unavailable")],
  });
  useAccountMachineStore.getState().choose(undefined);
  useRemoteWorkspaceStore.setState({
    active: { nodeId: "leaf", projectId: null, environmentId: null },
  });
});
afterEach(() => {
  cleanup();
  start.mockRestore();
  portalStore.store.setState(originalPortal, true);
  useRemoteWorkspaceStore.setState(originalRemote, true);
  useAccountMachineStore.getState().choose(undefined);
});

function LoginProbe() {
  const { machine } = useAccountMachine();
  const [pending, setPending] = useState(false);
  return (
    <>
      <p>Target: {machine ?? "command"}</p>
      <button onClick={() => setPending(true)}>
        {pending ? "Pending sign-in" : "Start sign-in"}
      </button>
    </>
  );
}
function Scope() {
  return (
    <FederationProvider>
      <AccountMachineScope>
        <LoginProbe />
      </AccountMachineScope>
    </FederationProvider>
  );
}

test("defaults to the current leaf and allows explicit command-node selection", async () => {
  render(<Scope />);
  expect(screen.getByText("Target: leaf")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Machine" }), { key: "Enter" });
  const options = screen.getAllByRole("option");
  const command = options.find(
    (option) => !option.textContent?.includes("Leaf") && !option.textContent?.includes("Offline"),
  )!;
  await act(async () => {
    fireEvent.click(command);
  });
  expect(useAccountMachineStore.getState().chosen).toBeNull();
  expect(screen.getByText("Target: command")).toBeTruthy();
});

test("switching machines remounts pending sign-in state and disables offline choices", async () => {
  render(<Scope />);
  fireEvent.click(screen.getByRole("button", { name: "Start sign-in" }));
  expect(screen.getByRole("button", { name: "Pending sign-in" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Machine" }), { key: "Enter" });
  expect(
    screen.getByRole("option", { name: /Offline/ }).getAttribute("data-disabled"),
  ).not.toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("option", { name: "This machine" })));
  expect(screen.getByText("Target: command")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start sign-in" })).toBeTruthy();
});

test("unknown selections and a single-machine federation fall back to the command node", async () => {
  useAccountMachineStore.getState().choose("missing");
  const view = render(<Scope />);
  expect(screen.getByText("Target: command")).toBeTruthy();
  await act(async () => portalStore.store.setState({ nodes: [] }));
  expect(screen.queryByRole("combobox") === null).toBe(true);
  expect(screen.getByText("Target: command")).toBeTruthy();
  view.unmount();
  render(
    <AccountMachineScope>
      <LoginProbe />
    </AccountMachineScope>,
  );
  expect(screen.getByText("Target: command")).toBeTruthy();
});
