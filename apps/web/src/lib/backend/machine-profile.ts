import {
  parseBackendProfile,
  type BackendProfile,
  type BackendProfileUpdate,
} from "@orkestrator/protocol/backend-profile";
import { invoke } from "@/lib/native/backend";

/** This realm's own machine profile (canonical name + colour). */
export async function getBackendProfile(): Promise<BackendProfile> {
  return parseBackendProfile(await invoke<unknown>("get_backend_profile"));
}

/** Compare-and-swap edit; a stale revision is refused by the backend. */
export async function updateBackendProfile(update: BackendProfileUpdate): Promise<BackendProfile> {
  return parseBackendProfile(
    await invoke<unknown>("update_backend_profile", { ...update } as Record<string, unknown>),
  );
}
