import type { StorageService } from "./storage.js";
import { recheckContainerOpenCodeListener } from "./container-bridge-credential.js";

/** Resolve the current container each time: cached providers can outlive a rebuild. */
export function openCodeEnvironmentListenerRecheck(
  storage: Pick<StorageService, "getEnvironment">,
  recheck = recheckContainerOpenCodeListener,
) {
  return async (environmentId: string) => {
    const environment = await storage.getEnvironment(environmentId).catch(() => null);
    const containerId = environment?.containerId?.trim();
    if (environment?.environmentType !== "containerized" || !containerId) return undefined;
    return recheck(containerId, "opencode");
  };
}
