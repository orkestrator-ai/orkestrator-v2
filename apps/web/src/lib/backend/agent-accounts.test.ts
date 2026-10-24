import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { listAgentAccounts, setActiveAgentAccount } from "./agent-accounts";
import { startGitHubCliLogin } from "./docker-skills";
import { cursorSdkLoginStart } from "./config-integrations";
import { startOpenCodeProviderLogin } from "./opencode-provider-auth";
import { OutcomeUnknownError, portalStore } from "@/lib/portal/portal-store";

const workspace = invoke as unknown as ReturnType<typeof mock>;
const portal = mock(
  async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => ({
    outcome: "ok",
    result: {},
  }),
);
beforeEach(() => {
  workspace.mockReset();
  portal.mockReset();
  portal.mockImplementation(async () => ({ outcome: "ok", result: {} }));
  window.orkestratorPortal = { invoke: portal } as never;
  window.orkestratorWorkspaceTarget = { nodeId: "leaf", nodeName: "Leaf", path: "direct" };
});
afterEach(() => {
  delete window.orkestratorPortal;
  delete window.orkestratorWorkspaceTarget;
  workspace.mockReset();
});

test("an omitted machine reads the view backend; explicit command-node reads and writes use the portal", async () => {
  await listAgentAccounts();
  expect(workspace).toHaveBeenCalledWith("list_agent_accounts", {});
  workspace.mockClear();
  await listAgentAccounts(null);
  await setActiveAgentAccount("claude", "work", null);
  expect(portal).toHaveBeenCalledWith("list_agent_accounts", {});
  expect(portal).toHaveBeenCalledWith("set_active_agent_account", {
    platform: "claude",
    accountId: "work",
  });
  expect(workspace).not.toHaveBeenCalled();
});

test("all sign-in clients route the selected machine through invoke_on_node", async () => {
  await startGitHubCliLogin("leaf");
  await cursorSdkLoginStart("leaf");
  await startOpenCodeProviderLogin({ providerId: "anthropic", method: 0 }, "leaf");
  expect(
    portal.mock.calls.map(([command, args]) => [command, args?.nodeId, args?.command]),
  ).toEqual([
    ["invoke_on_node", "leaf", "start_github_cli_login"],
    ["invoke_on_node", "leaf", "cursor_sdk_login_start"],
    ["invoke_on_node", "leaf", "start_opencode_provider_login"],
  ]);
  expect(workspace).not.toHaveBeenCalled();
});

test("remote writes propagate unavailable and unknown outcomes without retrying locally", async () => {
  const unavailable = Object.assign(new Error("offline"), { name: "NodeUnavailableError" });
  portal.mockRejectedValueOnce(unavailable);
  await expect(setActiveAgentAccount("claude", "work", "leaf")).rejects.toBe(unavailable);
  const revision = portalStore.getState().outcomesRevision;
  portal.mockResolvedValueOnce({ outcome: "unknown", requestKey: "request", outcomeId: "outcome" });
  await expect(setActiveAgentAccount("claude", "work", "leaf")).rejects.toBeInstanceOf(
    OutcomeUnknownError,
  );
  expect(portalStore.getState().outcomesRevision).toBe(revision + 1);
  expect(portal).toHaveBeenCalledTimes(2);
  expect(workspace).not.toHaveBeenCalled();
});
