import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { NodeListResult, NodeStatus, NodeView } from "@orkestrator/protocol/command-nodes";
import type { ConnectionList } from "@orkestrator/protocol/connections";
import type { HostMaintenanceSnapshot } from "@orkestrator/protocol/host-maintenance";
import { hostMaintenanceSnapshotFixture } from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import { BACKEND_PROFILE_CONFLICT_CODE } from "@orkestrator/protocol/backend-profile";
import { listen } from "@/lib/native/events";
import { invoke } from "@/lib/native/backend";
import { expectDomAbsent } from "../../../../../../tests/bounded-test-diagnostics";
import {
  mockToastError,
  mockToastWarning,
  resetSonnerMocks,
} from "../../../../../../tests/mocks/sonner";
import { portalStore } from "@/lib/portal/portal-store";
import {
  onGlobalSettingsCloseRequest,
  onGlobalSettingsRequest,
  requestCurrentMachineUpdates,
  takeMachineUpdatesRequest,
} from "@/lib/settings-navigation";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useUIStore } from "@/stores/uiStore";
import { MachinesSettings } from "./MachinesSettings";

const originalPortal = portalStore.getState();
const originalRemote = useRemoteWorkspaceStore.getState();

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

afterEach(() => {
  cleanup();
  resetSonnerMocks();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  delete window.orkestrator;
  delete window.__orkestratorClientPlatform;
  takeMachineUpdatesRequest();
  mock.restore();
});

const commandStatus: NodeStatus = {
  nodeId: "bk_self" as never,
  mode: "command",
  registrationEnabled: true,
  controllers: [],
  detachedControllers: [],
  suspendedSubordinateCount: 0,
};

function nodeView(id: string, name: string, overrides: Partial<NodeView> = {}): NodeView {
  return {
    nodeId: `bk_${id}` as never,
    enabled: true,
    displayName: name,
    colorToken: "teal",
    fallbackName: id,
    routes: [
      {
        id: "https" as never,
        kind: "https",
        enabled: true,
        origin: `https://${id}.tailnet.ts.net`,
      },
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
    ...overrides,
  };
}

const BUILD = nodeView("build", "Build box");
const ZED = nodeView("zed", "Zed", {
  colorToken: "rose",
  connection: {
    state: "unavailable",
    epoch: 1,
    lastError: { code: "unreachable", message: "No route" },
  },
});

const current = hostMaintenanceSnapshotFixture({ version: "2.26.0" });
const outdated = hostMaintenanceSnapshotFixture({
  version: "2.25.0",
  updater: {
    kind: "standalone",
    available: true,
    reason: null,
    latestVersion: "2.26.0",
    updateAvailable: true,
    checkedAt: "2026-10-21T10:00:00.000Z",
    checkError: null,
  },
});

type Routed = { nodeId: string; command: string; args: Record<string, unknown> };

function install(
  options: {
    status?: NodeStatus;
    nodes?: NodeView[];
    maintenance?: Record<string, HostMaintenanceSnapshot>;
    respond?: (call: Routed) => unknown;
    discoveryFails?: () => boolean;
  } = {},
) {
  const status = options.status ?? commandStatus;
  const list: NodeListResult = {
    revision: 1,
    mode: status.mode,
    suspended: false,
    nodes: options.nodes ?? [BUILD, ZED],
    pendingDetaches: [],
  };
  const maintenance = options.maintenance ?? { self: current, bk_build: outdated };
  const routed: Routed[] = [];
  const commands: Array<[string, Record<string, unknown>]> = [];
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    commands.push([command, args]);
    if (["get_node_status", "list_nodes"].includes(command) && options.discoveryFails?.())
      throw new Error("discovery failed");
    if (command === "get_node_status") return status;
    if (command === "list_nodes") return { ...list };
    if (command === "get_backend_profile") {
      return { revision: 1, displayName: "Desk", colorToken: "violet", updatedAt: "t" };
    }
    if (command === "get_host_maintenance") return maintenance.self;
    if (command === "invoke_on_node") {
      const call: Routed = {
        nodeId: String(args.nodeId),
        command: String(args.command),
        args: (args.args as Record<string, unknown>) ?? {},
      };
      routed.push(call);
      const custom = await options.respond?.(call);
      if (custom !== undefined) return { outcome: "ok", result: custom };
      if (call.command === "get_host_maintenance") {
        const snapshot = maintenance[call.nodeId];
        if (!snapshot) throw new Error("not reachable");
        return { outcome: "ok", result: snapshot };
      }
      if (call.command === "get_backend_profile") {
        return {
          outcome: "ok",
          result: { revision: 3, displayName: "Build box", colorToken: "teal", updatedAt: "t" },
        };
      }
      return { outcome: "ok", result: { ok: true } };
    }
    if (command === "add_node") {
      return { ...BUILD, nodeId: "bk_new", displayName: "New box" };
    }
    return undefined;
  });
  return {
    list,
    routed,
    commands,
    called: (command: string) => commands.filter(([name]) => name === command),
  };
}

const desktopList: ConnectionList = {
  activeConnectionId: "local",
  credentialStorage: "secure",
  connections: [
    {
      id: "local",
      name: "Local",
      address: null,
      kind: "local",
      active: true,
      requiresToken: false,
      backendId: "bk_self" as never,
    },
    {
      id: "build",
      name: "build.tailnet.ts.net",
      address: "https://build.tailnet.ts.net",
      kind: "remote",
      active: false,
      requiresToken: false,
      backendId: "bk_build" as never,
      identity: "verified",
      transport: "disabled",
      routes: [
        {
          id: "route-1",
          kind: "https",
          label: "build.tailnet.ts.net",
          enabled: true,
          active: false,
          supported: true,
        },
      ],
    },
  ],
};

function installDesktop(list: ConnectionList = desktopList) {
  const connections = {
    list: mock(async () => list),
    probe: mock(async () => true),
    connect: mock(async (_input: Record<string, unknown>) => list),
    updateToken: mock(async (_id: string, _token: string) => list),
    use: mock(async (_id: string) => list),
    forget: mock(async (_id: string) => list),
    rename: mock(async (_id: string, _name: string | null) => list),
    setFeatures: mock(async (_features: Record<string, boolean>) => list),
    openWindow: mock(async (_connectionId: string) => undefined),
  };
  window.orkestrator = {
    invoke: mock(async () => undefined),
    listen: mock(() => () => undefined),
    connections,
    process: { exit: mock(async () => undefined) },
    window: { startDragging: mock(async () => undefined) },
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

describe("Machines settings", () => {
  test("lists every machine once, the connected one first, with address, connection and last connection", async () => {
    install();
    installDesktop();
    await renderPage();

    const rows = screen.getAllByTestId("machine-row");
    expect(rows.map((element) => element.querySelector(".font-medium")?.textContent)).toEqual([
      "Desk",
      "Build box",
      "Zed",
    ]);
    // The saved connection to Build box is the same machine as the node.
    expect(rows).toHaveLength(3);

    const desk = within(rows[0]!);
    expect(desk.getByText("This window")).toBeTruthy();
    expect(desk.getByText("This device")).toBeTruthy();
    expect(desk.getByText("Connected now")).toBeTruthy();

    const build = within(rows[1]!);
    expect(build.getByText("build.tailnet.ts.net")).toBeTruthy();
    expect(build.getByTestId("machine-connection").textContent).toBe("Tailscale HTTPS · Connected");
    expect(build.getByText(/^Last connected /)).toBeTruthy();
    expect(build.getByTestId("machine-status-dot").dataset.connected).toBe("true");
    expect(build.getByTestId("machine-status-dot").dataset.machineColor).toBe("teal");

    const zed = within(rows[2]!);
    expect(zed.getByTestId("machine-connection").textContent).toBe("Tailscale HTTPS · Unavailable");
    expect(zed.getByTestId("machine-status-dot").dataset.connected).toBe("false");
  });

  test("a machine with anything out of date has a red Updates button", async () => {
    install();
    installDesktop();
    await renderPage();

    await waitFor(() =>
      expect(
        within(row("Build box")).getByRole("button", { name: /^Updates for Build box/ }).dataset
          .outdated,
      ).toBe("true"),
    );
    expect(
      within(row("Build box"))
        .getByRole("button", { name: /^Updates for Build box/ })
        .getAttribute("aria-label"),
    ).toBe("Updates for Build box: 1 out of date");
    expect(
      within(row("Desk")).getByRole("button", { name: "Updates for Desk" }).dataset.outdated,
    ).toBe("false");
    // An unreachable machine cannot be read, so its updates are unavailable.
    expect(
      (within(row("Zed")).getByRole("button", { name: "Updates for Zed" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("Updates opens that machine's updates and installs through the command node", async () => {
    const backend = install({
      respond: ({ command }) =>
        command === "get_host_restart_impact"
          ? {
              workingAgents: 0,
              waitingAgents: 0,
              activePipelines: 0,
              terminals: 0,
              hostServers: 0,
              measuredAt: "t",
            }
          : command === "request_host_update"
            ? { job: null, snapshot: { ...outdated, revision: 5 } }
            : undefined,
    });
    installDesktop();
    await renderPage();

    fireEvent.click(
      within(row("Build box")).getByRole("button", { name: /^Updates for Build box/ }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Updates for Build box")).toBeTruthy();
    expect(within(dialog).getByText("Orkestrator 2.26.0 is available")).toBeTruthy();
    expect(within(dialog).getByText("Agent tools")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Repair agent tools" })).toBeTruthy();
    expect(within(dialog).getByText("Container image")).toBeTruthy();

    fireEvent.click(await within(dialog).findByRole("button", { name: "Install 2.26.0" }));
    fireEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    await waitFor(() =>
      expect(backend.routed.some((call) => call.command === "request_host_update")).toBe(true),
    );
    expect(backend.routed.find((call) => call.command === "request_host_update")).toEqual({
      nodeId: "bk_build",
      command: "request_host_update",
      args: { version: "2.26.0" },
    });
  });

  test("an environment on an older image opens its own rebuild on that machine", async () => {
    portalStore.store.setState({ selfId: "bk_self" as never });
    install({
      maintenance: {
        self: current,
        bk_build: {
          ...outdated,
          image: {
            name: "orkestrator-v2:latest",
            present: true,
            compatible: true,
            reason: null,
            releaseReference: "ghcr.io/orkestrator-ai/orkestrator-v2:2.25.0",
            outdatedEnvironments: [{ id: "env-old", name: "old-box", projectId: "project-1" }],
          },
        },
      },
    });
    installDesktop();
    const closeSettings = mock(() => undefined);
    const stopListening = onGlobalSettingsCloseRequest(closeSettings);
    try {
      await renderPage();
      fireEvent.click(
        within(row("Build box")).getByRole("button", { name: /^Updates for Build box/ }),
      );
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(await within(dialog).findByRole("button", { name: "Rebuild old-box" }));
      await waitFor(() => expectDomAbsent(screen.queryByText("Updates for Build box")));
      expect(closeSettings).toHaveBeenCalledTimes(1);
      expect(useRemoteWorkspaceStore.getState().active?.nodeId).toBe("bk_build");
      expect(useRemoteWorkspaceStore.getState().requests.bk_build?.request).toMatchObject({
        projectId: "project-1",
        environmentId: "env-old",
        dialog: "environment-rebuild",
      });
    } finally {
      stopListening();
      portalStore.store.setState(originalPortal, true);
      useRemoteWorkspaceStore.setState(originalRemote, true);
    }
  });

  test("the update request from a banner opens the current machine's updates", async () => {
    install();
    installDesktop();
    await renderPage();
    act(() => requestCurrentMachineUpdates());
    expect(await screen.findByText("Updates for Desk")).toBeTruthy();
  });

  test("the window button opens a saved machine in its own window", async () => {
    install();
    const connections = installDesktop();
    await renderPage();

    fireEvent.click(
      within(row("Build box")).getByRole("button", { name: "Open Build box in a new window" }),
    );
    await waitFor(() => expect(connections.openWindow).toHaveBeenCalledWith("build"));
    // Zed is not saved on this device, so there is nothing to open directly.
    const zed = within(row("Zed")).getByRole("button", { name: "Open Zed in a new window" });
    expect((zed as HTMLButtonElement).disabled).toBe(true);
    expect(zed.getAttribute("title")).toMatch(/Save this machine on this device/);
  });
});

describe("Add machine", () => {
  test("one dialog adds over Tailscale HTTPS: registered on the command node and saved on this device", async () => {
    const backend = install();
    const connections = installDesktop();
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Add machine" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /Tailscale \/ HTTPS/ })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /SSH/ })).toBeTruthy();

    // A bare name takes the tailnet of a machine already known.
    fireEvent.change(within(dialog).getByLabelText("Machine name or HTTPS address"), {
      target: { value: "new" },
    });
    fireEvent.change(within(dialog).getByLabelText("Gateway token of that machine"), {
      target: { value: "tok-1" },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: "New box" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add machine" }));

    await waitFor(() => expect(backend.called("add_node")).toHaveLength(1));
    expect(backend.called("add_node")[0]![1]).toEqual({
      routes: [{ id: "https", kind: "https", enabled: true, origin: "https://new.tailnet.ts.net" }],
      token: "tok-1",
      displayName: "New box",
    });
    await waitFor(() => expect(connections.connect).toHaveBeenCalledTimes(1));
    expect(connections.connect.mock.calls[0]![0]).toEqual({
      address: "https://new.tailnet.ts.net",
      token: "tok-1",
      select: false,
      nickname: "New box",
    });
    await waitFor(() => expectDomAbsent(screen.queryByRole("dialog"), "add machine dialog"));
  });

  test("the same dialog adds over SSH, registered on the command node only", async () => {
    const backend = install();
    const connections = installDesktop();
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Add machine" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /SSH/ }));
    fireEvent.change(within(dialog).getByLabelText("SSH destination or alias"), {
      target: { value: "build-host" },
    });
    fireEvent.change(within(dialog).getByLabelText("Gateway token of that machine"), {
      target: { value: "tok-2" },
    });
    expectDomAbsent(within(dialog).queryByLabelText("Also save on this device"), "save option");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add machine" }));

    await waitFor(() => expect(backend.called("add_node")).toHaveLength(1));
    expect(backend.called("add_node")[0]![1]).toEqual({
      routes: [
        {
          id: "ssh",
          kind: "ssh",
          enabled: true,
          destination: "build-host",
          remoteGatewayPort: 34122,
        },
      ],
      token: "tok-2",
    });
    expect(connections.connect).not.toHaveBeenCalled();
  });

  test("a browser client registers the machine with the command node only", async () => {
    const backend = install();
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Add machine" }));
    const dialog = await screen.findByRole("dialog");
    expectDomAbsent(within(dialog).queryByLabelText("Also save on this device"), "save option");
    fireEvent.change(within(dialog).getByLabelText("Machine name or HTTPS address"), {
      target: { value: "https://new.tailnet.ts.net" },
    });
    fireEvent.change(within(dialog).getByLabelText("Gateway token of that machine"), {
      target: { value: "tok-3" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add machine" }));
    await waitFor(() => expect(backend.called("add_node")).toHaveLength(1));
  });
});

describe("Machine settings", () => {
  async function openSettings(name: string) {
    fireEvent.click(within(row(name)).getByRole("button", { name: `Settings for ${name}` }));
    return screen.findByTestId("machine-settings");
  }

  test("renames and recolours the machine on itself, through the command node", async () => {
    const backend = install();
    installDesktop();
    await renderPage();
    const settings = within(await openSettings("Build box"));

    await waitFor(() =>
      expect((settings.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false),
    );
    fireEvent.change(settings.getByLabelText("Name"), { target: { value: "Builder" } });
    fireEvent.click(settings.getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(backend.routed.some((call) => call.command === "update_backend_profile")).toBe(true),
    );
    expect(backend.routed.find((call) => call.command === "update_backend_profile")).toEqual({
      nodeId: "bk_build",
      command: "update_backend_profile",
      args: { expectedRevision: 3, displayName: "Builder" },
    });

    fireEvent.click(
      within(settings.getByRole("radiogroup", { name: "Dot colour" })).getByRole("radio", {
        name: "Blue",
      }),
    );
    await waitFor(() =>
      expect(
        backend.routed.filter((call) => call.command === "update_backend_profile"),
      ).toHaveLength(2),
    );
  });

  test("CL-04: a profile conflict warns, shows the machine's values and is never retried", async () => {
    const backend = install({
      respond: ({ command }) => {
        if (command === "update_backend_profile") {
          throw new Error(`[${BACKEND_PROFILE_CONFLICT_CODE}] The profile changed (revision 4).`);
        }
        return undefined;
      },
    });
    installDesktop();
    await renderPage();
    const settings = within(await openSettings("Build box"));
    const green = await settings.findByRole("radio", { name: "Green" });
    await waitFor(() => expect((green as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(green);

    await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));
    expect(String(mockToastWarning.mock.calls[0]![0])).toMatch(/changed on another client/);
    expect(mockToastError).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(backend.routed.filter((call) => call.command === "update_backend_profile")).toHaveLength(
      1,
    );
    // The colours are usable again (not stuck saving).
    await waitFor(() => expect((green as HTMLButtonElement).disabled).toBe(false));
  });

  test("shows state and pings the machine", async () => {
    install();
    installDesktop();
    await renderPage();
    const settings = within(await openSettings("Zed"));

    const status = within(settings.getByTestId("machine-status"));
    expect(status.getByText("Unavailable")).toBeTruthy();
    expect(status.getByText("No route")).toBeTruthy();
    // Zed is not connected and not saved here, so there is nothing to ping.
    expect((status.getByRole("button", { name: "Ping" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const build = within(await openSettings("Build box"));
    fireEvent.click(
      within(build.getByTestId("machine-status")).getByRole("button", { name: "Ping" }),
    );
    expect((await build.findByTestId("machine-ping")).textContent).toMatch(/^\d+ ms$/);
  });

  test("edits addresses and the token the command node uses, without showing the saved token", async () => {
    const backend = install();
    installDesktop();
    await renderPage();
    const routes = within(
      within(await openSettings("Build box")).getByTestId("machine-node-routes"),
    );

    expect(routes.getByPlaceholderText("Saved — enter a new one to replace it")).toBeTruthy();
    fireEvent.click(routes.getByRole("button", { name: "SSH" }));
    fireEvent.change(routes.getByLabelText("New SSH destination"), { target: { value: "build" } });
    fireEvent.click(routes.getByRole("button", { name: "Add" }));
    fireEvent.click(routes.getByRole("button", { name: /^Move build.* up$/ }));
    fireEvent.click(routes.getByRole("button", { name: "Save connection" }));

    await waitFor(() => expect(backend.called("update_node")).toHaveLength(1));
    const args = backend.called("update_node")[0]![1] as {
      routes: Array<{ kind: string }>;
      routeOrder: string[];
      token?: string;
    };
    expect(args.routes.map((route) => route.kind)).toEqual(["ssh", "https"]);
    expect(args.routeOrder).toHaveLength(2);
    expect(args.token).toBeUndefined();
  });

  test("removing a machine asks first and says nothing on it stops", async () => {
    const backend = install();
    installDesktop();
    await renderPage();
    within(await openSettings("Build box"));

    fireEvent.click(screen.getByRole("button", { name: "Remove Build box" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Nothing on Build box is stopped or deleted");
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(backend.called("forget_node")).toHaveLength(1));
    expect(backend.called("forget_node")[0]![1]).toEqual({
      nodeId: "bk_build",
      withoutDetach: false,
    });
  });

  test("in leaf mode the page names the controller, and the current machine can detach it", async () => {
    const backend = install({
      status: {
        ...commandStatus,
        mode: "leaf",
        controllers: [
          {
            controllerId: "bk_top" as never,
            displayName: "Office desktop",
            attachedAt: "2026-10-21T00:00:00.000Z",
            lastContactAt: "2026-10-21T00:01:00.000Z",
          },
        ],
        mostRecentControllerId: "bk_top" as never,
        suspendedSubordinateCount: 1,
      },
      nodes: [],
    });
    render(<MachinesSettings />);
    await waitFor(() => expect(screen.getByTestId("leaf-mode-notice")).toBeTruthy());
    expect(screen.getByTestId("leaf-mode-notice").textContent).toContain("Office desktop");

    const settings = within(await openSettings("Desk"));
    expect(settings.getByTestId("controllers").textContent).toContain("(most recent)");
    fireEvent.click(settings.getByRole("button", { name: "Detach" }));
    await waitFor(() => expect(backend.called("detach_controller_here")).toHaveLength(1));
  });
});

test("a leaf's own window lists only its own agent logins", async () => {
  install({
    status: {
      ...commandStatus,
      mode: "leaf",
      controllers: [
        {
          controllerId: "bk_top" as never,
          displayName: "Office desktop",
          attachedAt: "2026-10-21T00:00:00.000Z",
          lastContactAt: "2026-10-21T00:01:00.000Z",
        },
      ],
      mostRecentControllerId: "bk_top" as never,
      suspendedSubordinateCount: 0,
    },
    nodes: [],
  });
  const originalInvoke = invokeMock.getMockImplementation()!;
  const snapshot = { accounts: [], active: { claude: "default", codex: "default" } };
  invokeMock.mockImplementation((command, args) =>
    command === "list_machine_agent_accounts"
      ? Promise.resolve({
          machines: [
            { nodeId: "self", name: "Desk", self: true, state: "ok", snapshot },
            // A stray peer row must not show: a leaf's machines are not its own to manage.
            { nodeId: "bk_other", name: "Other", self: false, state: "ok", snapshot },
          ],
        })
      : originalInvoke(command, args),
  );
  render(<MachinesSettings />);
  await waitFor(() => expect(screen.getAllByTestId("machine-agent-accounts-row")).toHaveLength(1));
  expect(screen.getByTestId("machine-agent-accounts-row").textContent).toContain("Desk");
  expectDomAbsent(screen.queryByRole("button", { name: "By account" }), "By account toggle");
});

// Settings is a z-[60] fullscreen surface; a default z-50 dialog renders
// behind it while Radix blocks pointer events, so the app looks frozen.
describe("machine dialogs open above fullscreen settings", () => {
  for (const button of ["Add machine", "Settings for Build box", "Updates for Build box"]) {
    test(button, async () => {
      install();
      installDesktop();
      await renderPage();
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${button}`) }));
      const dialog = await screen.findByRole("dialog");
      const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!;
      expect(dialog.className).toContain("z-[80]");
      expect(dialog.className).not.toContain("z-50");
      expect(overlay.className).toContain("z-[80]");
    });
  }
});

test("a lazy Settings request opens the current machine updates after Machines mounts", async () => {
  install();
  const sections: string[] = [];
  const stop = onGlobalSettingsRequest((section) => sections.push(section));
  try {
    act(() => requestCurrentMachineUpdates());
    expect(sections).toEqual(["machines"]);
    render(<MachinesSettings />);
    expect(await screen.findByRole("dialog", { name: "Updates for Desk" })).toBeTruthy();
    expect(takeMachineUpdatesRequest()).toBe(false);
  } finally {
    stop();
  }
});

test("browser discovery failure keeps the connected machine and updates available with retry", async () => {
  let failed = true;
  install({ discoveryFails: () => failed });
  render(<MachinesSettings />);
  const updates = await screen.findByRole("button", { name: "Updates for Desk" });
  expect((updates as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(updates);
  const dialog = await screen.findByRole("dialog", { name: "Updates for Desk" });
  expect(within(dialog).getByText("Agent tools")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry machine discovery" }));
  await screen.findByRole("button", { name: "Settings for Build box" });
  await waitFor(() =>
    expectDomAbsent(screen.queryByRole("button", { name: "Retry machine discovery" }), "retry"),
  );
});

test("This device can disable the all-machines feature", async () => {
  install();
  const connections = installDesktop({
    ...desktopList,
    features: { federation: true, sshRoutes: true, routeFallback: true },
  });
  await renderPage();
  fireEvent.click(screen.getByRole("switch", { name: "Show all machines together" }));
  await waitFor(() => expect(connections.setFeatures).toHaveBeenCalledWith({ federation: false }));
});

test("onboarding explains subordinate suspension and offers a direct device-only connection", async () => {
  const backend = install();
  const connections = installDesktop();
  await renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Add machine" }));
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText(/enters leaf mode/).textContent).toContain(
    "subordinate links and command activity are suspended",
  );
  fireEvent.click(dialog.getByRole("checkbox", { name: "Save on this device only" }));
  expectDomAbsent(dialog.queryByText(/enters leaf mode/), "attachment description");
  fireEvent.change(dialog.getByLabelText("Machine name or HTTPS address"), {
    target: { value: "direct" },
  });
  fireEvent.change(dialog.getByLabelText("Gateway token of that machine"), {
    target: { value: "test-token" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Add machine" }));
  await waitFor(() => expect(connections.connect).toHaveBeenCalledTimes(1));
  expect(backend.called("add_node")).toHaveLength(0);
});

async function deviceSettings(name = "Build box") {
  fireEvent.click(within(row(name)).getByRole("button", { name: `Settings for ${name}` }));
  return within(await screen.findByTestId("machine-device-connection"));
}

test("switching an inactive Local connection uses the normal reload and hides remote settings", async () => {
  install({ status: { ...commandStatus, nodeId: "bk_build" as never } });
  const connections = installDesktop({
    ...desktopList,
    activeConnectionId: "build",
    connections: desktopList.connections.map((c) => ({ ...c, active: c.id === "build" })),
  });
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  await renderPage();
  const settings = await deviceSettings("Local");
  expectDomAbsent(settings.queryByText("Addresses"), "remote routes");
  expectDomAbsent(settings.queryByLabelText("Name on this device"), "Local rename");
  expectDomAbsent(settings.queryByLabelText("Connection token on this device"), "remote token");
  expectDomAbsent(
    settings.queryByRole("button", { name: "Forget on this device" }),
    "forget Local",
  );
  fireEvent.click(settings.getByRole("button", { name: "Connect this window" }));
  await waitFor(() => expect(connections.use).toHaveBeenCalledWith("local"));
  expect(reload).toHaveBeenCalledTimes(1);
});

test("token failure retains the draft, reports the error and allows a successful retry", async () => {
  install();
  const connections = installDesktop();
  connections.updateToken.mockRejectedValueOnce(new Error("Token rejected"));
  await renderPage();
  const settings = await deviceSettings();
  const token = settings.getByLabelText("Connection token on this device") as HTMLInputElement;
  fireEvent.change(token, { target: { value: " test-token " } });
  fireEvent.click(settings.getByRole("button", { name: "Save token" }));
  expect(await settings.findByText("Token rejected")).toBeTruthy();
  expect(token.value).toBe(" test-token ");
  fireEvent.click(settings.getByRole("button", { name: "Save token" }));
  await waitFor(() => expect(token.value).toBe(""));
  expect(connections.updateToken).toHaveBeenLastCalledWith("build", "test-token");
});

for (const active of [false, true]) {
  test(`forgetting a ${active ? "active" : "inactive"} saved remote connection`, async () => {
    install();
    const connections = installDesktop({
      ...desktopList,
      connections: desktopList.connections.map((c) => ({
        ...c,
        active: active ? c.id === "build" : c.id === "local",
      })),
    });
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    await renderPage();
    const settings = await deviceSettings(active ? "Desk" : "Build box");
    fireEvent.click(settings.getByRole("button", { name: "Forget on this device" }));
    const confirm = within(await screen.findByRole("alertdialog"));
    expect(connections.forget).not.toHaveBeenCalled();
    fireEvent.click(confirm.getByRole("button", { name: "Forget on this device" }));
    await waitFor(() => expect(connections.forget).toHaveBeenCalledWith("build"));
    expect(reload).toHaveBeenCalledTimes(active ? 1 : 0);
  });
}

test("native WKWebView switching lets its connection bridge navigate without reloading", async () => {
  install();
  const connections = installDesktop();
  window.__orkestratorClientPlatform = "ios-wkwebview";
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  await renderPage();
  const settings = await deviceSettings();
  fireEvent.click(settings.getByRole("button", { name: "Connect this window" }));
  await waitFor(() => expect(connections.use).toHaveBeenCalledWith("build"));
  expect(reload).not.toHaveBeenCalled();
});

test("saved nicknames rename, persist on remount and clear back to the shared profile", async () => {
  install();
  let saved: ConnectionList = {
    ...desktopList,
    connections: desktopList.connections.map((c) =>
      c.id === "build"
        ? {
            ...c,
            profile: {
              revision: 1,
              displayName: "Build box",
              colorToken: "teal",
              updatedAt: "t",
              cached: true,
            },
          }
        : c,
    ),
  };
  const connections = installDesktop(saved);
  connections.list.mockImplementation(async () => saved);
  connections.rename.mockImplementation(async (id, nickname) => {
    saved = {
      ...saved,
      connections: saved.connections.map((c) =>
        c.id === id ? { ...c, nickname: nickname ?? undefined } : c,
      ),
    };
    return saved;
  });
  await renderPage();
  let settings = await deviceSettings();
  fireEvent.change(settings.getByLabelText("Name on this device"), {
    target: { value: "My builder" },
  });
  fireEvent.click(settings.getByRole("button", { name: "Save" }));
  await screen.findByRole("dialog", { name: "My builder" });
  expect(connections.rename).toHaveBeenCalledWith("build", "My builder");
  cleanup();
  await renderPage();
  expect(row("My builder")).toBeTruthy();
  settings = await deviceSettings("My builder");
  // Shared-profile editing still uses the canonical name.
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Build box");
  fireEvent.change(settings.getByLabelText("Name on this device"), { target: { value: "" } });
  fireEvent.click(settings.getByRole("button", { name: "Save" }));
  await screen.findByRole("dialog", { name: "Build box" });
  expect(connections.rename).toHaveBeenLastCalledWith("build", null);
  cleanup();
  await renderPage();
  expect(row("Build box")).toBeTruthy();
});

test("failed connection mutations report errors and leave retry controls usable", async () => {
  install();
  const connections = installDesktop();
  connections.use.mockRejectedValueOnce(new Error("switch failed"));
  connections.forget.mockRejectedValueOnce(new Error("forget failed"));
  connections.rename.mockRejectedValueOnce(new Error("rename failed"));
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  await renderPage();
  const settings = await deviceSettings();
  fireEvent.click(settings.getByRole("button", { name: "Connect this window" }));
  await waitFor(() =>
    expect(mockToastError).toHaveBeenCalledWith("Could not switch this window", {
      description: "switch failed",
    }),
  );
  expect(
    (settings.getByRole("button", { name: "Connect this window" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  fireEvent.change(settings.getByLabelText("Name on this device"), {
    target: { value: "Nickname" },
  });
  fireEvent.click(settings.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(mockToastError).toHaveBeenCalledWith("Could not save the name", {
      description: "rename failed",
    }),
  );
  fireEvent.click(settings.getByRole("button", { name: "Forget on this device" }));
  const confirm = within(await screen.findByRole("alertdialog"));
  fireEvent.click(confirm.getByRole("button", { name: "Forget on this device" }));
  await waitFor(() =>
    expect(mockToastError).toHaveBeenCalledWith("Could not forget it", {
      description: "forget failed",
    }),
  );
  expect(
    (confirm.getByRole("button", { name: "Forget on this device" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});

test("the account overview follows machine additions and removals while Settings stays open", async () => {
  const callbacks = new Map<string, (event: { payload: unknown }) => void>();
  const listener = listen as ReturnType<typeof mock>;
  listener.mockImplementation(async (event, callback) => {
    callbacks.set(event, callback);
    return () => {};
  });
  const installed = install({ nodes: [BUILD] });
  const originalInvoke = invokeMock.getMockImplementation()!;
  let fleet = [
    {
      nodeId: "self",
      name: "Desk",
      self: true,
      state: "ok",
      snapshot: { accounts: [], active: { claude: "default", codex: "default" } },
    },
  ];
  invokeMock.mockImplementation((command, args) =>
    command === "list_machine_agent_accounts"
      ? Promise.resolve({ machines: fleet })
      : originalInvoke(command, args),
  );
  try {
    render(<MachinesSettings />);
    await screen.findByTestId("machine-agent-accounts-row");
    fleet = [...fleet, { ...fleet[0]!, nodeId: "bk_zed", name: "Zed", self: false }];
    installed.list.nodes = [BUILD, ZED];
    await act(async () => callbacks.get("nodes-changed")!({ payload: undefined }));
    await waitFor(() =>
      expect(screen.getAllByTestId("machine-agent-accounts-row")).toHaveLength(2),
    );
    fleet = [fleet[0]!];
    installed.list.nodes = [BUILD];
    await act(async () => callbacks.get("nodes-changed")!({ payload: undefined }));
    await waitFor(() =>
      expect(screen.getAllByTestId("machine-agent-accounts-row")).toHaveLength(1),
    );
  } finally {
    listener.mockReset();
    listener.mockImplementation(() => Promise.resolve(() => {}));
  }
});

for (const nodeId of ["bk_self", null]) {
  test(`self Rebuild opens local Container settings with nodeId ${nodeId}`, async () => {
    const originalDialogs = useAppDialogStore.getState();
    const originalUI = useUIStore.getState();
    portalStore.store.setState({ selfId: "bk_self" as never });
    useRemoteWorkspaceStore.setState({ active: null });
    install({
      status: { ...commandStatus, nodeId: nodeId as never },
      maintenance: {
        self: {
          ...current,
          image: {
            name: "orkestrator-v2:latest",
            present: true,
            compatible: true,
            reason: null,
            releaseReference: "ghcr.io/orkestrator-ai/orkestrator-v2:2.25.0",
            outdatedEnvironments: [{ id: "env-self", projectId: "project-1", name: "self-old" }],
          },
        },
      },
    });
    installDesktop();
    const closeSettings = mock(() => undefined);
    const stopListening = onGlobalSettingsCloseRequest(closeSettings);
    try {
      await renderPage();
      fireEvent.click(within(row("Desk")).getByRole("button", { name: /^Updates for Desk/ }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(await within(dialog).findByRole("button", { name: "Rebuild self-old" }));
      expect(closeSettings).toHaveBeenCalledTimes(1);
      expectDomAbsent(screen.queryByText("Updates for Desk"));
      expect(useRemoteWorkspaceStore.getState().active).toBeNull();
      expect(useUIStore.getState().selectedEnvironmentId).toBe("env-self");
      expect(useAppDialogStore.getState().request).toEqual({
        kind: "environment-settings",
        environmentId: "env-self",
        section: "container",
      });
    } finally {
      stopListening();
      portalStore.store.setState(originalPortal, true);
      useRemoteWorkspaceStore.setState(originalRemote, true);
      useAppDialogStore.setState(originalDialogs, true);
      useUIStore.setState(originalUI, true);
    }
  });
}
