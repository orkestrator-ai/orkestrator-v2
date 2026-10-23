import type { NativeAgentCatalogCache } from "./native-agent-catalog-cache.js";
import type { NativeAgentService } from "./native-agent-service.js";

/**
 * The collaborators a `NativeAgentService` wires, for end-to-end tests that
 * need to inspect or nudge one of them. Tests read collaborator state through
 * the collaborator's own interface (and its test-only accessors), never
 * through fields on the service.
 */
export interface NativeAgentServiceCollaborators {
  catalogs: NativeAgentCatalogCache;
}

export function collaborators(service: NativeAgentService): NativeAgentServiceCollaborators {
  return service as unknown as NativeAgentServiceCollaborators;
}
