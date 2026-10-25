import { machineInvoke, type AccountMachine } from "./agent-accounts";
import type {
  OpenCodeProviderAuthSnapshot,
  OpenCodeProviderLoginProgress,
} from "@orkestrator/protocol/opencode-provider-auth";

/**
 * OpenCode provider logins. The backend drives OpenCode's own auth routes on
 * a private server and never returns a credential; an API key goes straight
 * through to OpenCode's login store.
 *
 * Each machine keeps its own OpenCode logins. `machine` names the node to ask
 * through the command node; without it the call goes to this view's backend.
 */
export async function listOpenCodeProviderAuth(
  machine?: AccountMachine,
): Promise<OpenCodeProviderAuthSnapshot> {
  return machineInvoke<OpenCodeProviderAuthSnapshot>(machine, "list_opencode_provider_auth");
}

export async function setOpenCodeProviderApiKey(
  providerId: string,
  key: string,
  metadata?: Record<string, string>,
  machine?: AccountMachine,
): Promise<void> {
  await machineInvoke(machine, "set_opencode_provider_api_key", {
    providerId,
    key,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  });
}

export async function removeOpenCodeProviderLogin(
  providerId: string,
  machine?: AccountMachine,
): Promise<void> {
  await machineInvoke(machine, "remove_opencode_provider_login", { providerId });
}

export async function startOpenCodeProviderLogin(
  input: {
    providerId: string;
    providerLabel?: string;
    method: number;
    inputs?: Record<string, string>;
  },
  machine?: AccountMachine,
): Promise<OpenCodeProviderLoginProgress> {
  return machineInvoke<OpenCodeProviderLoginProgress>(machine, "start_opencode_provider_login", {
    providerId: input.providerId,
    method: input.method,
    ...(input.providerLabel ? { providerLabel: input.providerLabel } : {}),
    ...(input.inputs && Object.keys(input.inputs).length > 0 ? { inputs: input.inputs } : {}),
  });
}

export async function getOpenCodeProviderLogin(
  machine?: AccountMachine,
): Promise<OpenCodeProviderLoginProgress> {
  return machineInvoke<OpenCodeProviderLoginProgress>(machine, "get_opencode_provider_login");
}

export async function submitOpenCodeProviderLoginCode(
  code: string,
  machine?: AccountMachine,
): Promise<OpenCodeProviderLoginProgress> {
  return machineInvoke<OpenCodeProviderLoginProgress>(
    machine,
    "submit_opencode_provider_login_code",
    { code },
  );
}

export async function cancelOpenCodeProviderLogin(
  operationId?: string,
  machine?: AccountMachine,
): Promise<OpenCodeProviderLoginProgress> {
  return machineInvoke<OpenCodeProviderLoginProgress>(
    machine,
    "cancel_opencode_provider_login",
    operationId ? { operationId } : {},
  );
}
