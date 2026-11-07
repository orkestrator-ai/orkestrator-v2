import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import {
  getAgentSignInStatus,
  setActiveAgentAccount,
  setAgentAccountAutoSwitchEnabled,
  setAgentAccountAutoSwitchIncluded,
  listMachineAgentAccounts,
  setPreferredAgentIdentity,
  getCoordinatorAccountSwitchGrant,
} from "./agent-accounts";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import { GET_COORDINATOR_ACCOUNT_SWITCH_GRANT_COMMAND } from "@orkestrator/protocol/coordinator-account-switch-grant";
import { listAgentPlugins, startGitHubCliLogin } from "./docker-skills";
import { cursorSdkLoginStart } from "./config-integrations";
import { startOpenCodeProviderLogin } from "./opencode-provider-auth";
import { OutcomeUnknownError, portalStore } from "@/lib/portal/portal-store";

/** The window's command node: its own transport, which suites mock. */
const workspace = invoke as unknown as ReturnType<typeof mock>;
const portal = workspace;
beforeEach(() => {
  workspace.mockReset();
  workspace.mockImplementation(async () => ({ outcome: "ok", result: {} }));
});
afterEach(() => {
  workspace.mockReset();
});

test("all sign-in clients route the selected machine through invoke_on_node", async () => {
  await getAgentSignInStatus("claude", "leaf");
  await startGitHubCliLogin("leaf");
  await cursorSdkLoginStart("leaf");
  await startOpenCodeProviderLogin({ providerId: "anthropic", method: 0 }, "leaf");
  expect(
    portal.mock.calls.map(([command, args]) => [command, args?.nodeId, args?.command]),
  ).toEqual([
    ["invoke_on_node", "leaf", "get_agent_sign_in_status"],
    ["invoke_on_node", "leaf", "start_github_cli_login"],
    ["invoke_on_node", "leaf", "cursor_sdk_login_start"],
    ["invoke_on_node", "leaf", "start_opencode_provider_login"],
  ]);
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
});

test("overview and preferred identity clients use the local backend on a page with no portal to another command node", async () => {
  // The window's own command node: no settings parent.
  const overview = { machines: [], preferred: { claude: "work@example.com" } };
  workspace.mockResolvedValueOnce(overview);
  expect(await listMachineAgentAccounts()).toBe(overview);
  workspace.mockResolvedValueOnce({ claude: "work@example.com" });
  expect(await setPreferredAgentIdentity("claude", "work@example.com")).toEqual({
    claude: "work@example.com",
  });
  workspace.mockResolvedValueOnce({});
  expect(await setPreferredAgentIdentity("claude", null)).toEqual({});
  expect(workspace.mock.calls).toEqual([
    ["list_machine_agent_accounts"],
    ["set_preferred_agent_identity", { platform: "claude", email: "work@example.com" }],
    ["set_preferred_agent_identity", { platform: "claude", email: null }],
  ]);
});

test("overview preference requests propagate command-node failures without a local fallback", async () => {
  const failure = new Error("command node offline");
  portal.mockRejectedValueOnce(failure);
  await expect(listMachineAgentAccounts()).rejects.toBe(failure);
  portal.mockRejectedValueOnce(failure);
  await expect(setPreferredAgentIdentity("claude", null)).rejects.toBe(failure);
  expect(portal).toHaveBeenCalledTimes(2);
});

describe("automatic switching ticks", () => {
  const nodeCalls = () =>
    portal.mock.calls
      .filter(([command]) => command === "invoke_on_node")
      .map(([, args]) => (args as { command: string }).command);

  test("for the machine shown only that machine's pin ends", async () => {
    portal.mockImplementation(async () => ({ outcome: "ok", result: {} }));
    await setAgentAccountAutoSwitchEnabled("claude", true, true, "node-b");
    expect(portal).toHaveBeenCalledWith("set_agent_account_auto_switch", {
      platform: "claude",
      enabled: true,
    });
    expect(portal.mock.calls.map(([command]) => command)).not.toContain(
      "resume_agent_account_auto_switch",
    );
    expect(nodeCalls()).toContain("resume_agent_account_auto_switch");
  });

  test("on the command node itself its own pin ends", async () => {
    portal.mockImplementation(async () => ({}));
    await setAgentAccountAutoSwitchEnabled("claude", true, true, null);
    expect(portal).toHaveBeenCalledWith("resume_agent_account_auto_switch", {
      platform: "claude",
    });
  });

  test("with nothing pinned, or turning it off, no pin is touched", async () => {
    workspace.mockImplementation(async () => ({}));
    await setAgentAccountAutoSwitchEnabled("claude", true, false);
    await setAgentAccountAutoSwitchEnabled("claude", false, true);
    expect(workspace.mock.calls.map(([command]) => command)).toEqual([
      "set_agent_account_auto_switch",
      "list_agent_accounts",
      "set_agent_account_auto_switch",
      "list_agent_accounts",
    ]);
  });

  test("an account with an email goes by email to the command node, whichever machine shows it", async () => {
    workspace.mockImplementation(async () => ({}));
    await setAgentAccountAutoSwitchIncluded("codex", "account-1", "a@example.com", false);
    expect(portal).toHaveBeenCalledWith("set_agent_account_auto_switch", {
      platform: "codex",
      email: "a@example.com",
      included: false,
    });
    expect(JSON.stringify(portal.mock.calls)).not.toContain("account-1");
  });

  test("an account with no email stays on the machine that shows it", async () => {
    workspace.mockImplementation(async () => ({}));
    await setAgentAccountAutoSwitchIncluded("codex", "account-1", undefined, true);
    expect(workspace).toHaveBeenCalledWith("set_agent_account_auto_switch", {
      platform: "codex",
      accountId: "account-1",
      included: true,
    });
    expect(nodeCalls()).toEqual([]);
  });
});

test("plugin catalog requests preserve the selected command node or leaf", async () => {
  await listAgentPlugins("claude", null);
  await listAgentPlugins("codex", "other-leaf");
  expect(portal.mock.calls).toEqual([
    ["list_agent_plugins", { provider: "claude" }],
    [
      "invoke_on_node",
      {
        nodeId: "other-leaf",
        command: "list_agent_plugins",
        args: { provider: "codex" },
        requestKey: expect.any(String),
      },
    ],
  ]);
});

test("a machine that predates the account switch grant reads as none, on any path", async () => {
  const unknown = new Error(
    unknownBackendCommandMessage(GET_COORDINATOR_ACCOUNT_SWITCH_GRANT_COMMAND),
  );
  workspace.mockRejectedValueOnce(unknown);
  expect(await getCoordinatorAccountSwitchGrant("claude")).toBeNull();
  workspace.mockClear();
  // A routed answer arrives with the command node's text unchanged.
  portal.mockRejectedValueOnce(unknown);
  expect(await getCoordinatorAccountSwitchGrant("claude", "leaf")).toBeNull();
  expect(portal.mock.calls[0]?.[1]).toMatchObject({
    nodeId: "leaf",
    command: GET_COORDINATOR_ACCOUNT_SWITCH_GRANT_COMMAND,
  });

  const failure = new Error("offline");
  portal.mockRejectedValueOnce(failure);
  await expect(getCoordinatorAccountSwitchGrant("claude", "leaf")).rejects.toBe(failure);
});
