import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Credential = {
  id: string;
  label: string;
  profile: "voice" | "full" | "read-only" | "custom";
  capabilities: string[];
  deniedActions: string[];
  token: string;
  createdAt: string;
  lastUsedAt: string | null;
};
type Settings = {
  enabled: boolean;
  running: boolean;
  url: string;
  token: string;
  error: string | null;
  credentials: Credential[];
};

const defaultCredential: Credential = {
  id: "default",
  label: "Default",
  profile: "full",
  capabilities: ["discovery", "sessions.read"],
  deniedActions: [],
  token: "persistent-test-token-1234567890",
  createdAt: new Date(0).toISOString(),
  lastUsedAt: null,
};
const healthySettings: Settings = {
  enabled: true,
  running: true,
  url: "http://127.0.0.1:34122/mcp",
  token: defaultCredential.token,
  error: null,
  credentials: [defaultCredential],
};
let settingsResponse: Settings = healthySettings;
let settingsFailure: Error | null = null;

const invoke = mock((command: string, args?: Record<string, unknown>) => {
  if (command === "get_control_mcp_settings") {
    return settingsFailure ? Promise.reject(settingsFailure) : Promise.resolve(settingsResponse);
  }
  if (command === "rotate_control_mcp_credential") {
    const rotated = { ...defaultCredential, token: "rotated-test-token-123456789012" };
    return Promise.resolve({ ...healthySettings, token: rotated.token, credentials: [rotated] });
  }
  if (command === "create_control_mcp_credential") {
    const created: Credential = {
      ...defaultCredential,
      id: "voice-assistant-1a2b3c",
      label: String(args?.label),
      profile: args?.profile as Credential["profile"],
      token: "voice-test-token-12345678901234567",
    };
    return Promise.resolve({ ...healthySettings, credentials: [defaultCredential, created] });
  }
  if (command === "revoke_control_mcp_credential") {
    return Promise.resolve({ ...healthySettings, token: "", credentials: [] });
  }
  return Promise.reject(new Error(`Unexpected command: ${command}`));
});
const writeText = mock(async (_value: string) => undefined);

mock.module("@/lib/native/backend", () => ({ invoke }));
mock.module("@/lib/native/clipboard", () => ({
  readImage: mock(() => Promise.reject(new Error("No image in clipboard"))),
  readText: mock(() => Promise.resolve("")),
  writeText,
}));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({ invoke: mock(() => Promise.resolve()) }));
});

const { McpSettings } = await import("./McpSettings");

beforeEach(() => {
  invoke.mockClear();
  writeText.mockClear();
  settingsResponse = healthySettings;
  settingsFailure = null;
});

afterEach(cleanup);

describe("McpSettings", () => {
  test("lists credentials and copies complete setup for each client", async () => {
    render(<McpSettings />);

    await screen.findByText("Control Orkestrator from another agent");
    expect(screen.getByDisplayValue("http://127.0.0.1:34122/mcp")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show setup for Default" })).toBeTruthy();
    const token = screen.getByDisplayValue("persistent-test-token-1234567890");
    expect(token.getAttribute("type")).toBe("password");
    expect(document.body.textContent).not.toContain("persistent-test-token-1234567890");

    const copies = screen.getAllByRole("button", { name: "Copy setup" });
    expect(copies).toHaveLength(3);
    fireEvent.click(copies[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain("[mcp_servers.orkestrator]");
    expect(writeText.mock.calls[0]?.[0]).toContain(
      'Authorization = "Bearer persistent-test-token-1234567890"',
    );
    fireEvent.click(copies[2]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(JSON.parse(writeText.mock.calls[1]![0])).toEqual({
      url: "http://127.0.0.1:34122/mcp",
      transport: "streamable-http",
      headers: { Authorization: "Bearer persistent-test-token-1234567890" },
    });
  });

  test("rotates one credential only after confirmation and shows its new token", async () => {
    render(<McpSettings />);
    await screen.findByText("Control Orkestrator from another agent");

    fireEvent.click(screen.getByRole("button", { name: "Rotate Default" }));
    const dialog = screen.getByRole("alertdialog", { name: "Rotate Default's token?" });
    const overlay = document.querySelector<HTMLElement>('[data-slot="alert-dialog-overlay"]')!;
    expect(dialog.className).toContain("z-[80]");
    expect(dialog.className).not.toContain("z-50");
    expect(overlay.className).toContain("z-[80]");
    expect(overlay.className).not.toContain("z-50");
    fireEvent.click(screen.getByRole("button", { name: "Rotate token" }));

    await waitFor(() =>
      expect(screen.getByDisplayValue("rotated-test-token-123456789012")).toBeTruthy(),
    );
    expect(invoke.mock.calls).toContainEqual([
      "rotate_control_mcp_credential",
      { credentialId: "default" },
    ]);
    expect(screen.getByDisplayValue("rotated-test-token-123456789012").getAttribute("type")).toBe(
      "text",
    );
  });

  test("creates a voice credential and switches the setup to it", async () => {
    render(<McpSettings />);
    await screen.findByText("Control Orkestrator from another agent");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Voice assistant" } });
    expect(document.body.textContent).toContain("spoken confirmation before risky actions");
    fireEvent.click(screen.getByRole("button", { name: "Create credential" }));

    await screen.findByText("Set up a client with Voice assistant");
    expect(invoke.mock.calls).toContainEqual([
      "create_control_mcp_credential",
      { label: "Voice assistant", profile: "voice" },
    ]);
    expect(screen.getByDisplayValue("voice-test-token-12345678901234567")).toBeTruthy();
  });

  test("revokes a credential after confirmation", async () => {
    render(<McpSettings />);
    await screen.findByText("Control Orkestrator from another agent");

    fireEvent.click(screen.getByRole("button", { name: "Revoke Default" }));
    screen.getByRole("alertdialog", { name: "Revoke Default?" });
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    await screen.findByText("No credentials. Create one below to connect a client.");
    expect(invoke.mock.calls).toContainEqual([
      "revoke_control_mcp_credential",
      { credentialId: "default" },
    ]);
    expect(screen.queryByRole("button", { name: "Copy setup" }) === null).toBe(true);
  });

  test("hides unusable credentials and setup recipes while disabled", async () => {
    settingsResponse = {
      ...healthySettings,
      enabled: false,
      running: false,
      token: "",
      credentials: [],
    };
    render(<McpSettings />);

    await screen.findByText("The local MCP server is disabled for this installation.");
    expect(screen.queryByRole("button", { name: "Copy setup" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Copy access token" }) === null).toBe(true);
    expect(document.body.textContent).not.toContain("••••••••••••");
  });

  test("shows startup errors without offering setup that cannot connect", async () => {
    settingsResponse = {
      ...healthySettings,
      running: false,
      token: "",
      error: "Address already in use",
      credentials: [],
    };
    render(<McpSettings />);

    await screen.findByText("The local MCP server could not start");
    expect(screen.getByText("Address already in use")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy setup" }) === null).toBe(true);
  });

  test("recovers from a settings load failure through Try again", async () => {
    settingsFailure = new Error("Backend unavailable");
    render(<McpSettings />);

    await screen.findByText("Backend unavailable");
    settingsFailure = null;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByText("Listening locally");
    expect(screen.getAllByRole("button", { name: "Copy setup" })).toHaveLength(3);
  });
});
