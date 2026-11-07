import { type AccountMachine } from "./agent-accounts";
import type {
  OpenCodeProviderAuthSnapshot,
  OpenCodeProviderLoginProgress,
} from "@orkestrator/protocol/opencode-provider-auth";
import { accountsOn } from "@/lib/node-scope/domains/accounts";
import { commandBackendClient, type BackendClient } from "./client";

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createOpencodeProviderAuthApi(client: BackendClient) {
  // The `accounts` domain (plan item 7008), on this client's node or another machine.
  const on = accountsOn(client);

  /**
   * OpenCode provider logins. The backend drives OpenCode's own auth routes on
   * a private server and never returns a credential; an API key goes straight
   * through to OpenCode's login store.
   *
   * Each machine keeps its own OpenCode logins. `machine` names the node to ask
   * through the command node; without it the call goes to this view's backend.
   */
  async function listOpenCodeProviderAuth(
    machine?: AccountMachine,
  ): Promise<OpenCodeProviderAuthSnapshot> {
    return on(machine).list_opencode_provider_auth({});
  }

  async function setOpenCodeProviderApiKey(
    providerId: string,
    key: string,
    metadata?: Record<string, string>,
    machine?: AccountMachine,
  ): Promise<void> {
    await on(machine).set_opencode_provider_api_key({
      providerId,
      key,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  async function removeOpenCodeProviderLogin(
    providerId: string,
    machine?: AccountMachine,
  ): Promise<void> {
    await on(machine).remove_opencode_provider_login({ providerId });
  }

  async function startOpenCodeProviderLogin(
    input: {
      providerId: string;
      providerLabel?: string;
      method: number;
      inputs?: Record<string, string>;
    },
    machine?: AccountMachine,
  ): Promise<OpenCodeProviderLoginProgress> {
    return on(machine).start_opencode_provider_login({
      providerId: input.providerId,
      method: input.method,
      ...(input.providerLabel ? { providerLabel: input.providerLabel } : {}),
      ...(input.inputs && Object.keys(input.inputs).length > 0 ? { inputs: input.inputs } : {}),
    });
  }

  async function getOpenCodeProviderLogin(
    machine?: AccountMachine,
  ): Promise<OpenCodeProviderLoginProgress> {
    return on(machine).get_opencode_provider_login({});
  }

  async function submitOpenCodeProviderLoginCode(
    code: string,
    machine?: AccountMachine,
  ): Promise<OpenCodeProviderLoginProgress> {
    return on(machine).submit_opencode_provider_login_code({ code });
  }

  async function cancelOpenCodeProviderLogin(
    operationId?: string,
    machine?: AccountMachine,
  ): Promise<OpenCodeProviderLoginProgress> {
    return on(machine).cancel_opencode_provider_login(operationId ? { operationId } : {});
  }

  return {
    listOpenCodeProviderAuth,
    setOpenCodeProviderApiKey,
    removeOpenCodeProviderLogin,
    startOpenCodeProviderLogin,
    getOpenCodeProviderLogin,
    submitOpenCodeProviderLoginCode,
    cancelOpenCodeProviderLogin,
  };
}

export type OpencodeProviderAuthApi = ReturnType<typeof createOpencodeProviderAuthApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  listOpenCodeProviderAuth,
  setOpenCodeProviderApiKey,
  removeOpenCodeProviderLogin,
  startOpenCodeProviderLogin,
  getOpenCodeProviderLogin,
  submitOpenCodeProviderLoginCode,
  cancelOpenCodeProviderLogin,
} = createOpencodeProviderAuthApi(commandBackendClient);
