import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { portalStore } from "@/lib/portal/portal-store";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { AccountMachineScope, useAccountMachine, useAccountMachineStore } from "./account-machine";
import { TerminalProvider } from "@/contexts/TerminalContext";
import { useActionBarController } from "@/components/layout/useActionBarController";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const initialPortal = portalStore.getState();
const initialRemote = useRemoteWorkspaceStore.getState();
let nodes: typeof initialPortal.nodes;
function Child() {
  const target = useAccountMachine();
  const [pending, setPending] = useState(false);
  return (
    <div>
      <output data-testid="target">{JSON.stringify(target)}</output>
      <button onClick={() => setPending(true)}>
        {pending ? "Pending sign-in" : "Start fixture sign-in"}
      </button>
    </div>
  );
}
function mount() {
  return render(
    <FederationProvider>
      <AccountMachineScope>
        <Child />
      </AccountMachineScope>
    </FederationProvider>,
  );
}
function target() {
  return JSON.parse(screen.getByTestId("target").textContent!) as {
    machine: string | null;
    name: string | null;
  };
}
beforeEach(() => {
  nodes = ["leaf", "offline"].map((nodeId) => ({
    nodeId,
    view: {
      displayName: nodeId === "leaf" ? "Leaf" : "Offline",
      connection: { state: nodeId === "offline" ? "unavailable" : "connected" },
    },
    projects: [],
    environments: [],
    freshness: "current",
  })) as never;
  portalStore.store.setState({ ...initialPortal, selfId: "command" as never, nodes });
  useRemoteWorkspaceStore.setState({
    active: { nodeId: "leaf", projectId: null, environmentId: null },
  });
  useAccountMachineStore.getState().choose(undefined);
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "get_backend_profile")
      return { revision: 1, displayName: "Command", colorToken: "blue", updatedAt: "" };
    if (command === "get_node_summaries") return { selfId: "command", nodes };
    if (command === "get_node_status") return { nodeId: "command" };
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  portalStore.store.setState(initialPortal);
  useRemoteWorkspaceStore.setState(initialRemote);
  useAccountMachineStore.getState().choose(undefined);
  invokeMock.mockReset();
});

test("defaults to the machine on screen and preserves an explicit command-node selection", async () => {
  mount();
  await waitFor(() => expect(target()).toEqual({ machine: "leaf", name: "Leaf" }));
  act(() => useAccountMachineStore.getState().choose(null));
  expect(target()).toEqual({ machine: null, name: "Command" });
});

test("unknown choices fall back to command; offline choices stay scoped and cannot be newly selected", async () => {
  mount();
  await screen.findByRole("combobox", { name: "Machine" });
  act(() => useAccountMachineStore.getState().choose("missing"));
  await waitFor(() => expect(target().machine).toBeNull());
  act(() => useAccountMachineStore.getState().choose("offline"));
  expect(target()).toEqual({ machine: "offline", name: "Offline" });
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Machine" }), { key: "Enter" });
  expect(screen.getByRole("option", { name: /Offline/ }).getAttribute("aria-disabled")).toBe(
    "true",
  );
});

test("changing machines discards pending local sign-in UI and restores no stale child state", async () => {
  mount();
  await waitFor(() => expect(target().machine).toBe("leaf"));
  fireEvent.click(screen.getByRole("button", { name: "Start fixture sign-in" }));
  expect(screen.getByRole("button", { name: "Pending sign-in" })).toBeTruthy();
  act(() => useAccountMachineStore.getState().choose(null));
  expect(screen.getByRole("button", { name: "Start fixture sign-in" })).toBeTruthy();
  act(() => useAccountMachineStore.getState().choose("leaf"));
  expect(screen.getByRole("button", { name: "Start fixture sign-in" })).toBeTruthy();
});

test("single-machine settings hide the picker", async () => {
  nodes = [];
  portalStore.store.setState({ nodes });
  mount();
  await waitFor(() => expect(target()).toEqual({ machine: null, name: null }));
  expect(screen.queryByRole("combobox", { name: "Machine" }) === null).toBe(true);
});

test("closing Settings resets its selection so the next visit follows the on-screen machine", async () => {
  const { result } = renderHook(() => useActionBarController({ presentation: "bar" }), {
    wrapper: TerminalProvider,
  });
  act(() => {
    result.current.setGlobalSettingsOpen(true);
    useAccountMachineStore.getState().choose(null);
  });
  expect(useAccountMachineStore.getState().chosen).toBeNull();
  act(() => result.current.setGlobalSettingsOpen(false));
  expect(useAccountMachineStore.getState().chosen).toBeUndefined();
});
