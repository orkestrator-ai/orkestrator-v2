/**
 * Synthetic contract fixtures shared by backend, desktop, and renderer tests.
 * Identifiers are fake and no value here is a usable credential.
 */
import {
  emptyPreviewReadiness,
  PREVIEW_DEFINITION_SCHEMA_VERSION,
  PREVIEW_LIMITS,
  PREVIEW_PROTOCOL_VERSION,
  type PreviewCapabilities,
  type PreviewRegistrySnapshot,
  type PreviewServiceDefinition,
  type PreviewServiceSnapshot,
} from "./preview-services.js";

export const FIXTURE_BACKEND_INSTANCE_ID = "bk_fixture_instance_0001";
export const FIXTURE_BACKEND_EPOCH = "ep_fixture_epoch_0001";
export const FIXTURE_ENVIRONMENT_ID = "env-fixture-a";
export const FIXTURE_SERVICE_ID = "svc_fixture_web_0001";

export function fixturePreviewDefinition(
  overrides: Partial<PreviewServiceDefinition> = {},
): PreviewServiceDefinition {
  return {
    schemaVersion: PREVIEW_DEFINITION_SCHEMA_VERSION,
    serviceId: FIXTURE_SERVICE_ID,
    environmentId: FIXTURE_ENVIRONMENT_ID,
    label: "web",
    targetKind: "container",
    applicationPort: 3000,
    scheme: "http",
    addressFamily: "auto",
    provenance: "entry-port",
    provenanceKey: "entry:3000",
    userOverride: false,
    entry: true,
    enabled: true,
    definitionRevision: 1,
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

export function fixturePreviewService(
  overrides: { definition?: Partial<PreviewServiceDefinition> } & Partial<
    Omit<PreviewServiceSnapshot, "definition">
  > = {},
): PreviewServiceSnapshot {
  const { definition, ...rest } = overrides;
  return {
    definition: fixturePreviewDefinition(definition),
    endpoint: {
      backendEpoch: FIXTURE_BACKEND_EPOCH,
      endpointGeneration: 1,
      state: "available",
      transportKind: "published-port",
      addressFamily: "ipv4",
      hostPort: 49152,
      containerId: "0123456789ab",
      ownership: "owned-container",
      readiness: {
        ...emptyPreviewReadiness(),
        environment: { state: "ok", lifecycle: "running" },
        binding: { state: "ok" },
        tcp: { state: "ok" },
        http: { state: "skipped" },
        observedAt: "2026-09-23T00:00:01.000Z",
      },
      failure: null,
    },
    ...rest,
  };
}

export function fixturePreviewSnapshot(
  services: PreviewServiceSnapshot[] = [fixturePreviewService()],
  overrides: Partial<PreviewRegistrySnapshot> = {},
): PreviewRegistrySnapshot {
  return {
    backendInstanceId: FIXTURE_BACKEND_INSTANCE_ID,
    backendEpoch: FIXTURE_BACKEND_EPOCH,
    registryRevision: 3,
    environmentId: FIXTURE_ENVIRONMENT_ID,
    notModified: false,
    services,
    tombstones: [],
    tombstoneFloor: 0,
    ...overrides,
  };
}

export function fixturePreviewCapabilities(
  overrides: Partial<PreviewCapabilities> = {},
): PreviewCapabilities {
  return {
    protocolVersion: PREVIEW_PROTOCOL_VERSION,
    backendInstanceId: FIXTURE_BACKEND_INSTANCE_ID,
    backendEpoch: FIXTURE_BACKEND_EPOCH,
    registry: { available: true },
    targets: ["container", "worktree", "backend-host"],
    access: { available: true },
    surfaces: {
      desktopTunnel: { available: true, upstreamSchemes: ["http"] },
      browserTopLevel: {
        available: false,
        reason: "No private preview domain is configured.",
        upstreamSchemes: [],
      },
      browserEmbedded: {
        available: false,
        reason: "Embedded previews are not validated.",
        platforms: [],
      },
      legacyPath: { available: true },
    },
    relay: { available: false, reason: "The container relay is disabled." },
    limits: { ...PREVIEW_LIMITS },
    ...overrides,
  };
}
