import {
  parseBackendProfile,
  type BackendProfile,
  type BackendProfileUpdate,
} from "@orkestrator/protocol/backend-profile";
import { clientInvoke, commandBackendClient, type BackendClient } from "./client";

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createMachineProfileApi(client: BackendClient) {
  const invoke = clientInvoke(client);

  /** This realm's own machine profile (canonical name + colour). */
  async function getBackendProfile(): Promise<BackendProfile> {
    return parseBackendProfile(await invoke<unknown>("get_backend_profile"));
  }

  /** Compare-and-swap edit; a stale revision is refused by the backend. */
  async function updateBackendProfile(update: BackendProfileUpdate): Promise<BackendProfile> {
    return parseBackendProfile(
      await invoke<unknown>("update_backend_profile", { ...update } as Record<string, unknown>),
    );
  }

  return { getBackendProfile, updateBackendProfile };
}

export type MachineProfileApi = ReturnType<typeof createMachineProfileApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const { getBackendProfile, updateBackendProfile } =
  createMachineProfileApi(commandBackendClient);
