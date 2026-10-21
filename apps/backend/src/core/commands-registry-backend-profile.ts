import {
  BACKEND_PROFILE_CHANGED_EVENT,
  parseBackendProfileUpdate,
} from "@orkestrator/protocol/backend-profile";
import { assertOnlyKeys } from "./commands-validation.js";
import type { CommandRegistrar } from "./commands-registry-types.js";

/**
 * The backend's canonical machine profile (display name and colour token).
 * Edits are compare-and-swap on `expectedRevision`; a stale revision fails
 * with a `backend-profile-conflict:` message and the client reloads.
 */
export function registerBackendProfileCommands(register: CommandRegistrar): void {
  register("get_backend_profile", async (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return context.storage.getBackendProfile();
  });
  register("update_backend_profile", async (args, context) => {
    const profile = await context.storage.updateBackendProfile(parseBackendProfileUpdate(args));
    context.emit(BACKEND_PROFILE_CHANGED_EVENT, profile);
    context.nodePortal?.readModel.noteLocalEvent(BACKEND_PROFILE_CHANGED_EVENT, profile);
    return profile;
  });
}
