import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const healthySettings = {
  enabled: true,
  running: true,
  url: "http://127.0.0.1:34122/mcp",
  token: "persistent-test-token-1234567890",
  error: null,
};
let settingsResponse: {
  enabled: boolean;
  running: boolean;
  url: string;
  token: string;
  error: string | null;
} = healthySettings;
let settingsFailure: Error | null = null;

const invoke = mock((command: string) => {
  if (command === "get_control_mcp_settings") {
    return settingsFailure ? Promise.reject(settingsFailure) : Promise.resolve(settingsResponse);
  }
  if (command === "rotate_control_mcp_token") {
    return Promise.resolve({
      enabled: true,
      running: true,
      url: "http://127.0.0.1:34122/mcp",
      token: "rotated-test-token-123456789012",
      error: null,
    });
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
  test("shows the stable connection and copies complete client setup", async () => {
    render(<McpSettings />);

    await screen.findByText("Control Orkestrator from another agent");
    expect(screen.getByDisplayValue("http://127.0.0.1:34122/mcp")).toBeTruthy();
    const token = screen.getByDisplayValue("persistent-test-token-1234567890");
    expect(token.getAttribute("type")).toBe("password");
    expect(document.body.textContent).not.toContain("persistent-test-token-1234567890");

    fireEvent.click(screen.getAllByRole("button", { name: "Copy setup" })[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain("[mcp_servers.orkestrator]");
    expect(writeText.mock.calls[0]?.[0]).toContain(
      'Authorization = "Bearer persistent-test-token-1234567890"',
    );
  });

  test("rotates only after confirmation and displays the replacement token", async () => {
    render(<McpSettings />);
    await screen.findByText("Control Orkestrator from another agent");

    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    expect(screen.getByText("Rotate the MCP token?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rotate token" }));

    await waitFor(() =>
      expect(screen.getByDisplayValue("rotated-test-token-123456789012")).toBeTruthy(),
    );
    expect(invoke.mock.calls.some(([command]) => command === "rotate_control_mcp_token")).toBe(
      true,
    );
    expect(screen.getByDisplayValue("rotated-test-token-123456789012").getAttribute("type")).toBe(
      "text",
    );
  });

  test("hides unusable credentials and setup recipes while disabled", async () => {
    settingsResponse = {
      enabled: false,
      running: false,
      url: "http://127.0.0.1:34122/mcp",
      token: "",
      error: null,
    };
    render(<McpSettings />);

    await screen.findByText("The local MCP server is disabled for this installation.");
    expect(screen.queryByRole("button", { name: "Copy setup" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Copy access token" }) === null).toBe(true);
    expect(document.body.textContent).not.toContain("••••••••••••");
  });

  test("shows startup errors without offering setup that cannot connect", async () => {
    settingsResponse = {
      enabled: true,
      running: false,
      url: "http://127.0.0.1:34122/mcp",
      token: "",
      error: "Address already in use",
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
    expect(screen.getAllByRole("button", { name: "Copy setup" })).toHaveLength(2);
  });
});
