import type { NativeAgentCatalogCache } from "./native-agent-catalog-cache.js";
import type { NativeAgentInteractionTracker } from "./native-agent-interaction-tracker.js";
import type { NativeAgentLaunchActivityReconciler } from "./native-agent-launch-activity-reconciler.js";
import type { NativeAgentService } from "./native-agent-service.js";
import type { NativeAgentTranscriptProjection } from "./native-agent-transcript-projection.js";

/**
 * The collaborators a `NativeAgentService` wires, for end-to-end tests that
 * need to inspect or nudge one of them. Tests read collaborator state through
 * the collaborator's own interface (and its test-only accessors), never
 * through fields on the service.
 */
export interface NativeAgentServiceCollaborators {
  catalogs: NativeAgentCatalogCache;
  projections: NativeAgentTranscriptProjection;
  interactions: NativeAgentInteractionTracker;
  launches: NativeAgentLaunchActivityReconciler;
}

export function collaborators(service: NativeAgentService): NativeAgentServiceCollaborators {
  return service as unknown as NativeAgentServiceCollaborators;
}

/** Projection caches and internal steps, through the projection's test accessor. */
export function projectionInternals(service: NativeAgentService) {
  return collaborators(service).projections.forTesting();
}

/** Interaction-tracker state, through the tracker's test accessor. */
export function interactionInternals(service: NativeAgentService) {
  return collaborators(service).interactions.forTesting();
}

/** Launch and activity state, through the reconciler's test accessor. */
export function launchInternals(service: NativeAgentService) {
  return collaborators(service).launches.forTesting();
}
