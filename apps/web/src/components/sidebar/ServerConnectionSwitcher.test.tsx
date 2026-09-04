import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConnectionList } from "@orkestrator/protocol/connections";
import { publishConnections } from "@/lib/connections";
import { ServerConnectionSwitcher } from "./ServerConnectionSwitcher";

const originalReload = window.location.reload;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function installConnections(
  list: ConnectionList,
  overrides: Partial<{
    list: () => Promise<ConnectionList>;
    probe: (connectionId: string) => Promise<boolean>;
    connect: (input: { address: string; token: string }) => Promise<ConnectionList>;
    updateToken: (connectionId: string, token: string) => Promise<ConnectionList>;
    use: (connectionId: string) => Promise<ConnectionList>;
    forget: (connectionId: string) => Promise<ConnectionList>;
  }> = {},
) {
  const listConnections = mock(overrides.list ?? (async () => list));
  const probe = mock(overrides.probe ?? (async () => true));
  const connect = mock(overrides.connect ?? (async () => list));
  const updateToken = mock(overrides.updateToken ?? (async () => list));
  const use = mock(overrides.use ?? (async () => list));
  const forget = mock(overrides.forget ?? (async () => list));
  window.orkestrator = {
    invoke: mock(async () => undefined) as unknown as NonNullable<Window["orkestrator"]>["invoke"],
    listen: mock(() => () => undefined),
    clipboard: {
      readText: mock(async () => ""),
      writeText: mock(async () => undefined),
      readImage: mock(async () => null),
      writeImage: mock(async () => undefined),
    },
    dialog: { open: mock(async () => null) },
    connections: {
      list: listConnections,
      probe,
      connect,
      updateToken,
      use,
      forget,
    },
    process: { exit: mock(async () => undefined) },
    window: { startDragging: mock(async () => undefined) },
  };
  return { list: listConnections, probe, connect, updateToken, use, forget };
}

afterEach(() => {
  cleanup();
  delete window.orkestrator;
  window.location.reload = originalReload;
});

describe("server connection switcher", () => {
  test("shows Local, recent servers, and the separated new-connection action", async () => {
    installConnections({
      activeConnectionId: "local",
      connections: [
        {
          id: "local",
          name: "Local",
          address: null,
          kind: "local",
          active: true,
          requiresToken: false,
        },
        {
          id: "remote-1",
          name: "desk.tailnet.ts.net",
          address: "https://desk.tailnet.ts.net",
          kind: "remote",
          active: false,
          requiresToken: false,
        },
      ],
    });
    render(<ServerConnectionSwitcher />);

    const trigger = await screen.findByRole("button", { name: "Connected server: Local" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    expect(await screen.findByText("desk.tailnet.ts.net")).toBeTruthy();
    fireEvent.click(screen.getByText("New connection"));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("Tailscale address")).toBeTruthy();
    expect(screen.getByText(/operating system’s secure credential storage/)).toBeTruthy();
  });

  test("probes the active server automatically and inactive servers only on row intent", async () => {
    const list: ConnectionList = {
      activeConnectionId: "local",
      connections: [
        {
          id: "local",
          name: "Local",
          address: null,
          kind: "local",
          active: true,
          requiresToken: false,
        },
        {
          id: "ready",
          name: "Ready desk",
          address: "https://ready.example",
          kind: "remote",
          active: false,
          requiresToken: false,
        },
        {
          id: "offline",
          name: "Offline desk",
          address: "https://offline.example",
          kind: "remote",
          active: false,
          requiresToken: false,
        },
      ],
    };
    const probe = mock(async (connectionId: string) => connectionId !== "offline");
    installConnections(list, { probe });
    render(<ServerConnectionSwitcher />);

    await waitFor(() => expect(probe).toHaveBeenCalledWith("local"));
    expect(probe.mock.calls.every(([connectionId]) => connectionId === "local")).toBe(true);

    fireEvent.pointerDown(await screen.findByRole("button", { name: "Connected server: Local" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });

    const readyItem = await screen.findByRole("menuitem", {
      name: /Ready desk.*status: not checked/,
    });
    const offlineItem = screen.getByRole("menuitem", {
      name: /Offline desk.*status: not checked/,
    });
    expect(probe.mock.calls.every(([connectionId]) => connectionId === "local")).toBe(true);

    // happy-dom does not reproduce Radix's automatic initial item focus, so
    // explicitly consume the focus event that menu open produces in a browser.
    fireEvent.focus(screen.getByRole("menuitem", { name: /Local.*status:/ }));
    fireEvent.pointerMove(readyItem);
    expect(await screen.findByRole("menuitem", { name: /Ready desk.*status: ready/ })).toBeTruthy();
    fireEvent.focus(offlineItem);
    expect(
      await screen.findByRole("menuitem", { name: /Offline desk.*status: unavailable/ }),
    ).toBeTruthy();
    expect(probe.mock.calls.some(([connectionId]) => connectionId === "ready")).toBe(true);
    expect(probe.mock.calls.some(([connectionId]) => connectionId === "offline")).toBe(true);
  });

  test("does not probe an inactive remote merely because menu open focuses its row", async () => {
    const { probe } = installConnections({
      activeConnectionId: "active",
      connections: [
        {
          id: "inactive",
          name: "Inactive",
          address: "https://inactive.example",
          kind: "remote",
          active: false,
          requiresToken: false,
        },
        {
          id: "active",
          name: "Active",
          address: "https://active.example",
          kind: "remote",
          active: true,
          requiresToken: false,
        },
      ],
    });
    render(<ServerConnectionSwitcher />);
    await waitFor(() => expect(probe).toHaveBeenCalledWith("active"));
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Connected server: Active" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });

    const inactive = await screen.findByRole("menuitem", { name: /Inactive.*status:/ });
    fireEvent.focus(inactive);
    expect(probe.mock.calls.every(([connectionId]) => connectionId === "active")).toBe(true);

    fireEvent.pointerMove(inactive);
    await waitFor(() => expect(probe).toHaveBeenCalledWith("inactive"));
    fireEvent.pointerMove(inactive);
    expect(probe.mock.calls.filter(([connectionId]) => connectionId === "inactive")).toHaveLength(
      1,
    );
  });

  test("treats a failed readiness probe as unavailable", async () => {
    const list: ConnectionList = {
      activeConnectionId: "local",
      connections: [
        {
          id: "local",
          name: "Local",
          address: null,
          kind: "local",
          active: true,
          requiresToken: false,
        },
      ],
    };
    installConnections(list, {
      probe: mock(async () => {
        throw new Error("probe failed");
      }),
    });
    render(<ServerConnectionSwitcher />);

    fireEvent.pointerDown(await screen.findByRole("button", { name: "Connected server: Local" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });

    expect(
      await screen.findByRole("menuitem", { name: /Local.*status: unavailable/ }),
    ).toBeTruthy();
  });

  test("reports a missing credential as token required without probing it", async () => {
    const list: ConnectionList = {
      activeConnectionId: "current",
      connections: [
        {
          id: "current",
          name: "Current",
          address: "https://current.example",
          kind: "remote",
          active: true,
          requiresToken: false,
        },
        {
          id: "saved",
          name: "Saved",
          address: "https://saved.example",
          kind: "remote",
          active: false,
          requiresToken: true,
        },
      ],
    };
    const { probe } = installConnections(list);
    render(<ServerConnectionSwitcher />);
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Connected server: Current" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );

    const saved = await screen.findByRole("menuitem", { name: /Saved.*status: token required/ });
    fireEvent.pointerMove(saved);
    fireEvent.focus(saved);
    expect(probe.mock.calls.some(([connectionId]) => connectionId === "saved")).toBe(false);
    expect(screen.queryByRole("menuitem", { name: /Saved.*status: unavailable/ }) === null).toBe(
      true,
    );
  });

  test("keeps the active badge neutral until checked and ignores superseded results", async () => {
    const first = deferred<boolean>();
    const probe = mock()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    installConnections(
      {
        activeConnectionId: "active",
        connections: [
          {
            id: "active",
            name: "Active",
            address: "https://active.example",
            kind: "remote",
            active: true,
            requiresToken: false,
          },
        ],
      },
      { probe },
    );
    render(<ServerConnectionSwitcher />);
    const trigger = await screen.findByRole("button", { name: "Connected server: Active" });
    await waitFor(() => expect(trigger.querySelector('[data-status="checking"]')).toBeTruthy());

    fireEvent.focus(window);
    await waitFor(() => expect(trigger.querySelector('[data-status="ready"]')).toBeTruthy());
    await act(async () => first.resolve(false));
    expect(trigger.querySelector('[data-status="ready"]')).toBeTruthy();

    fireEvent.focus(window);
    await waitFor(() => expect(trigger.querySelector('[data-status="unavailable"]')).toBeTruthy());
    fireEvent.focus(window);
    await waitFor(() => expect(trigger.querySelector('[data-status="ready"]')).toBeTruthy());
  });

  test("discards an active probe result after unmount", async () => {
    const pending = deferred<boolean>();
    const { probe } = installConnections(
      {
        activeConnectionId: "local",
        connections: [
          {
            id: "local",
            name: "Local",
            address: null,
            kind: "local",
            active: true,
            requiresToken: false,
          },
        ],
      },
      { probe: mock(() => pending.promise) },
    );
    const rendered = render(<ServerConnectionSwitcher />);
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    rendered.unmount();
    await act(async () => pending.resolve(true));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  test("prefills a remembered browser server when its tab token is missing", async () => {
    installConnections({
      activeConnectionId: "current",
      connections: [
        {
          id: "current",
          name: "current.example",
          address: "https://current.example",
          kind: "remote",
          active: true,
          requiresToken: false,
        },
        {
          id: "saved",
          name: "saved.example",
          address: "https://saved.example",
          kind: "remote",
          active: false,
          requiresToken: true,
        },
      ],
    });
    render(<ServerConnectionSwitcher />);

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Connected server: current.example" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(await screen.findByText("saved.example"));
    expect((screen.getByLabelText("Tailscale address") as HTMLInputElement).value).toBe(
      "https://saved.example",
    );
    expect(screen.getByText(/Kept for this app session only/)).toBeTruthy();
  });

  test("keeps the dialog open with a useful connection error", async () => {
    const connect = mock(async () => {
      throw new Error("The gateway token was rejected.");
    });
    installConnections(
      {
        activeConnectionId: "local",
        connections: [
          {
            id: "local",
            name: "Local",
            address: null,
            kind: "local",
            active: true,
            requiresToken: false,
          },
        ],
      },
      { connect },
    );
    render(<ServerConnectionSwitcher />);

    fireEvent.pointerDown(await screen.findByRole("button", { name: "Connected server: Local" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByText("New connection"));
    fireEvent.change(screen.getByLabelText("Tailscale address"), {
      target: { value: "https://desk.example" },
    });
    fireEvent.change(screen.getByLabelText("Gateway token"), {
      target: { value: "gateway-token-123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("token was rejected"),
    );
    expect(connect).toHaveBeenCalledWith({
      address: "https://desk.example",
      token: "gateway-token-123456",
    });
  });

  test("falls back to the Projects label without a connections API", () => {
    render(<ServerConnectionSwitcher />);
    expect(screen.getByText("Projects")).toBeTruthy();
  });

  test("rehydrates from published connection snapshots and unsubscribes on unmount", async () => {
    const initial: ConnectionList = {
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
        },
      ],
    };
    installConnections(initial);
    const view = render(<ServerConnectionSwitcher />);
    await screen.findByRole("button", { name: "Connected server: Local" });

    const remoteList: ConnectionList = {
      activeConnectionId: "remote-1",
      credentialStorage: "secure",
      connections: [
        { ...initial.connections[0]!, active: false },
        {
          id: "remote-1",
          name: "desk.example",
          address: "https://desk.example",
          kind: "remote",
          active: true,
          requiresToken: false,
        },
      ],
    };
    act(() => publishConnections(remoteList));
    expect(
      await screen.findByRole("button", { name: "Connected server: desk.example" }),
    ).toBeTruthy();

    view.unmount();
    act(() => publishConnections(initial));
  });

  test("switches to a saved server and reloads after the backend confirms", async () => {
    const list = {
      activeConnectionId: "local",
      connections: [
        {
          id: "local",
          name: "Local",
          address: null,
          kind: "local" as const,
          active: true,
          requiresToken: false,
        },
        {
          id: "remote-1",
          name: "Desk",
          address: "https://desk.example",
          kind: "remote" as const,
          active: false,
          requiresToken: false,
        },
      ],
    };
    const { use } = installConnections(list);
    const reload = mock(() => undefined);
    window.location.reload = reload as unknown as typeof window.location.reload;
    render(<ServerConnectionSwitcher />);

    fireEvent.pointerDown(await screen.findByRole("button", { name: "Connected server: Local" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByText("Desk"));
    await waitFor(() => expect(use).toHaveBeenCalledWith("remote-1"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("recovers when switching a saved server fails", async () => {
    const list = {
      activeConnectionId: "local",
      connections: [
        {
          id: "local",
          name: "Local",
          address: null,
          kind: "local" as const,
          active: true,
          requiresToken: false,
        },
        {
          id: "remote-1",
          name: "Desk",
          address: "https://desk.example",
          kind: "remote" as const,
          active: false,
          requiresToken: false,
        },
      ],
    };
    const use = mock(async () => {
      throw new Error("server unavailable");
    });
    installConnections(list, { use });
    const reload = mock(() => undefined);
    window.location.reload = reload as unknown as typeof window.location.reload;
    render(<ServerConnectionSwitcher />);

    fireEvent.pointerDown(await screen.findByRole("button", { name: "Connected server: Local" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByText("Desk"));
    await waitFor(() => expect(use).toHaveBeenCalledWith("remote-1"));
    expect(reload).not.toHaveBeenCalled();
  });

  test("reloads after successfully creating a connection", async () => {
    const list = {
      activeConnectionId: "local",
      connections: [
        {
          id: "local",
          name: "Local",
          address: null,
          kind: "local" as const,
          active: true,
          requiresToken: false,
        },
      ],
    };
    const { connect } = installConnections(list);
    const reload = mock(() => undefined);
    window.location.reload = reload as unknown as typeof window.location.reload;
    render(<ServerConnectionSwitcher />);

    fireEvent.pointerDown(await screen.findByRole("button", { name: "Connected server: Local" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByText("New connection"));
    fireEvent.change(screen.getByLabelText("Tailscale address"), {
      target: { value: "https://desk.example" },
    });
    fireEvent.change(screen.getByLabelText("Gateway token"), {
      target: { value: "gateway-token-123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("handles an initial connection-list failure without crashing", async () => {
    const list = { activeConnectionId: "local", connections: [] };
    const listConnections = mock(async () => {
      throw new Error("storage unavailable");
    });
    installConnections(list, { list: listConnections });
    render(<ServerConnectionSwitcher />);
    await waitFor(() => expect(listConnections).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Connected server: Loading" })).toBeTruthy();
  });
});
