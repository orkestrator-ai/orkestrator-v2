import {
  isAgentAccountPlatform,
  type AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";

import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { asNonBlankString, asRequiredBoolean, assertOnlyKeys } from "./commands-helpers.js";
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
    assertOnlyKeys(args, [], "arguments");
    return cancelAgentAccountLogin();
  });
}
