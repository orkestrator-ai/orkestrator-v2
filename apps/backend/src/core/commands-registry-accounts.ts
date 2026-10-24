import {
  isAgentAccountPlatform,
  isHostSignInPlatform,
  type AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";

import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  asNonBlankString,
  asOptionalString,
  asRecord,
  asRequiredBoolean,
  assertOnlyKeys,
  asString,
} from "./commands-helpers.js";
import {
  agentAccountLoginProgress,
  cancelAgentAccountLogin,
  listAgentAccounts,
  readAgentAccountUsage,
  removeAgentAccount,
  renameAgentAccount,
  setActiveAgentAccount,
  startAgentAccountLogin,
  submitAgentAccountLoginCode,
} from "./agent-accounts.js";
import { listMachineAgentAccounts } from "./agent-accounts-machines.js";
import { readSessionAgentAccount } from "./agent-accounts-session.js";
import { openAgentSignInTerminal, readHostAgentSignIns } from "./agent-sign-ins.js";
import { openCodeProviderLogin, openCodeProviderLoginProgress } from "./opencode-provider-login.js";

function asAccountPlatform(value: unknown): AgentAccountPlatform {
  const platform = asNonBlankString(value, "platform");
  if (!isAgentAccountPlatform(platform)) {
    throw new Error(`Agent accounts are not supported for ${platform}`);
  }
  return platform;
}

/**
 * Additional Claude and Codex logins. Nothing here returns a credential: the
 * summaries carry identity and sign-in state only, and each login lives in its
 * own account directory or Keychain entry.
 */
export function registerAgentAccountCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  register("list_agent_accounts", async (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return listAgentAccounts(context);
  });
  // Settings' per-platform sign-in card: read on the host, no session needed.
  register("get_agent_sign_in_status", async (args, context) => {
    assertOnlyKeys(args, ["platform"], "arguments");
    const platform = asNonBlankString(args.platform, "platform");
    if (!isAgentPlatform(platform)) throw new Error("Agent platform is invalid");
    const { readAgentSignInStatus } = await import("./agent-sign-in-status.js");
    return readAgentSignInStatus(platform, {
      listAccounts: () => listAgentAccounts(context),
      cursorStatus: async () => {
        const { cursorSdkAuthStatus } = await import("./cursor-sdk-bridge.js");
        const config = await context.storage.loadConfig();
        // The stored key only says which credential is in play; never returned.
        return cursorSdkAuthStatus(context, config.global.cursorApiKey);
      },
    });
  });
  register("list_machine_agent_accounts", async (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return listMachineAgentAccounts(context);
  });
  /** Grok's and Pi's login on this machine, from files and variable names only. */
  register("read_host_agent_sign_ins", async (args) => {
    assertOnlyKeys(args, [], "arguments");
    return readHostAgentSignIns();
  });
  /** A terminal tab on this machine running the platform's own fixed login command. */
  register("open_agent_sign_in_terminal", async (args, context) => {
    assertOnlyKeys(args, ["platform", "environmentId"], "arguments");
    const platform = asNonBlankString(args.platform, "platform");
    if (!isHostSignInPlatform(platform)) {
      throw new Error(`A terminal sign-in is not offered for ${platform}`);
    }
    return openAgentSignInTerminal(context, platform, {
      environmentId: asOptionalString(args.environmentId),
      launchTerminalJob: async (jobArgs) => {
        const launch = dependencies.commands.get("launch_terminal_job");
        if (!launch) throw new Error("Terminal jobs are unavailable");
        return (await launch(jobArgs, context)) as { tabId: string };
      },
    });
  });
  register("get_native_agent_session_account", async (args, context) => {
    assertOnlyKeys(args, ["environmentId", "agent"], "arguments");
    return readSessionAgentAccount(
      context,
      asNonBlankString(args.environmentId, "environmentId"),
      asNonBlankString(args.agent, "agent"),
    );
  });
  register("set_active_agent_account", async (args, context) => {
    assertOnlyKeys(args, ["platform", "accountId"], "arguments");
    return setActiveAgentAccount(
      context,
      asAccountPlatform(args.platform),
      asNonBlankString(args.accountId, "accountId"),
    );
  });
  register("rename_agent_account", async (args, context) => {
    assertOnlyKeys(args, ["platform", "accountId", "label"], "arguments");
    return renameAgentAccount(
      context,
      asAccountPlatform(args.platform),
      asNonBlankString(args.accountId, "accountId"),
      asNonBlankString(args.label, "label"),
    );
  });
  register("remove_agent_account", async (args, context) => {
    assertOnlyKeys(args, ["platform", "accountId"], "arguments");
    return removeAgentAccount(
      context,
      asAccountPlatform(args.platform),
      asNonBlankString(args.accountId, "accountId"),
    );
  });
  register("get_agent_account_usage", async (args, context) => {
    assertOnlyKeys(args, ["platform", "accountId", "force"], "arguments");
    return readAgentAccountUsage(
      context,
      asAccountPlatform(args.platform),
      asNonBlankString(args.accountId, "accountId"),
      {
        force: args.force === undefined ? false : asRequiredBoolean(args.force, "force"),
        reader: dependencies.planUsageReader,
      },
    );
  });
  /**
   * Split into start, poll, code and cancel like the Cursor sign-in: the flow
   * is human-paced and must not hold a request open.
   */
  register("start_agent_account_login", async (args, context) => {
    assertOnlyKeys(args, ["platform", "reauthenticate"], "arguments");
    return startAgentAccountLogin(context, asAccountPlatform(args.platform), {
      reauthenticate:
        args.reauthenticate === undefined
          ? false
          : asRequiredBoolean(args.reauthenticate, "reauthenticate"),
    });
  });
  register("get_agent_account_login", async (args) => {
    assertOnlyKeys(args, [], "arguments");
    return agentAccountLoginProgress();
  });
  register("submit_agent_account_login_code", async (args) => {
    assertOnlyKeys(args, ["code"], "arguments");
    return submitAgentAccountLoginCode(asNonBlankString(args.code, "code"));
  });
  register("cancel_agent_account_login", async (args) => {
    assertOnlyKeys(args, ["operationId"], "arguments");
    return cancelAgentAccountLogin(
      args.operationId === undefined
        ? undefined
        : asNonBlankString(args.operationId, "operationId"),
    );
  });
}

/** OpenCode's per-provider sign-in details, as typed by the user. */
function asOpenCodeAuthInputs(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, name);
  return Object.fromEntries(
    Object.entries(record).map(([key, input]) => [key, asString(input, `${name}.${key}`)]),
  );
}

/**
 * OpenCode provider logins. OpenCode keeps one login per model provider in
 * the host's own store, so these sign a provider in, replace or remove its
 * login; there are no accounts to switch. Nothing returns a credential, and
 * an API key passes straight through to OpenCode.
 */
export function registerOpenCodeProviderLoginCommands(register: CommandRegistrar): void {
  register("list_opencode_provider_auth", async (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return openCodeProviderLogin.listProviders(context);
  });
  register("set_opencode_provider_api_key", async (args, context) => {
    assertOnlyKeys(args, ["providerId", "key", "metadata"], "arguments");
    await openCodeProviderLogin.setApiKey(
      context,
      asNonBlankString(args.providerId, "providerId"),
      asString(args.key, "key"),
      asOpenCodeAuthInputs(args.metadata, "metadata"),
    );
  });
  register("remove_opencode_provider_login", async (args, context) => {
    assertOnlyKeys(args, ["providerId"], "arguments");
    await openCodeProviderLogin.signOut(context, asNonBlankString(args.providerId, "providerId"));
  });
  /** Split into start, poll, code and cancel like the account sign-in. */
  register("start_opencode_provider_login", async (args, context) => {
    assertOnlyKeys(args, ["providerId", "providerLabel", "method", "inputs"], "arguments");
    if (typeof args.method !== "number") throw new Error("Expected method to be a number");
    return openCodeProviderLogin.startOAuth(context, {
      providerId: asNonBlankString(args.providerId, "providerId"),
      providerLabel: asOptionalString(args.providerLabel),
      method: args.method,
      inputs: asOpenCodeAuthInputs(args.inputs, "inputs"),
    });
  });
  register("get_opencode_provider_login", async (args) => {
    assertOnlyKeys(args, [], "arguments");
    return openCodeProviderLoginProgress();
  });
  register("submit_opencode_provider_login_code", async (args) => {
    assertOnlyKeys(args, ["code"], "arguments");
    return openCodeProviderLogin.submitCode(asNonBlankString(args.code, "code"));
  });
  register("cancel_opencode_provider_login", async (args) => {
    assertOnlyKeys(args, ["operationId"], "arguments");
    return openCodeProviderLogin.cancel(
      args.operationId === undefined
        ? undefined
        : asNonBlankString(args.operationId, "operationId"),
    );
  });
}
