import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConnectionList } from "@orkestrator/protocol/connections";
import { ServerConnectionSwitcher } from "./ServerConnectionSwitcher";

const originalReload = window.location.reload;

function installConnections(
  list: ConnectionList,
  overrides: Partial<{
    list: () => Promise<ConnectionList>;
    connect: (input: { address: string; token: string }) => Promise<ConnectionList>;
    use: (connectionId: string) => Promise<ConnectionList>;
    forget: (connectionId: string) => Promise<ConnectionList>;
  }> = {},
) {
  const listConnections = mock(overrides.list ?? (async () => list));
  const connect = mock(overrides.connect ?? (async () => list));
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
      connect,
      use,
      forget,
    },
    process: { exit: mock(async () => undefined) },
    window: { startDragging: mock(async () => undefined) },
  };
  return { list: listConnections, connect, use, forget };
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
        { id: "local", name: "Local", address: null, kind: "local", active: true, requiresToken: false },
        { id: "remote-1", name: "desk.tailnet.ts.net", address: "https://desk.tailnet.ts.net", kind: "remote", active: false, requiresToken: false },
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

  test("prefills a remembered browser server when its tab token is missing", async () => {
    installConnections({
      activeConnectionId: "current",
      connections: [
        { id: "current", name: "current.example", address: "https://current.example", kind: "remote", active: true, requiresToken: false },
        { id: "saved", name: "saved.example", address: "https://saved.example", kind: "remote", active: false, requiresToken: true },
      ],
    });
    render(<ServerConnectionSwitcher />);

    fireEvent.pointerDown(await screen.findByRole("button", { name: "Connected server: current.example" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByText("saved.example"));
    expect((screen.getByLabelText("Tailscale address") as HTMLInputElement).value).toBe("https://saved.example");
    expect(screen.getByText(/Kept for this app session only/)).toBeTruthy();
  });

  test("keeps the dialog open with a useful connection error", async () => {
    const connect = mock(async () => { throw new Error("The gateway token was rejected."); });
    installConnections({ activeConnectionId: "local", connections: [
      { id: "local", name: "Local", address: null, kind: "local", active: true, requiresToken: false },
    ] }, { connect });
    render(<ServerConnectionSwitcher />);

    fireEvent.pointerDown(await screen.findByRole("button", { name: "Connected server: Local" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByText("New connection"));
    fireEvent.change(screen.getByLabelText("Tailscale address"), { target: { value: "https://desk.example" } });
    fireEvent.change(screen.getByLabelText("Gateway token"), { target: { value: "gateway-token-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("token was rejected"));
    expect(connect).toHaveBeenCalledWith({ address: "https://desk.example", token: "gateway-token-123456" });
  });

  test("falls back to the Projects label without a connections API", () => {
    render(<ServerConnectionSwitcher />);
    expect(screen.getByText("Projects")).toBeTruthy();
  });

  test("switches to a saved server and reloads after the backend confirms", async () => {
    const list = {
      activeConnectionId: "local",
      connections: [
        { id: "local", name: "Local", address: null, kind: "local" as const, active: true, requiresToken: false },
        { id: "remote-1", name: "Desk", address: "https://desk.example", kind: "remote" as const, active: false, requiresToken: false },
      ],
    };
    const { use } = installConnections(list);
    const reload = mock(() => undefined);
    window.location.reload = reload as unknown as typeof window.location.reload;
    render(<ServerConnectionSwitcher />);

    fireEvent.pointerDown(await screen.findByRole("button", { name: "Connected server: Local" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByText("Desk"));
    await waitFor(() => expect(use).toHaveBeenCalledWith("remote-1"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("recovers when switching a saved server fails", async () => {
    const list = {
      activeConnectionId: "local",
      connections: [
        { id: "local", name: "Local", address: null, kind: "local" as const, active: true, requiresToken: false },
        { id: "remote-1", name: "Desk", address: "https://desk.example", kind: "remote" as const, active: false, requiresToken: false },
      ],
    };
    const use = mock(async () => { throw new Error("server unavailable"); });
    installConnections(list, { use });
    const reload = mock(() => undefined);
    window.location.reload = reload as unknown as typeof window.location.reload;
    render(<ServerConnectionSwitcher />);

    fireEvent.pointerDown(await screen.findByRole("button", { name: "Connected server: Local" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByText("Desk"));
    await waitFor(() => expect(use).toHaveBeenCalledWith("remote-1"));
    expect(reload).not.toHaveBeenCalled();
  });

  test("reloads after successfully creating a connection", async () => {
    const list = { activeConnectionId: "local", connections: [
      { id: "local", name: "Local", address: null, kind: "local" as const, active: true, requiresToken: false },
    ] };
    const { connect } = installConnections(list);
    const reload = mock(() => undefined);
    window.location.reload = reload as unknown as typeof window.location.reload;
    render(<ServerConnectionSwitcher />);

    fireEvent.pointerDown(await screen.findByRole("button", { name: "Connected server: Local" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByText("New connection"));
    fireEvent.change(screen.getByLabelText("Tailscale address"), { target: { value: "https://desk.example" } });
    fireEvent.change(screen.getByLabelText("Gateway token"), { target: { value: "gateway-token-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("handles an initial connection-list failure without crashing", async () => {
    const list = { activeConnectionId: "local", connections: [] };
    const listConnections = mock(async () => { throw new Error("storage unavailable"); });
    installConnections(list, { list: listConnections });
    render(<ServerConnectionSwitcher />);
    await waitFor(() => expect(listConnections).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Connected server: Loading" })).toBeTruthy();
  });
});
