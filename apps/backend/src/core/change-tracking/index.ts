// The change-tracking domain's public surface: the only module other backend
// code imports. Re-export by name (never `export *`) so the surface stays
// reviewable. The storage layer imports ledger-schema.js directly: routing it
// through here would close a runtime import cycle with storage.
export { createBackendChangeTracking } from "./backend-wiring.js";
export { legacyCompatibilityCounts, measureLegacyPayload } from "./legacy-payload.js";
export type { ChangeTrackingService, EvidenceSource } from "./service.js";
export {
  PhysicalKeyResolver,
  SharedScanQueue,
  SharedWatcherRegistry,
} from "./shared-physical-work.js";
