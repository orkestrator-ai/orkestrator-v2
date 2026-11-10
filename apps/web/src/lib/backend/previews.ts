import type {
  PreviewDiagnosticsSnapshot,
  PreviewMutationResult,
  PreviewPublicationDetail,
  PreviewSettingsResponse,
  PreviewSettingsShape,
  PreviewTargetResolution,
} from "@orkestrator/protocol/contract/domains/previews";
import type { PreviewAttachmentDescriptor } from "@orkestrator/protocol/preview-access";
import type {
  PreviewCapabilities,
  PreviewRegistrySnapshot,
  PreviewServiceInput,
  PreviewServiceRef,
  PreviewServiceSnapshot,
  PreviewUrlSource,
} from "@orkestrator/protocol/preview-services";

import { type AccountMachine } from "./agent-accounts";
import { commandBackendClient, type BackendClient, machineBackendClient } from "./client";
import { previews as previewsDomain } from "@/lib/node-scope/domains/previews";

/** The result and settings types are the `previews` domain's schemas (plan item 7004). */
export type {
  PreviewDiagnosticsSnapshot,
  PreviewMutationResult,
  PreviewPublicationDetail,
  PreviewSettingsResponse,
  PreviewSettingsShape,
  PreviewTargetResolution,
};

function operationId(): string {
  return `op-${crypto.randomUUID()}`;
}

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createPreviewsApi(client: BackendClient) {
  const previews = previewsDomain(client);
  /** `machine`'s previews: this client's node, or another machine through the command node. */
  const on = (machine?: AccountMachine) =>
    machine === undefined ? previews() : previewsDomain(machineBackendClient(client, machine))();

  function getPreviewCapabilities(machine?: AccountMachine): Promise<PreviewCapabilities> {
    return on(machine).capabilities({});
  }

  function getPreviewServices(
    environmentId: string,
    known?: { backendEpoch: string; registryRevision: number },
  ): Promise<PreviewRegistrySnapshot> {
    return previews().services({
      environmentId,
      ...(known ? { knownEpoch: known.backendEpoch, knownRevision: known.registryRevision } : {}),
    });
  }

  function registerPreviewService(service: PreviewServiceInput): Promise<PreviewMutationResult> {
    return previews().register({ service, operationId: operationId() });
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
    return previews().update({
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
    return previews().remove({
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
    return previews().resolveTarget(args);
  }

  function probePreviewService(serviceId: string): Promise<PreviewServiceSnapshot> {
    return previews().probe({ serviceId });
  }

  function createPreviewAttachment(args: {
    serviceId: string;
    surface: "desktop-tunnel" | "browser-top-level";
    clientKey?: string;
    path?: string;
  }): Promise<PreviewAttachmentDescriptor> {
    return previews().createAttachment(args);
  }

  function getPreviewSettings(machine?: AccountMachine): Promise<PreviewSettingsResponse> {
    return on(machine).settings({});
  }

  function updatePreviewSettings(
    settings: Partial<Omit<PreviewSettingsShape, "publication">> & {
      publication?: Partial<PreviewSettingsShape["publication"]>;
    },
    machine?: AccountMachine,
  ): Promise<PreviewSettingsResponse> {
    return on(machine).updateSettings({ settings });
  }

  function revokePreviewAccess(
    serviceId?: string,
    machine?: AccountMachine,
  ): Promise<{ revoked: number }> {
    return on(machine).revokeAccess(serviceId ? { serviceId } : {});
  }

  function getPreviewDiagnostics(machine?: AccountMachine): Promise<PreviewDiagnosticsSnapshot> {
    return on(machine).diagnostics({});
  }

  /** iOS handoff: the backend consumes the grant and returns a one-use session URL. */
  function createPreviewHandoffUrl(args: {
    serviceId: string;
    path?: string;
    clientKey?: string;
  }): Promise<{ url: string; expiresAt: string }> {
    return previews().createHandoffUrl(args);
  }

  /** The clean private origin of a published service; never a credential. */
  function getPreviewPublicOrigin(serviceId: string): Promise<{ origin: string | null }> {
    return previews().publicOrigin({ serviceId });
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
  getPreviewSettings,
  updatePreviewSettings,
  revokePreviewAccess,
  getPreviewDiagnostics,
  createPreviewHandoffUrl,
  getPreviewPublicOrigin,
} = createPreviewsApi(commandBackendClient);
