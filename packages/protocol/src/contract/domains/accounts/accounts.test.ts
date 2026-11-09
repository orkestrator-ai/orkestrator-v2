/**
 * The `accounts` domain (plan item 7008): the definitions declare every key
 * their handlers read (the former `assertOnlyKeys` lists), classify reads as
 * the routing classifier does, decode tolerantly, carry real result schemas
 * that keep a newer backend's fields, and the client sends the envelope only
 * to a node with the domain.
 */
import { describe, expect, it } from "bun:test";
import { isNodeReadCommand } from "../../../command-nodes.js";
import type { NegotiatedDomains } from "../../../node-client.js";
import { createDomainClient, type ContractEnvelopeFields } from "../../client.js";
import { decodeCommandArgs, decodeCommandResult, type AnyCommandDef } from "../../command.js";
import {
  ACCOUNTS_COMMANDS,
  accountsClient,
  getCoordinatorAccountSwitchGrantCommand,
  getUsageHistoryCommand,
  listAgentAccountsCommand,
  setAgentAccountAutoSwitchCommand,
  setPreferredAgentIdentityCommand,
  startAgentAccountLoginCommand,
} from "./index.js";

/**
 * The keys each handler accepted (`assertOnlyKeys`) or reads (the Cursor
 * commands and `get_plan_usage`/`get_usage_history`), on 2026-11-07.
 */
const FORMER_KEYS: Record<string, readonly string[]> = {
  list_agent_accounts: [],
  get_agent_sign_in_status: ["platform"],
  list_machine_agent_accounts: [],
  set_preferred_agent_identity: ["platform", "email"],
  read_host_agent_sign_ins: [],
  open_agent_sign_in_terminal: ["platform", "environmentId"],
  get_native_agent_session_account: ["environmentId", "agent"],
  set_active_agent_account: ["platform", "accountId"],
  set_agent_account_auto_switch: ["platform", "enabled", "email", "accountId", "included"],
  resume_agent_account_auto_switch: ["platform"],
  get_coordinator_account_switch_grant: ["platform"],
  set_coordinator_account_switch_grant: ["platform", "enabled"],
  rename_agent_account: ["platform", "accountId", "label"],
  remove_agent_account: ["platform", "accountId"],
  get_project_usage_limits: ["projectId"],
  get_agent_account_usage: ["platform", "accountId", "force"],
  // Added 2026-11-09: shared usage readings, called by an attached command node only.
  collect_shared_usage_readings: ["controllerId"],
  apply_shared_usage_readings: ["controllerId", "readings"],
  start_agent_account_login: ["platform", "reauthenticate"],
  // Added 2026-11-09 for the settings pane's per-account "Sign in".
  reauthenticate_agent_account: ["platform", "accountId"],
  get_agent_account_login: [],
  submit_agent_account_login_code: ["code"],
  cancel_agent_account_login: ["operationId"],
  get_plan_usage: ["platform", "force"],
  get_usage_history: ["days", "platform", "environmentId"],
  list_opencode_provider_auth: [],
  set_opencode_provider_api_key: ["providerId", "key", "metadata"],
  remove_opencode_provider_login: ["providerId"],
  start_opencode_provider_login: ["providerId", "providerLabel", "method", "inputs"],
  get_opencode_provider_login: [],
  submit_opencode_provider_login_code: ["code"],
  cancel_opencode_provider_login: ["operationId"],
  cursor_sdk_login_start: ["openBrowser"],
  cursor_sdk_login_status: [],
  cursor_sdk_login_cancel: [],
  cursor_sdk_logout: [],
};

const ALL: readonly AnyCommandDef[] = ACCOUNTS_COMMANDS;

const account = {
  id: "default",
  platform: "claude" as const,
  label: "Work",
  isDefault: true,
  isActive: true,
  signedIn: true,
  identity: { email: "work@example.com", plan: "max" },
};

const snapshot = {
  accounts: [account],
  active: { claude: "default", codex: "default" },
  autoSwitch: { claude: { enabled: true, included: ["default"] } },
  fromANewerBackend: { kept: true },
};

describe("accounts definitions", () => {
  it("cover the 36 accounts commands once, each in version 1 of the domain", () => {
    expect(ALL).toHaveLength(36);
    expect(ALL.map((def) => def.name).sort()).toEqual(Object.keys(FORMER_KEYS).sort());
    for (const def of ALL) {
      expect({ since: def.since, version: def.domain.version, min: def.domain.min }).toEqual({
        since: 1,
        version: 1,
        min: 1,
      });
    }
  });

  it.each(ALL.map((def) => [def.name, def] as const))(
    "%s declares the keys its handler read, and its read class",
    (name, def) => {
      expect(Object.keys(def.args.fields).sort()).toEqual([...FORMER_KEYS[name]!].sort());
      expect(def.read).toBe(isNodeReadCommand(name));
    },
  );

  it("are all workspace commands, but the two a command node calls over its link", () => {
    expect(ALL.filter((def) => def.access !== "workspace").map((def) => def.name)).toEqual([
      "collect_shared_usage_readings",
      "apply_shared_usage_readings",
    ]);
    expect(
      ALL.filter((def) => def.access === "internal").every((def) => def.critical.length === 0),
    ).toBe(true);
  });

  it("marks the login mode, the cancels' operation and the OpenCode details critical", () => {
    const critical = Object.fromEntries(
      ALL.filter((def) => def.critical.length > 0).map((def) => [def.name, def.critical]),
    );
    expect(critical).toEqual({
      start_agent_account_login: ["reauthenticate"],
      cancel_agent_account_login: ["operationId"],
      set_opencode_provider_api_key: ["metadata"],
      start_opencode_provider_login: ["inputs"],
      cancel_opencode_provider_login: ["operationId"],
    });
  });

  it("decodes tolerantly: an unknown key is dropped, never refused (§11.4)", () => {
    const decoded = decodeCommandArgs(setAgentAccountAutoSwitchCommand, {
      platform: "claude",
      enabled: true,
      token: "from-a-newer-peer",
    });
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") {
      expect(decoded.success).toEqual({ platform: "claude", enabled: true });
    }
  });

  // The backend registry words these as `Expected reauthenticate to be a boolean`.
  it("refuses a wrong type of a typed key, and leaves lenient keys to the handler", () => {
    const platform = decodeCommandArgs(listAgentAccountsCommand, {});
    expect(platform._tag).toBe("Success");
    const login = decodeCommandArgs(startAgentAccountLoginCommand, {
      platform: "claude",
      reauthenticate: "true",
    });
    expect(login._tag === "Failure" && login.failure.message).toContain("reauthenticate");
    const missing = decodeCommandArgs(startAgentAccountLoginCommand, {});
    expect(missing._tag === "Failure" && missing.failure.message).toContain("platform");
    // Cleared with `null`, absent or a string: the handler decides.
    for (const email of [null, 42, "work@example.com"]) {
      expect(
        decodeCommandArgs(setPreferredAgentIdentityCommand, { platform: "claude", email })._tag,
      ).toBe("Success");
    }
    // Out-of-range filters fall back in the handler, as before.
    expect(
      decodeCommandArgs(getUsageHistoryCommand, { days: "7", platform: 1, environmentId: "" })._tag,
    ).toBe("Success");
    expect(decodeCommandArgs(getCoordinatorAccountSwitchGrantCommand, {})._tag).toBe("Success");
  });

  it("passes a newer backend's fields through results, and refuses a wrong state type", () => {
    const decoded = decodeCommandResult(listAgentAccountsCommand, snapshot);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.success as unknown).toEqual(snapshot);
    expect(
      decodeCommandResult(listAgentAccountsCommand, {
        ...snapshot,
        accounts: [{ ...account, isActive: "yes" }],
      })._tag,
    ).toBe("Failure");
    const grant = {
      grants: { claude: true, codex: false },
      limit: { switches: 3, windowMinutes: 60 },
      recentSwitches: [],
    };
    expect(decodeCommandResult(getCoordinatorAccountSwitchGrantCommand, grant)._tag).toBe(
      "Success",
    );
    expect(
      decodeCommandResult(getCoordinatorAccountSwitchGrantCommand, { ...grant, grants: [] })._tag,
    ).toBe("Failure");
  });
});

describe("accounts client", () => {
  function node(domains: NegotiatedDomains | null, answer: unknown) {
    const calls: { command: string; args: unknown; envelope?: ContractEnvelopeFields }[] = [];
    const legacy: { command: string; args: unknown }[] = [];
    const client = createDomainClient(accountsClient, {
      call: async (def, args, envelope) => {
        calls.push({ command: def.name, args, ...(envelope ? { envelope } : {}) });
        return answer;
      },
      invoke: async (command, args) => {
        legacy.push({ command, args });
        return answer;
      },
      domains,
    });
    return { client, calls, legacy };
  }

  it("has an adapter for versions 1 and 0, one function per command", () => {
    expect(Object.keys(accountsClient.adapters).sort()).toEqual(["0", "1"]);
    const { client } = node({ accounts: { min: 1, max: 1 } }, snapshot);
    expect(Object.keys(client.api()).sort()).toEqual(ALL.map((def) => def.name).sort());
  });

  it("version 1 sends the envelope with the critical keys it carries", async () => {
    const { client, calls, legacy } = node(
      { accounts: { min: 1, max: 1 } },
      {
        state: "pending",
        operationId: "op-1",
      },
    );
    expect(client.version()).toBe(1);
    const progress = await client
      .api()
      .start_agent_account_login({ platform: "claude", reauthenticate: true });
    expect(progress.state).toBe("pending");
    expect(legacy).toEqual([]);
    expect(calls).toEqual([
      {
        command: "start_agent_account_login",
        args: { platform: "claude", reauthenticate: true },
        envelope: { domain: "accounts", version: 1, critical: ["reauthenticate"] },
      },
    ]);
  });

  it("version 1 decodes results with the command's schema", async () => {
    const { client } = node({ accounts: { min: 1, max: 1 } }, { ...snapshot, accounts: "none" });
    await expect(client.api().list_agent_accounts({})).rejects.toThrow();
  });

  it("version 0 (a pre-contract node) is today's call by name, answered as sent", async () => {
    const older = { accounts: [account], active: { claude: "default" } };
    const { client, calls, legacy } = node(null, older);
    expect(client.version()).toBe(0);
    expect((await client.api().list_agent_accounts({})) as unknown).toEqual(older);
    await client.api().set_active_agent_account({ platform: "codex", accountId: "a2" });
    expect(calls).toEqual([]);
    expect(legacy).toEqual([
      { command: "list_agent_accounts", args: {} },
      { command: "set_active_agent_account", args: { platform: "codex", accountId: "a2" } },
    ]);
  });
});
