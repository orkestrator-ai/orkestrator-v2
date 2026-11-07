import {
  parseBackendProfile,
  type BackendProfile,
  type BackendProfileUpdate,
} from "@orkestrator/protocol/backend-profile";
import { NO_ARGS, nodesApi } from "@/lib/node-scope/domains/nodes";
import { commandBackendClient, type BackendClient } from "./client";

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createMachineProfileApi(client: BackendClient) {
  const nodes = () => nodesApi(client);

  /** The client's machine profile (canonical name + colour). */
  async function getBackendProfile(): Promise<BackendProfile> {
    return parseBackendProfile(await nodes().get_backend_profile(NO_ARGS));
  }

  /** Compare-and-swap edit; a stale revision is refused by the backend. */
  async function updateBackendProfile(update: BackendProfileUpdate): Promise<BackendProfile> {
    return parseBackendProfile(await nodes().update_backend_profile({ ...update }));
  }

  return { getBackendProfile, updateBackendProfile };
}

export type MachineProfileApi = ReturnType<typeof createMachineProfileApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const { getBackendProfile, updateBackendProfile } =
  createMachineProfileApi(commandBackendClient);
