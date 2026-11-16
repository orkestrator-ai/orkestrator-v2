import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { NodeListResult, NodeStatus, NodeView } from "@orkestrator/protocol/command-nodes";
import type { ConnectionList } from "@orkestrator/protocol/connections";
import { hostMaintenanceSnapshotFixture } from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import { invoke } from "@/lib/native/backend";
import { expectDomAbsent } from "../../../../../../tests/bounded-test-diagnostics";
import { resetSonnerMocks } from "../../../../../../tests/mocks/sonner";
import { MachinesSettings } from "./MachinesSettings";

/**
 * To-do 8000 (retired): in the iOS app, a Settings → Machines form whose token belongs
 * to another machine hands the save to the app's own editor
 * (`connectInNativeEditor`), so the token is never typed into this page. An
 * iOS app without that method keeps the in-page field.
 */

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

afterEach(() => {
  cleanup();
  resetSonnerMocks();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  delete window.orkestrator;
  delete window.__orkestratorClientPlatform;
  mock.restore();
});

const status: NodeStatus = {
  nodeId: "bk_self" as never,
  mode: "command",
  registrationEnabled: true,
  controllers: [],
  detachedControllers: [],
  suspendedSubordinateCount: 0,
};

const BUILD: NodeView = {
  nodeId: "bk_build" as never,
  enabled: true,
  displayName: "Build box",
  colorToken: "teal",
  fallbackName: "build",
  routes: [
    { id: "https" as never, kind: "https", enabled: true, origin: "https://build.tailnet.ts.net" },
  ],
  routeOrder: ["https" as never],
  hasCredential: true,
  attachment: { status: "attached" },
  connection: {
    state: "connected",
    epoch: 1,
    activeRouteId: "https" as never,
    activeRouteKind: "https",
  },
  addedAt: "2026-10-21T00:00:00.000Z",
  lastConnectedAt: "2026-10-21T10:00:00.000Z",
  source: "portal",
};

function installBackend() {
  const nodes: NodeListResult = {
    revision: 1,
    mode: "command",
    suspended: false,
    nodes: [BUILD],
    pendingDetaches: [],
  };
  const commands: string[] = [];
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    commands.push(command);
    if (command === "get_node_status") return status;
    if (command === "list_nodes") return { ...nodes };
    if (command === "get_backend_profile") {
      return { revision: 1, displayName: "Desk", colorToken: "violet", updatedAt: "t" };
    }
    if (command === "get_host_maintenance") return hostMaintenanceSnapshotFixture({});
    if (command === "invoke_on_node") {
      const routed = String(args.command);
      if (routed === "get_host_maintenance") {
        return { outcome: "ok", result: hostMaintenanceSnapshotFixture({}) };
      }
      if (routed === "get_backend_profile") {
        return {
          outcome: "ok",
          result: { revision: 3, displayName: "Build box", colorToken: "teal", updatedAt: "t" },
        };
      }
      return { outcome: "ok", result: { ok: true } };
    }
    if (command === "add_node") return { ...BUILD, nodeId: "bk_new", displayName: "New box" };
    return undefined;
  });
  return { called: (name: string) => commands.filter((command) => command === name) };
}

/** What the iOS app reports: remote servers, no routes or verified identity. */
function iosConnection(id: string, address: string, active: boolean) {
  return {
    id,
    name: new URL(address).host,
    address,
    kind: "remote" as const,
    active,
    requiresToken: false,
    lastConnectedAt: "2026-11-16T10:00:00.000Z",
  };
}

const deskOnly: ConnectionList = {
  activeConnectionId: "desk",
  credentialStorage: "secure",
  connections: [iosConnection("desk", "https://desk.tailnet.ts.net", true)],
};

const deskAndBuild: ConnectionList = {
  ...deskOnly,
  connections: [
    ...deskOnly.connections,
    iosConnection("build", "https://build.tailnet.ts.net", false),
  ],
};

function installIos(list: ConnectionList, options: { nativeEditor?: boolean } = {}) {
  const connections = {
    list: mock(async () => list),
    probe: mock(async () => true),
    connect: mock(async (_input: Record<string, unknown>) => list),
    addInNativeEditor: mock(async () => true),
    rename: mock(async (_id: string, _name: string | null) => list),
    use: mock(async (_id: string) => list),
    forget: mock(async (_id: string) => list),
    connectInNativeEditor: mock(
      async (_input: { address?: string; nickname?: string }): Promise<ConnectionList> => list,
    ),
  };
  const exposed: Record<string, unknown> = { ...connections };
  if (options.nativeEditor === false) delete exposed.connectInNativeEditor;
  window.__orkestratorClientPlatform = "iphone-wkwebview";
  window.orkestrator = {
    invoke: mock(async () => undefined),
    listen: mock(() => () => undefined),
    connections: exposed,
  } as never;
  return connections;
}

function row(name: string): HTMLElement {
  const match = screen
    .getAllByTestId("machine-row")
    .find((element) => element.textContent?.includes(name));
  if (!match) throw new Error(`No row for ${name}`);
  return match;
}

async function renderPage() {
  render(<MachinesSettings />);
  await waitFor(() => expect(screen.getAllByTestId("machine-row").length).toBeGreaterThan(1));
}

async function openSettings(name: string) {
  fireEvent.click(within(row(name)).getByRole("button", { name: `Settings for ${name}` }));
  return within(await screen.findByTestId("machine-settings"));
}

async function openDeviceOnlyAddMachine() {
  fireEvent.click(screen.getByRole("button", { name: "Add machine" }));
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.click(dialog.getByRole("checkbox", { name: "Save on this device only" }));
  return dialog;
}

describe("Add machine on iOS", () => {
  test("a device-only HTTPS machine takes its token in the app's editor", async () => {
    const backend = installBackend();
    const connections = installIos(deskOnly);
    await renderPage();
    const dialog = await openDeviceOnlyAddMachine();

    expectDomAbsent(dialog.queryByLabelText("Gateway token of that machine"), "token field");
    expect(dialog.getByTestId("native-token-note").textContent).toContain("app’s own editor");
    fireEvent.change(dialog.getByLabelText("Machine name or HTTPS address"), {
      target: { value: "https://lab.tailnet.ts.net/" },
    });
    fireEvent.change(dialog.getByLabelText(/^Name/), { target: { value: "Lab" } });
    fireEvent.click(dialog.getByRole("button", { name: "Add machine" }));

    await waitFor(() => expect(connections.connectInNativeEditor).toHaveBeenCalledTimes(1));
    expect(connections.connectInNativeEditor.mock.calls[0]![0]).toEqual({
      address: "https://lab.tailnet.ts.net",
      nickname: "Lab",
    });
    expect(connections.connect).not.toHaveBeenCalled();
    expect(backend.called("add_node")).toHaveLength(0);
    await waitFor(() => expectDomAbsent(screen.queryByRole("dialog"), "add machine dialog"));
  });

  test("closing the app's editor keeps the dialog open with the reason", async () => {
    installBackend();
    const connections = installIos(deskOnly);
    connections.connectInNativeEditor.mockRejectedValueOnce(
      new Error("Nothing was saved: the server editor was closed in the app."),
    );
    await renderPage();
    const dialog = await openDeviceOnlyAddMachine();
    fireEvent.change(dialog.getByLabelText("Machine name or HTTPS address"), {
      target: { value: "https://lab.tailnet.ts.net" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Add machine" }));

    expect(await dialog.findByText(/the server editor was closed in the app/)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Add machine" })).toBeTruthy();
  });

  test("registering with the command node still hands it the token in the page", async () => {
    const backend = installBackend();
    const connections = installIos(deskOnly);
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Add machine" }));
    const dialog = within(await screen.findByRole("dialog"));

    // The command node keeps this token and connects with it itself.
    fireEvent.change(dialog.getByLabelText("Machine name or HTTPS address"), {
      target: { value: "https://lab.tailnet.ts.net" },
    });
    fireEvent.change(dialog.getByLabelText("Gateway token of that machine"), {
      target: { value: "node-token-1" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Add machine" }));
    await waitFor(() => expect(backend.called("add_node")).toHaveLength(1));
    expect(connections.connectInNativeEditor).not.toHaveBeenCalled();
  });

  test("an iOS app without the native save keeps the in-page token field", async () => {
    installBackend();
    const connections = installIos(deskOnly, { nativeEditor: false });
    await renderPage();
    const dialog = await openDeviceOnlyAddMachine();
    fireEvent.change(dialog.getByLabelText("Machine name or HTTPS address"), {
      target: { value: "https://lab.tailnet.ts.net" },
    });
    fireEvent.change(dialog.getByLabelText("Gateway token of that machine"), {
      target: { value: "device-token-1" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Add machine" }));
    await waitFor(() => expect(connections.connect).toHaveBeenCalledTimes(1));
    expect(connections.connect.mock.calls[0]![0]).toEqual({
      address: "https://lab.tailnet.ts.net",
      token: "device-token-1",
      select: false,
    });
  });
});

describe("Machine settings on iOS", () => {
  test("Save on this device opens the app's editor for the machine's address", async () => {
    installBackend();
    const connections = installIos(deskOnly);
    await renderPage();
    await openSettings("Build box");
    const section = within(await screen.findByTestId("machine-save-on-device"));

    expectDomAbsent(section.queryByLabelText(/Gateway token for/), "token field");
    expect(section.getByTestId("native-token-note").textContent).toContain(
      "https://build.tailnet.ts.net",
    );
    fireEvent.click(section.getByRole("button", { name: "Save on this device" }));
    await waitFor(() =>
      expect(connections.connectInNativeEditor).toHaveBeenCalledWith({
        address: "https://build.tailnet.ts.net",
      }),
    );
    expect(connections.connect).not.toHaveBeenCalled();
  });

  test("an iOS app without the native save keeps Save on this device's token field", async () => {
    installBackend();
    const connections = installIos(deskOnly, { nativeEditor: false });
    await renderPage();
    await openSettings("Build box");
    const section = within(await screen.findByTestId("machine-save-on-device"));
    fireEvent.change(section.getByLabelText("Gateway token for https://build.tailnet.ts.net"), {
      target: { value: "device-token-2" },
    });
    fireEvent.click(section.getByRole("button", { name: "Save on this device" }));
    await waitFor(() =>
      expect(connections.connect).toHaveBeenCalledWith({
        address: "https://build.tailnet.ts.net",
        token: "device-token-2",
        select: false,
      }),
    );
  });

  test("a saved machine's token is replaced in the app's editor", async () => {
    installBackend();
    const connections = installIos(deskAndBuild);
    await renderPage();
    await openSettings("Build box");
    const section = within(await screen.findByTestId("machine-device-connection"));

    expectDomAbsent(section.queryByLabelText("Connection token on this device"), "token field");
    fireEvent.click(section.getByRole("button", { name: "Replace token" }));
    await waitFor(() =>
      expect(connections.connectInNativeEditor).toHaveBeenCalledWith({
        address: "https://build.tailnet.ts.net",
      }),
    );
  });

  test("another HTTPS address for a verified machine takes its token in the app's editor", async () => {
    installBackend();
    const verified: ConnectionList = {
      ...deskAndBuild,
      connections: deskAndBuild.connections.map((connection) =>
        connection.id === "build" ? { ...connection, identity: "verified" as const } : connection,
      ),
    };
    const connections = installIos(verified);
    await renderPage();
    await openSettings("Build box");
    const section = within(await screen.findByTestId("machine-device-connection"));
    fireEvent.click(section.getByTitle("Add an HTTPS address"));

    const dialog = within(await screen.findByRole("dialog", { name: /Add an HTTPS address to/ }));
    expectDomAbsent(dialog.queryByLabelText("Gateway token"), "token field");
    expect(dialog.getByTestId("native-token-note")).toBeTruthy();
    fireEvent.change(dialog.getByLabelText("HTTPS address"), {
      target: { value: "https://build-2.tailnet.ts.net" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Add address" }));
    await waitFor(() =>
      expect(connections.connectInNativeEditor).toHaveBeenCalledWith({
        address: "https://build-2.tailnet.ts.net",
      }),
    );
    expect(connections.connect).not.toHaveBeenCalled();
  });
});
