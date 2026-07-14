import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConnectionList } from "@orkestrator/protocol/connections";
import { ServerConnectionSwitcher } from "./ServerConnectionSwitcher";

function installConnections(list: ConnectionList, connect = mock(async () => list)) {
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
      list: mock(async () => list),
      connect,
      use: mock(async () => list),
      forget: mock(async () => list),
    },
    process: { exit: mock(async () => undefined) },
    window: { startDragging: mock(async () => undefined) },
  };
  return { connect };
}

afterEach(() => {
  cleanup();
  delete window.orkestrator;
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
    ] }, connect);
    render(<ServerConnectionSwitcher />);

    fireEvent.pointerDown(await screen.findByRole("button", { name: "Connected server: Local" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByText("New connection"));
    fireEvent.change(screen.getByLabelText("Tailscale address"), { target: { value: "https://desk.example" } });
    fireEvent.change(screen.getByLabelText("Gateway token"), { target: { value: "gateway-token-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("token was rejected"));
    expect(connect).toHaveBeenCalledWith({ address: "https://desk.example", token: "gateway-token-123456" });
  });
});
