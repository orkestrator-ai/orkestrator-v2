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

import { type AccountMachine } from "./agent-accounts";
import { clientInvoke, commandBackendClient, machineInvoker, type BackendClient } from "./client";

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
  /** The preview domain shares a site with the app (absent from older backends). */
  warning?: string;
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

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createPreviewsApi(client: BackendClient) {
  const invoke = clientInvoke(client);
  const machineInvoke = machineInvoker(client);

  function getPreviewCapabilities(machine?: AccountMachine): Promise<PreviewCapabilities> {
    return machineInvoke(machine, "get_preview_capabilities");
  }

  function getPreviewServices(
    environmentId: string,
    known?: { backendEpoch: string; registryRevision: number },
  ): Promise<PreviewRegistrySnapshot> {
    return invoke("get_preview_services", {
      environmentId,
      ...(known ? { knownEpoch: known.backendEpoch, knownRevision: known.registryRevision } : {}),
    });
  }

  function registerPreviewService(service: PreviewServiceInput): Promise<PreviewMutationResult> {
    return invoke("register_preview_service", { service, operationId: operationId() });
  }

  /**
   * Confirm a generated service as the user's own registration. Any edit does
   * this (`userOverride`); an empty patch changes nothing else.
   */
  function confirmPreviewService(
    serviceId: string,
    expectedRevision: number,
  ): Promise<PreviewMutationResult> {
    return updatePreviewService(serviceId, expectedRevision, {});
  }

  function updatePreviewService(
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

  function removePreviewService(
    serviceId: string,
    expectedRevision?: number,
  ): Promise<PreviewMutationResult> {
    return invoke("remove_preview_service", {
      serviceId,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      operationId: operationId(),
    });
  }

  function resolvePreviewTarget(
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

  function probePreviewService(serviceId: string): Promise<PreviewServiceSnapshot> {
    return invoke("probe_preview_service", { serviceId });
  }

  function createPreviewAttachment(args: {
    serviceId: string;
    surface: "desktop-tunnel" | "browser-top-level";
    clientKey?: string;
    path?: string;
  }): Promise<PreviewAttachmentDescriptor> {
    return invoke("create_preview_attachment", args);
  }

  function releasePreviewAttachment(attachmentId: string): Promise<{ released: boolean }> {
    return invoke("release_preview_attachment", { attachmentId });
  }

  function getPreviewSettings(machine?: AccountMachine): Promise<PreviewSettingsResponse> {
    return machineInvoke(machine, "get_preview_settings");
  }

  function updatePreviewSettings(
    settings: Partial<Omit<PreviewSettingsShape, "publication">> & {
      publication?: Partial<PreviewSettingsShape["publication"]>;
    },
    machine?: AccountMachine,
  ): Promise<PreviewSettingsResponse> {
    return machineInvoke(machine, "update_preview_settings", { settings });
  }

  function revokePreviewAccess(
    serviceId?: string,
    machine?: AccountMachine,
  ): Promise<{ revoked: number }> {
    return machineInvoke(machine, "revoke_preview_access", serviceId ? { serviceId } : {});
  }

  function getPreviewDiagnostics(machine?: AccountMachine): Promise<PreviewDiagnosticsSnapshot> {
    return machineInvoke(machine, "get_preview_diagnostics");
  }

  /** iOS handoff: the backend consumes the grant and returns a one-use session URL. */
  function createPreviewHandoffUrl(args: {
    serviceId: string;
    path?: string;
    clientKey?: string;
  }): Promise<{ url: string; expiresAt: string }> {
    return invoke("create_preview_handoff_url", args);
  }

  /** The clean private origin of a published service; never a credential. */
  function getPreviewPublicOrigin(serviceId: string): Promise<{ origin: string | null }> {
    return invoke("get_preview_public_origin", { serviceId });
  }

  return {
    getPreviewCapabilities,
    getPreviewServices,
    registerPreviewService,
    confirmPreviewService,
    updatePreviewService,
    removePreviewService,
    resolvePreviewTarget,
    probePreviewService,
    createPreviewAttachment,
    releasePreviewAttachment,
    getPreviewSettings,
    updatePreviewSettings,
    revokePreviewAccess,
    getPreviewDiagnostics,
    createPreviewHandoffUrl,
    getPreviewPublicOrigin,
  };
}

export type PreviewsApi = ReturnType<typeof createPreviewsApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  getPreviewCapabilities,
  getPreviewServices,
  registerPreviewService,
  confirmPreviewService,
  updatePreviewService,
  removePreviewService,
  resolvePreviewTarget,
  probePreviewService,
  createPreviewAttachment,
  releasePreviewAttachment,
  getPreviewSettings,
  updatePreviewSettings,
  revokePreviewAccess,
  getPreviewDiagnostics,
  createPreviewHandoffUrl,
  getPreviewPublicOrigin,
} = createPreviewsApi(commandBackendClient);
