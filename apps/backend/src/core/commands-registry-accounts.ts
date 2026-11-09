import {
  isAgentAccountPlatform,
  isHostSignInPlatform,
  type AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { isBackendId } from "@orkestrator/protocol/federation";
import {
  cancelAgentAccountLoginCommand,
  cancelOpenCodeProviderLoginCommand,
  getAgentAccountLoginCommand,
  applySharedUsageReadingsCommand,
  collectSharedUsageReadingsCommand,
  getAgentAccountUsageCommand,
  getAgentSignInStatusCommand,
  getCoordinatorAccountSwitchGrantCommand,
  getNativeAgentSessionAccountCommand,
  getOpenCodeProviderLoginCommand,
  getProjectUsageLimitsCommand,
  listAgentAccountsCommand,
  listMachineAgentAccountsCommand,
  listOpenCodeProviderAuthCommand,
  openAgentSignInTerminalCommand,
  readHostAgentSignInsCommand,
  reauthenticateAgentAccountCommand,
  removeAgentAccountCommand,
  removeOpenCodeProviderLoginCommand,
  renameAgentAccountCommand,
  resumeAgentAccountAutoSwitchCommand,
  setActiveAgentAccountCommand,
  setAgentAccountAutoSwitchCommand,
  setCoordinatorAccountSwitchGrantCommand,
  setOpenCodeProviderApiKeyCommand,
  setPreferredAgentIdentityCommand,
  startAgentAccountLoginCommand,
  startOpenCodeProviderLoginCommand,
  submitAgentAccountLoginCodeCommand,
  submitOpenCodeProviderLoginCodeCommand,
} from "@orkestrator/protocol/contract/domains/accounts";

import type { AnyCommandDef } from "@orkestrator/protocol/contract/command";
import type { CommandContext } from "./commands-context.js";
import { ASYNC_HANDLER, asyncHandlerCheckingFirst } from "./commands-registry-async-decode.js";
import type {
  CommandRegistrar,
  DefinedCommandHandler,
  RegistryDependencies,
} from "./commands-registry-types.js";
import {
  asNonBlankString,
  asOptionalString,
  asRecord,
  asRequiredBoolean,
  asString,
} from "./commands-helpers.js";
import {
  agentAccountLoginProgress,
  cancelAgentAccountLogin,
  listAgentAccountUsageIdentities,
  listAgentAccounts,
  readAgentAccountUsage,
  removeAgentAccount,
  renameAgentAccount,
  resumeAgentAccountAutoSwitch,
  setActiveAgentAccount,
  setAgentAccountAutoSwitch,
  startAgentAccountLogin,
  submitAgentAccountLoginCode,
} from "./agent-accounts.js";
import { listMachineAgentAccounts, setPreferredAgentIdentity } from "./agent-accounts-machines.js";
import {
  applySharedUsageReadings,
  collectSharedUsageReadings,
} from "./agent-accounts-usage-sharing.js";
import { accountSwitchGrantState } from "./nodes/index.js";
import { readSessionAgentAccount } from "./agent-accounts-session.js";
import { cachedPlanUsage, readProjectUsageLimits } from "./agent-usage-limits.js";
import { openAgentSignInTerminal, readHostAgentSignIns } from "./agent-sign-ins.js";
import { openCodeProviderLogin, openCodeProviderLoginProgress } from "./opencode-provider-login.js";

/**
 * `register(def, handler)` for this file's `async` handlers: an argument the
 * definition refuses is a rejection, as the handler's own checks were
 * (`commands-registry-async-decode.ts`).
 */
function asyncRegistrar(register: CommandRegistrar, options = ASYNC_HANDLER) {
  return <C extends AnyCommandDef>(def: C, handler: DefinedCommandHandler<C>): void =>
    register(def, handler, options);
}

/** The calling command node, which must be attached to this node (as for ticket sync). */
function attachedController(args: { readonly controllerId?: unknown }, context: CommandContext) {
  const controllerId = args.controllerId;
  if (!isBackendId(controllerId)) throw new Error("Expected controllerId to be a node identity.");
  if (!context.nodes?.listControllers().some((entry) => entry.controllerId === controllerId)) {
    throw new Error("That command node is not attached to this node.");
  }
  return controllerId;
}

function asAccountPlatform(value: unknown): AgentAccountPlatform {
  const platform = asNonBlankString(value, "platform");
  if (!isAgentAccountPlatform(platform)) {
    throw new Error(`Agent accounts are not supported for ${platform}`);
  }
  return platform;
}

/**
 * For handlers that check the account platform before their other arguments:
 * the platform check runs before the decode, so a call with an unsupported
 * platform and another wrong field reports the platform, as it did before the
 * definitions (plan item 7008).
 */
const ACCOUNT_PLATFORM_FIRST = asyncHandlerCheckingFirst((args) => {
  asAccountPlatform(args.platform);
});

/**
 * Additional Claude and Codex logins. Nothing here returns a credential: the
 * summaries carry identity and sign-in state only, and each login lives in its
 * own account directory or Keychain entry.
 */
export function registerAgentAccountCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const define = asyncRegistrar(register);
  const definePlatformFirst = asyncRegistrar(register, ACCOUNT_PLATFORM_FIRST);
  define(listAgentAccountsCommand, async (_args, context) => {
    return listAgentAccounts(context);
  });
  // Settings' per-platform sign-in card: read on the host, no session needed.
  define(getAgentSignInStatusCommand, async (args, context) => {
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
  define(listMachineAgentAccountsCommand, async (_args, context) => {
    return listMachineAgentAccounts(context);
  });
  /** The login the overview flags each machine against; an email only, never switching anything. */
  define(setPreferredAgentIdentityCommand, async (args, context) => {
    return setPreferredAgentIdentity(
      context,
      asAccountPlatform(args.platform),
      args.email === null || args.email === undefined ? null : asString(args.email, "email"),
    );
  });
  /**
   * Shared usage readings, leaf side: called by an attached command node over
   * its link only (`node-routing.ts` never routes them). Usage fields only;
   * see `agent-accounts-usage-sharing.ts`.
   */
  define(collectSharedUsageReadingsCommand, async (args, context) => {
    attachedController(args, context);
    return collectSharedUsageReadings(context, await listAgentAccountUsageIdentities(context));
  });
  define(applySharedUsageReadingsCommand, async (args, context) => {
    attachedController(args, context);
    return applySharedUsageReadings(
      context,
      await listAgentAccountUsageIdentities(context),
      args.readings,
    );
  });
  /** Grok's and Pi's login on this machine, from files and variable names only. */
  define(readHostAgentSignInsCommand, async () => {
    return readHostAgentSignIns();
  });
  /** A terminal tab on this machine running the platform's own fixed login command. */
  define(openAgentSignInTerminalCommand, async (args, context) => {
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
  define(getNativeAgentSessionAccountCommand, async (args, context) => {
    return readSessionAgentAccount(
      context,
      asNonBlankString(args.environmentId, "environmentId"),
      asNonBlankString(args.agent, "agent"),
    );
  });
  definePlatformFirst(setActiveAgentAccountCommand, async (args, context) => {
    return setActiveAgentAccount(
      context,
      asAccountPlatform(args.platform),
      asNonBlankString(args.accountId, "accountId"),
    );
  });
  /**
   * The automatic-switching ticks. Separate from `update_global_config`, which
   * never writes them, so a settings form holding an older config or a
   * coordinator's change cannot undo the other.
   */
  definePlatformFirst(setAgentAccountAutoSwitchCommand, async (args, context) => {
    const platform = asAccountPlatform(args.platform);
    const enabled =
      args.enabled === undefined ? undefined : asRequiredBoolean(args.enabled, "enabled");
    const email = asOptionalString(args.email);
    const accountId = asOptionalString(args.accountId);
    const included =
      args.included === undefined ? undefined : asRequiredBoolean(args.included, "included");
    if (enabled === undefined && included === undefined) {
      throw new Error("Expected enabled, or included with an email or accountId");
    }
    if (included !== undefined && (email === undefined) === (accountId === undefined)) {
      throw new Error("Expected included with either an email or an accountId");
    }
    const snapshot = await setAgentAccountAutoSwitch(context, platform, {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(accountId !== undefined ? { accountId } : {}),
      ...(included !== undefined ? { included } : {}),
    });
    context.accountAutoSwitch?.nudge(platform);
    return snapshot;
  });
  /** Ends this machine's pin, and only this machine's. Its own copy of the ticks is left alone. */
  define(resumeAgentAccountAutoSwitchCommand, async (args, context) => {
    const platform = asAccountPlatform(args.platform);
    const snapshot = await resumeAgentAccountAutoSwitch(context, platform);
    context.accountAutoSwitch?.nudge(platform);
    return snapshot;
  });
  /**
   * The standing permission for this machine's coordinators to switch accounts
   * without asking, and the switches it allowed. Separate from
   * `update_global_config`, which never writes it.
   */
  define(getCoordinatorAccountSwitchGrantCommand, async (args, context) => {
    return accountSwitchGrantState(
      {
        loadGlobalConfig: async () => (await context.storage.loadConfig()).global,
        actions: context.nodeCoordination?.actions ?? null,
      },
      args.platform === undefined ? undefined : asAccountPlatform(args.platform),
    );
  });
  definePlatformFirst(setCoordinatorAccountSwitchGrantCommand, async (args, context) => {
    const platform = asAccountPlatform(args.platform);
    await context.storage.setCoordinatorAccountSwitchGrant(
      platform,
      asRequiredBoolean(args.enabled, "enabled"),
    );
    return accountSwitchGrantState(
      {
        loadGlobalConfig: async () => (await context.storage.loadConfig()).global,
        actions: context.nodeCoordination?.actions ?? null,
      },
      platform,
    );
  });
  definePlatformFirst(renameAgentAccountCommand, async (args, context) => {
    return renameAgentAccount(
      context,
      asAccountPlatform(args.platform),
      asNonBlankString(args.accountId, "accountId"),
      asNonBlankString(args.label, "label"),
    );
  });
  definePlatformFirst(removeAgentAccountCommand, async (args, context) => {
    return removeAgentAccount(
      context,
      asAccountPlatform(args.platform),
      asNonBlankString(args.accountId, "accountId"),
    );
  });
  /**
   * Which of a project's agent tabs stopped on a provider usage limit, and the
   * active accounts' cached quota windows. Cheap: storage and caches only.
   */
  define(getProjectUsageLimitsCommand, async (args, context) => {
    return readProjectUsageLimits(
      {
        storage: context.storage,
        planUsage: cachedPlanUsage(context.runtime.accounts.planUsage.cache),
      },
      asNonBlankString(args.projectId, "projectId"),
    );
  });
  definePlatformFirst(getAgentAccountUsageCommand, async (args, context) => {
    return readAgentAccountUsage(
      context,
      asAccountPlatform(args.platform),
      asNonBlankString(args.accountId, "accountId"),
      {
        force: args.force === undefined ? false : asRequiredBoolean(args.force, "force"),
        cacheOnly: args.cacheOnly === true,
        reader: dependencies.planUsageReader,
      },
    );
  });
  /**
   * Split into start, poll, code and cancel like the Cursor sign-in: the flow
   * is human-paced and must not hold a request open.
   */
  definePlatformFirst(startAgentAccountLoginCommand, async (args, context) => {
    return startAgentAccountLogin(context, asAccountPlatform(args.platform), {
      reauthenticate:
        args.reauthenticate === undefined
          ? false
          : asRequiredBoolean(args.reauthenticate, "reauthenticate"),
    });
  });
  definePlatformFirst(reauthenticateAgentAccountCommand, async (args, context) => {
    return startAgentAccountLogin(context, asAccountPlatform(args.platform), {
      reauthenticate: true,
      accountId: asNonBlankString(args.accountId, "accountId"),
    });
  });
  define(getAgentAccountLoginCommand, async (_args, context) => {
    return agentAccountLoginProgress(context);
  });
  define(submitAgentAccountLoginCodeCommand, async (args, context) => {
    return submitAgentAccountLoginCode(context, asNonBlankString(args.code, "code"));
  });
  define(cancelAgentAccountLoginCommand, async (args, context) => {
    return cancelAgentAccountLogin(
      context,
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
  const define = asyncRegistrar(register);
  define(listOpenCodeProviderAuthCommand, async (_args, context) => {
    return openCodeProviderLogin.listProviders(context);
  });
  define(setOpenCodeProviderApiKeyCommand, async (args, context) => {
    await openCodeProviderLogin.setApiKey(
      context,
      asNonBlankString(args.providerId, "providerId"),
      asString(args.key, "key"),
      asOpenCodeAuthInputs(args.metadata, "metadata"),
    );
  });
  define(removeOpenCodeProviderLoginCommand, async (args, context) => {
    await openCodeProviderLogin.signOut(context, asNonBlankString(args.providerId, "providerId"));
  });
  /** Split into start, poll, code and cancel like the account sign-in. */
  define(startOpenCodeProviderLoginCommand, async (args, context) => {
    if (typeof args.method !== "number") throw new Error("Expected method to be a number");
    return openCodeProviderLogin.startOAuth(context, {
      providerId: asNonBlankString(args.providerId, "providerId"),
      providerLabel: asOptionalString(args.providerLabel),
      method: args.method,
      inputs: asOpenCodeAuthInputs(args.inputs, "inputs"),
    });
  });
  define(getOpenCodeProviderLoginCommand, async (_args, context) => {
    return openCodeProviderLoginProgress(context);
  });
  define(submitOpenCodeProviderLoginCodeCommand, async (args, context) => {
    return openCodeProviderLogin.submitCode(context, asNonBlankString(args.code, "code"));
  });
  define(cancelOpenCodeProviderLoginCommand, async (args, context) => {
    return openCodeProviderLogin.cancel(
      context,
      args.operationId === undefined
        ? undefined
        : asNonBlankString(args.operationId, "operationId"),
    );
  });
}
