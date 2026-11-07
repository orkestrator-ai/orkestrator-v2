import { backendProfileChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import {
  getBackendProfileCommand,
  updateBackendProfileCommand,
} from "@orkestrator/protocol/contract/domains/nodes";
import {
  BACKEND_PROFILE_CHANGED_EVENT,
  parseBackendProfileUpdate,
} from "@orkestrator/protocol/backend-profile";
import type { CommandRegistrar } from "./commands-registry-types.js";

/**
 * The backend's canonical machine profile (display name and colour token).
 * Edits are compare-and-swap on `expectedRevision`; a stale revision fails
 * with a `backend-profile-conflict:` message and the client reloads.
 */
export function registerBackendProfileCommands(register: CommandRegistrar): void {
  register(getBackendProfileCommand, async (_args, context) => {
    return context.storage.previewServices.getBackendProfile();
  });
  register(updateBackendProfileCommand, async (args, context) => {
    const profile = await context.storage.previewServices.updateBackendProfile(
      parseBackendProfileUpdate(args),
    );
    context.emit(backendProfileChangedEvent, profile);
    context.nodePortal?.readModel.noteLocalEvent(BACKEND_PROFILE_CHANGED_EVENT, profile);
    return profile;
  });
}
