import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { GitHubCliSetup } from "@/components/github/GitHubCliSetup";
import { CursorSdkSignIn } from "./agent/CursorSdkSignIn";
import { OpenCodeProviderSignIn } from "@/components/opencode/OpenCodeProviderSignIn";
import { AccountMachineProvider } from "./account-machine";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";

/** The window's command node: its own answers, another machine's through it. */
const workspace = invoke as unknown as ReturnType<typeof mock>;
async function commandNode(command: string, args?: Record<string, unknown>): Promise<unknown> {
  if (command === "invoke_on_node")
    return { outcome: "ok", result: response(String(args?.command)) };
  return response(command);
}
function response(command: string): unknown {
  switch (command) {
    case "get_github_cli_status":
      return { installed: true, authenticated: false, canSignIn: true, reminderDismissed: false };
    case "cursor_sdk_login_status":
      return { state: "idle", auth: { authenticated: false, source: "none" } };
    case "cursor_sdk_login_start":
      return { loginUrl: "https://example.com/login" };
    case "get_github_cli_login":
    case "get_opencode_provider_login":
      return { state: "idle" };
    case "start_github_cli_login":
      return {
        state: "pending",
        operationId: "github",
        userCode: "CODE",
        url: "https://example.com/login",
      };
    case "start_opencode_provider_login":
      return {
        state: "pending",
        providerId: "anthropic",
        operationId: "opencode",
        url: "https://example.com/login",
        method: "code",
      };
    default:
      return undefined;
  }
}
beforeEach(() => {
  // The previous test's sign-ins scheduled a debounced node refresh. Firing
  // between tests, it lands on this mock after afterEach.
  workspace.mockClear();
  workspace.mockImplementation(commandNode);
});
afterEach(async () => {
  await act(async () => cleanup());
  resetReadCoordinatorForTests();
  workspace.mockReset();
});

{
  const machine = "leaf";
  test("Settings sign-in controls deliver the selected machine to their backend calls", async () => {
    render(
      <AccountMachineProvider value={{ machine, name: "Selected machine" }}>
        <GitHubCliSetup />
        <CursorSdkSignIn credentialRevision="signed-out" />
        <OpenCodeProviderSignIn
          provider={{
            id: "anthropic",
            label: "Anthropic",
            connected: false,
            storedLogin: false,
            allowed: true,
            methods: [{ index: 0, type: "oauth", label: "Browser code", prompts: [] }],
          }}
          onSignedIn={() => {}}
        />
      </AccountMachineProvider>,
    );
    const github = await screen.findByRole("button", { name: "Sign in to GitHub" });
    await act(async () => fireEvent.click(github));
    const cursor = await screen.findByRole("button", { name: "Sign in with Cursor" });
    await act(async () => fireEvent.click(cursor));
    const opencode = await screen.findByRole("button", { name: /Continue in browser/ });
    await act(async () => fireEvent.click(opencode));
    for (const command of [
      "start_github_cli_login",
      "cursor_sdk_login_start",
      "start_opencode_provider_login",
    ]) {
      expect(
        workspace.mock.calls.some(
          ([called, args]) =>
            called === "invoke_on_node" && args?.nodeId === machine && args?.command === command,
        ),
      ).toBe(true);
    }
    // Cursor opens the returned link on the client; all login commands still
    // run on the selected machine rather than this window's own node.
    expect(
      workspace.mock.calls.filter(
        ([command]) =>
          command !== "invoke_on_node" &&
          command !== "get_node_status" &&
          command !== "get_node_summaries",
      ),
    ).toEqual([["open_in_browser", { url: "https://example.com/login" }]]);
    const cursorStart = workspace.mock.calls.find(
      ([called, args]) => called === "invoke_on_node" && args?.command === "cursor_sdk_login_start",
    )!;
    expect(cursorStart[1]?.args).toEqual({ openBrowser: false });
  });
}

test("an unscoped sign-in runs on the window's own node", async () => {
  render(<GitHubCliSetup />);
  const github = await screen.findByRole("button", { name: "Sign in to GitHub" });
  await act(async () => fireEvent.click(github));
  expect(workspace).toHaveBeenCalledWith("start_github_cli_login", {});
  expect(workspace.mock.calls.some(([command]) => command === "invoke_on_node")).toBe(false);
});
