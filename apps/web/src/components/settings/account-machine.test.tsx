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
import {
  useAccountMachine,
  useAccountMachineStore,
  useResolvedAccountMachine,
} from "./account-machine";
import { MachineSettings } from "./SettingsPage";
import { SettingsMachineStrip } from "./SettingsMachineStrip";
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
/** Settings' header strip and a section, as the Settings page wires them. */
function Harness({ locked = false }: { locked?: boolean }) {
  const resolved = useResolvedAccountMachine();
  const choose = useAccountMachineStore((state) => state.choose);
  const machine = locked ? null : resolved.machine;
  const option = resolved.options.find((candidate) => candidate.nodeId === machine);
  return (
    <>
      {resolved.options.length > 1 ? (
        <SettingsMachineStrip
          options={resolved.options}
          selected={resolved.machine}
          locked={locked}
          onSelect={choose}
        />
      ) : null}
      <MachineSettings key={machine ?? "command-node"} machine={machine} option={option}>
        <Child />
      </MachineSettings>
    </>
  );
}
function mount(locked = false) {
  return render(
    <FederationProvider>
      <Harness locked={locked} />
    </FederationProvider>,
  );
}
function chip(name: RegExp) {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
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
    // Settings reads the machine it edits.
    if (command === "get_config") return { version: "1", global: {}, repositories: {} };
    if (command === "invoke_on_node") {
      return { outcome: "ok", result: { version: "1", global: {}, repositories: {} } };
    }
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

test("the strip leads with the command node and picks a machine by its chip", async () => {
  mount();
  await waitFor(() => expect(target().machine).toBe("leaf"));
  const names = screen
    .getAllByRole("button")
    .filter((button) => button.hasAttribute("aria-pressed"))
    .map((button) => button.textContent);
  expect(names).toEqual(["Command(command node)", "Leaf", "Offline"]);
  expect(chip(/^Leaf/).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(chip(/^Command/));
  expect(useAccountMachineStore.getState().chosen).toBeNull();
  expect(target()).toEqual({ machine: null, name: "Command" });
  expect(chip(/^Command/).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(chip(/^Leaf/));
  await waitFor(() => expect(target()).toEqual({ machine: "leaf", name: "Leaf" }));
});

test("unknown choices fall back to command; offline choices stay scoped and cannot be newly selected", async () => {
  mount();
  await screen.findByRole("group", { name: "Machine" });
  act(() => useAccountMachineStore.getState().choose("missing"));
  await waitFor(() => expect(target().machine).toBeNull());
  expect(chip(/^Offline/).disabled).toBe(true);
  act(() => useAccountMachineStore.getState().choose("offline"));
  await waitFor(() => expect(target()).toEqual({ machine: "offline", name: "Offline" }));
  expect(chip(/^Offline/).disabled).toBe(false);
});

test("a command-node section keeps the command node and leaves the choice for the next section", async () => {
  mount(true);
  await screen.findByRole("group", { name: "Machine" });
  expect(target()).toEqual({ machine: null, name: "Command" });
  expect(chip(/^Command/).getAttribute("aria-pressed")).toBe("true");
  expect(chip(/^Leaf/).disabled).toBe(true);
  expect(useAccountMachineStore.getState().chosen).toBeUndefined();
});

test("changing machines discards pending local sign-in UI and restores no stale child state", async () => {
  mount();
  await waitFor(() => expect(target().machine).toBe("leaf"));
  fireEvent.click(screen.getByRole("button", { name: "Start fixture sign-in" }));
  expect(screen.getByRole("button", { name: "Pending sign-in" })).toBeTruthy();
  act(() => useAccountMachineStore.getState().choose(null));
  expect(screen.getByRole("button", { name: "Start fixture sign-in" })).toBeTruthy();
  act(() => useAccountMachineStore.getState().choose("leaf"));
  expect(await screen.findByRole("button", { name: "Start fixture sign-in" })).toBeTruthy();
});

test("single-machine settings hide the picker", async () => {
  nodes = [];
  portalStore.store.setState({ nodes });
  mount();
  await waitFor(() => expect(target()).toEqual({ machine: null, name: null }));
  expect(screen.queryByRole("group", { name: "Machine" }) === null).toBe(true);
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
