import { invoke } from "@/lib/native/backend";
import type {
  OpenCodeProviderAuthSnapshot,
  OpenCodeProviderLoginProgress,
} from "@orkestrator/protocol/opencode-provider-auth";

/**
 * OpenCode provider logins. The backend drives OpenCode's own auth routes on
 * a private server and never returns a credential; an API key goes straight
 * through to OpenCode's login store.
 */
export async function listOpenCodeProviderAuth(): Promise<OpenCodeProviderAuthSnapshot> {
  return invoke<OpenCodeProviderAuthSnapshot>("list_opencode_provider_auth", {});
}

export async function setOpenCodeProviderApiKey(
  providerId: string,
  key: string,
  metadata?: Record<string, string>,
): Promise<void> {
  await invoke("set_opencode_provider_api_key", {
    providerId,
    key,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  });
}

export async function removeOpenCodeProviderLogin(providerId: string): Promise<void> {
  await invoke("remove_opencode_provider_login", { providerId });
}

export async function startOpenCodeProviderLogin(input: {
  providerId: string;
  providerLabel?: string;
  method: number;
  inputs?: Record<string, string>;
}): Promise<OpenCodeProviderLoginProgress> {
  return invoke<OpenCodeProviderLoginProgress>("start_opencode_provider_login", {
    providerId: input.providerId,
    method: input.method,
    ...(input.providerLabel ? { providerLabel: input.providerLabel } : {}),
    ...(input.inputs && Object.keys(input.inputs).length > 0 ? { inputs: input.inputs } : {}),
  });
}

export async function getOpenCodeProviderLogin(): Promise<OpenCodeProviderLoginProgress> {
  return invoke<OpenCodeProviderLoginProgress>("get_opencode_provider_login", {});
}

export async function submitOpenCodeProviderLoginCode(
  code: string,
): Promise<OpenCodeProviderLoginProgress> {
  return invoke<OpenCodeProviderLoginProgress>("submit_opencode_provider_login_code", { code });
}

export async function cancelOpenCodeProviderLogin(
  operationId?: string,
): Promise<OpenCodeProviderLoginProgress> {
  return invoke<OpenCodeProviderLoginProgress>(
    "cancel_opencode_provider_login",
    operationId ? { operationId } : {},
  );
}
