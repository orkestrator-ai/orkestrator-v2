import type { PreviewAttachmentDescriptor } from "@orkestrator/protocol/preview-access";
import type {
  PreviewCapabilities,
  PreviewRegistrySnapshot,
  PreviewServiceDefinition,
  PreviewServiceInput,
  PreviewServiceRef,
  PreviewServiceSnapshot,
  PreviewUrlSource,
} from "@orkestrator/protocol/preview-services";

import { invoke } from "@/lib/native/backend";

export type PreviewMutationResult =
  | { kind: "definition"; definition: PreviewServiceDefinition; replayed: boolean }
  | { kind: "removed"; serviceId: string; replayed: boolean };

export type PreviewTargetResolution =
  | { kind: "service"; service: PreviewServiceSnapshot; path: string }
  | { kind: "choose"; candidates: PreviewServiceSnapshot[]; path: string }
  | {
      kind: "unregistered";
      path: string;
      suggestion: Pick<PreviewServiceInput, "targetKind" | "applicationPort" | "scheme">;
      bindHint: boolean;
    }
  | { kind: "manual"; path: string; scheme: "http" | "https"; hostPort: number };

export interface PreviewSettingsResponse {
  stored: PreviewSettingsShape;
  effective: PreviewSettingsShape;
}

export interface PreviewSettingsShape {
  version: 1;
  transport: boolean;
  relay: boolean;
  publication: {
    enabled: boolean;
    domain: string | null;
    certFile: string | null;
    keyFile: string | null;
    upstreamCaFile: string | null;
    listenAddress: string | null;
    port: number | null;
    publicPort: number | null;
  };
}

export interface PreviewPublicationDetail {
  enabled: boolean;
  available: boolean;
  reason?: string;
  domain: string | null;
  listening: { address: string; port: number } | null;
  certificate: { validTo: string; coversHosts: boolean } | null;
}

/** Safe operator diagnostics: counts and bounded categories only. */
export interface PreviewDiagnosticsSnapshot {
  registry: Record<string, number | string>;
  access: Record<string, number>;
  resolver: Record<string, number>;
  readiness: Record<string, number>;
  metrics: {
    counters: Record<string, number>;
    histograms: Record<string, { count: number; p50: number; p95: number; max: number }>;
    gauges: Record<string, number>;
  };
  settings: { transport: boolean; relay: boolean; publicationEnabled: boolean };
  publication: PreviewPublicationDetail | null;
  relay: { available: boolean; reason?: string };
}

function operationId(): string {
  return `op-${crypto.randomUUID()}`;
}

export function getPreviewCapabilities(): Promise<PreviewCapabilities> {
  return invoke("get_preview_capabilities");
}

export function getPreviewServices(
  environmentId: string,
  known?: { backendEpoch: string; registryRevision: number },
): Promise<PreviewRegistrySnapshot> {
  return invoke("get_preview_services", {
    environmentId,
    ...(known ? { knownEpoch: known.backendEpoch, knownRevision: known.registryRevision } : {}),
  });
}

export function registerPreviewService(
  service: PreviewServiceInput,
): Promise<PreviewMutationResult> {
  return invoke("register_preview_service", { service, operationId: operationId() });
}

export function updatePreviewService(
  serviceId: string,
  expectedRevision: number,
  patch: Partial<PreviewServiceInput>,
): Promise<PreviewMutationResult> {
  return invoke("update_preview_service", {
    serviceId,
    expectedRevision,
    patch,
    operationId: operationId(),
  });
}

export function removePreviewService(
  serviceId: string,
  expectedRevision?: number,
): Promise<PreviewMutationResult> {
  return invoke("remove_preview_service", {
    serviceId,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    operationId: operationId(),
  });
}

export function resolvePreviewTarget(
  args:
    | { serviceRef: PreviewServiceRef }
    | {
        intent: {
          url: string;
          source: PreviewUrlSource;
          environmentId: string;
          mode?: "service" | "manual";
        };
      },
): Promise<PreviewTargetResolution> {
  return invoke("resolve_preview_target", args);
}

export function probePreviewService(serviceId: string): Promise<PreviewServiceSnapshot> {
  return invoke("probe_preview_service", { serviceId });
}

export function createPreviewAttachment(args: {
  serviceId: string;
  surface: "desktop-tunnel" | "browser-top-level";
  clientKey?: string;
  path?: string;
}): Promise<PreviewAttachmentDescriptor> {
  return invoke("create_preview_attachment", args);
}

export function releasePreviewAttachment(attachmentId: string): Promise<{ released: boolean }> {
  return invoke("release_preview_attachment", { attachmentId });
}

export function getPreviewSettings(): Promise<PreviewSettingsResponse> {
  return invoke("get_preview_settings");
}

export function updatePreviewSettings(
  settings: Partial<Omit<PreviewSettingsShape, "publication">> & {
    publication?: Partial<PreviewSettingsShape["publication"]>;
  },
): Promise<PreviewSettingsResponse> {
  return invoke("update_preview_settings", { settings });
}

export function revokePreviewAccess(serviceId?: string): Promise<{ revoked: number }> {
  return invoke("revoke_preview_access", serviceId ? { serviceId } : {});
}

export function getPreviewDiagnostics(): Promise<PreviewDiagnosticsSnapshot> {
  return invoke("get_preview_diagnostics");
}

/** iOS handoff: the backend consumes the grant and returns a one-use session URL. */
export function createPreviewHandoffUrl(args: {
  serviceId: string;
  path?: string;
  clientKey?: string;
}): Promise<{ url: string; expiresAt: string }> {
  return invoke("create_preview_handoff_url", args);
}

/** The clean private origin of a published service; never a credential. */
export function getPreviewPublicOrigin(serviceId: string): Promise<{ origin: string | null }> {
  return invoke("get_preview_public_origin", { serviceId });
}
