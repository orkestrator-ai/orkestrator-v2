import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { GitHubCliSetup } from "@/components/github/GitHubCliSetup";
import { CursorSdkSignIn } from "./agent/CursorSdkSignIn";
import { OpenCodeProviderSignIn } from "@/components/opencode/OpenCodeProviderSignIn";
import { AccountMachineProvider } from "./account-machine";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";

const workspace = invoke as unknown as ReturnType<typeof mock>;
const portal = mock(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (command === "invoke_on_node")
    return { outcome: "ok", result: response(String(args?.command)) };
  return response(command);
});
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
  workspace.mockImplementation(async (command: string) => response(command));
  portal.mockClear();
  window.orkestratorPortal = { invoke: portal } as never;
  window.orkestratorWorkspaceTarget = { nodeId: "leaf", nodeName: "Leaf", path: "direct" };
});
afterEach(async () => {
  await act(async () => cleanup());
  resetReadCoordinatorForTests();
  delete window.orkestratorPortal;
  delete window.orkestratorWorkspaceTarget;
  workspace.mockReset();
});

for (const machine of ["leaf", null]) {
  test(`Settings sign-in controls deliver ${machine ?? "command node"} to their backend calls`, async () => {
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
      if (machine === null)
        expect(portal.mock.calls.some(([called]) => called === command)).toBe(true);
      else
        expect(
          portal.mock.calls.some(
            ([called, args]) =>
              called === "invoke_on_node" && args?.nodeId === machine && args?.command === command,
          ),
        ).toBe(true);
    }
    // Cursor opens the returned link on the client; all login commands still
    // run on the selected machine rather than this workspace's backend.
    expect(workspace.mock.calls).toEqual([
      ["open_in_browser", { url: "https://example.com/login" }],
    ]);
    const cursorStart = portal.mock.calls.find(([called, args]) =>
      machine === null
        ? called === "cursor_sdk_login_start"
        : called === "invoke_on_node" && args?.command === "cursor_sdk_login_start",
    )!;
    expect(machine === null ? cursorStart[1] : cursorStart[1]?.args).toEqual({
      openBrowser: false,
    });
  });
}

test("an unscoped workspace sign-in follows the leaf instead of the portal", async () => {
  render(<GitHubCliSetup />);
  const github = await screen.findByRole("button", { name: "Sign in to GitHub" });
  await act(async () => fireEvent.click(github));
  expect(workspace).toHaveBeenCalledWith("start_github_cli_login", {});
  // Federation discovery may read the portal in the background. An unscoped
  // sign-in must still send every login operation to the workspace backend.
  expect(
    portal.mock.calls.filter(
      ([command]) => command !== "get_node_status" && command !== "get_node_summaries",
    ),
  ).toEqual([]);
});
