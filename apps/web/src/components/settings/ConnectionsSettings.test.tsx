import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConnectionList } from "@orkestrator/protocol/connections";
import { mockToastError, resetSonnerMocks } from "../../../../../tests/mocks/sonner";
import { ConnectionsSettings } from "./ConnectionsSettings";

const originalReload = window.location.reload;

const initialList: ConnectionList = {
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
    {
      id: "remote-1",
      name: "desk.tailnet.ts.net",
      address: "https://desk.tailnet.ts.net",
      kind: "remote",
      active: false,
      requiresToken: false,
      lastConnectedAt: "2026-08-01T12:00:00.000Z",
    },
  ],
};

function installConnections(
  connectionList: ConnectionList = initialList,
  overrides: Partial<{
    list: () => Promise<ConnectionList>;
    probe: (connectionId: string) => Promise<boolean>;
    connect: (input: { address: string; token: string }) => Promise<ConnectionList>;
    updateToken: (connectionId: string, token: string) => Promise<ConnectionList>;
    use: (connectionId: string) => Promise<ConnectionList>;
    forget: (connectionId: string) => Promise<ConnectionList>;
  }> = {},
) {
  const list = mock(overrides.list ?? (async () => connectionList));
  const probe = mock(overrides.probe ?? (async () => true));
  const connect = mock(overrides.connect ?? (async () => connectionList));
  const updateToken = mock(overrides.updateToken ?? (async () => connectionList));
  const use = mock(overrides.use ?? (async () => connectionList));
  const forget = mock(
    overrides.forget ??
      (async () => ({
        ...connectionList,
        connections: connectionList.connections.filter(
          (connection) => connection.id !== "remote-1",
        ),
      })),
  );
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
    connections: { list, probe, connect, updateToken, use, forget },
    process: { exit: mock(async () => undefined) },
    window: { startDragging: mock(async () => undefined) },
  };
  return { list, probe, connect, updateToken, use, forget };
}

afterEach(() => {
  cleanup();
  resetSonnerMocks();
  delete window.orkestrator;
  window.location.reload = originalReload;
});

describe("ConnectionsSettings", () => {
  test("shows local and remote servers with secure token status", async () => {
    installConnections();
    render(<ConnectionsSettings />);

    expect(await screen.findByText("desk.tailnet.ts.net")).toBeTruthy();
    expect(screen.getByText("Local")).toBeTruthy();
    expect(screen.getByText("1 remote connection")).toBeTruthy();
    expect(screen.getByText(/operating system’s credential storage/)).toBeTruthy();
  });

  test("adds a connection from a bare machine name", async () => {
    const api = installConnections();
    render(<ConnectionsSettings />);
    await screen.findByText("desk.tailnet.ts.net");

    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    const dialog = screen.getByRole("dialog", { name: "Add connection" });
    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!;
    expect(dialog.className).toContain("z-[80]");
    expect(dialog.className).not.toContain("z-50");
    expect(overlay.className).toContain("z-[80]");
    expect(overlay.className).not.toContain("z-50");
    fireEvent.change(screen.getByLabelText("Machine name or HTTPS address"), {
      target: { value: "workstation" },
    });
    fireEvent.change(screen.getByLabelText("Gateway token"), {
      target: { value: "gateway-token-123456" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Connect" }).closest("form")!);

    await waitFor(() =>
      expect(api.connect).toHaveBeenCalledWith({
        address: "workstation",
        token: "gateway-token-123456",
      }),
    );
  });

  test("replaces a saved token without switching connections", async () => {
    const api = installConnections();
    render(<ConnectionsSettings />);
    await screen.findByText("desk.tailnet.ts.net");

    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));
    const dialog = screen.getByRole("dialog", { name: "Replace gateway token" });
    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!;
    expect(dialog.className).toContain("z-[80]");
    expect(dialog.className).not.toContain("z-50");
    expect(overlay.className).toContain("z-[80]");
    expect(overlay.className).not.toContain("z-50");
    fireEvent.change(screen.getByLabelText("New gateway token"), {
      target: { value: "replacement-token-123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    await waitFor(() =>
      expect(api.updateToken).toHaveBeenCalledWith("remote-1", "replacement-token-123456"),
    );
    expect(api.use).not.toHaveBeenCalled();
  });

  test("enters a missing token and switches to that server in one flow", async () => {
    const requiresTokenList: ConnectionList = {
      ...initialList,
      credentialStorage: "session-only",
      connections: initialList.connections.map((connection) =>
        connection.id === "remote-1" ? { ...connection, requiresToken: true } : connection,
      ),
    };
    const api = installConnections(requiresTokenList);
    const reload = mock(() => undefined);
    window.location.reload = reload as unknown as typeof window.location.reload;
    render(<ConnectionsSettings />);

    expect(await screen.findByText("Token required")).toBeTruthy();
    expect(screen.getByText("Tokens are kept only for this app session.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Enter token" }));
    const dialog = screen.getByRole("dialog", { name: "Enter gateway token" });
    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!;
    expect(dialog.className).toContain("z-[80]");
    expect(dialog.className).not.toContain("z-50");
    expect(overlay.className).toContain("z-[80]");
    expect(overlay.className).not.toContain("z-50");
    fireEvent.change(screen.getByLabelText("New gateway token"), {
      target: { value: "replacement-token-123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(api.updateToken).toHaveBeenCalledWith("remote-1", "replacement-token-123456"),
    );
    expect(api.use).toHaveBeenCalledWith("remote-1");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("shows token update errors and re-enables the form", async () => {
    const api = installConnections(initialList, {
      updateToken: async () => {
        throw new Error("The gateway token was rejected.");
      },
    });
    render(<ConnectionsSettings />);
    await screen.findByText("desk.tailnet.ts.net");

    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));
    fireEvent.change(screen.getByLabelText("New gateway token"), {
      target: { value: "rejected-token-123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    expect((await screen.findByRole("alert")).textContent).toContain("token was rejected");
    expect((screen.getByRole("button", { name: "Save token" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(api.use).not.toHaveBeenCalled();
  });

  test("shows a list error and retries loading", async () => {
    let attempts = 0;
    const api = installConnections(initialList, {
      list: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Backend unavailable");
        return initialList;
      },
    });
    render(<ConnectionsSettings />);

    expect((await screen.findByRole("alert")).textContent).toContain("Backend unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("desk.tailnet.ts.net")).toBeTruthy();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  test("removes a saved remote connection after confirmation", async () => {
    const api = installConnections();
    render(<ConnectionsSettings />);
    await screen.findByText("desk.tailnet.ts.net");

    fireEvent.click(screen.getByRole("button", { name: "Remove desk.tailnet.ts.net" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove desk.tailnet.ts.net?" });
    const overlay = document.querySelector<HTMLElement>('[data-slot="alert-dialog-overlay"]')!;
    expect(dialog.className).toContain("z-[80]");
    expect(dialog.className).not.toContain("z-50");
    expect(overlay.className).toContain("z-[80]");
    expect(overlay.className).not.toContain("z-50");
    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));

    await waitFor(() => expect(api.forget).toHaveBeenCalledWith("remote-1"));
    await waitFor(() => expect(screen.queryByText("desk.tailnet.ts.net") === null).toBe(true));
  });

  test("reports a failed removal and leaves the connection visible", async () => {
    installConnections(initialList, {
      forget: async () => {
        throw new Error("Could not save connections");
      },
    });
    render(<ConnectionsSettings />);
    await screen.findByText("desk.tailnet.ts.net");

    fireEvent.click(screen.getByRole("button", { name: "Remove desk.tailnet.ts.net" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Could not remove connection", {
        description: "Could not save connections",
      }),
    );
    expect(screen.getByText("desk.tailnet.ts.net")).toBeTruthy();
  });
});
