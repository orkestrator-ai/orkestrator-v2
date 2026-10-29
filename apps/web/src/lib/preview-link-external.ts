import { previewErrorFromUnknown } from "@orkestrator/protocol/preview-services";
import { toast } from "sonner";

import * as backend from "@/lib/backend";
import { isRemoteGatewayConnection } from "@/lib/gateway-url";
import { openServiceExternally } from "@/lib/preview-external";
import { linkUrlSource } from "@/lib/preview-service-entry";
import { isLoopbackUrl, requestTerminalBrowserTab } from "@/lib/terminal-links";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { ensurePreviewServiceSync, usePreviewServiceStore } from "@/stores/previewServiceStore";

export interface ExternalLinkRequest {
  environmentId: string;
  sourceTabId: string;
  url: string;
  /** Who printed the link. Defaults to terminal. */
  origin?: "terminal" | "agent";
}

function failureMessage(error: unknown): string {
  return (
    previewErrorFromUnknown(error)?.message ?? (error instanceof Error ? error.message : "error")
  );
}

/**
 * Open a terminal or agent link in the user's own browser.
 *
 * On the desktop app connected to another machine, a loopback link names a
 * service on that machine. It opens through the desktop's service transport:
 * a `localhost` forward on this machine, or the private origin when the
 * backend publishes one. Either way the page keeps its own root, so its
 * root-relative assets load, and it never shares a host with the gateway. A
 * port that is not a registered service opens in a preview tab, where it can
 * be registered. Everything else, and every failure, uses the plain opener.
 */
export async function openLinkExternally({
  environmentId,
  sourceTabId,
  url,
  origin = "terminal",
}: ExternalLinkRequest): Promise<void> {
  const environment = environmentId
    ? useEnvironmentStore.getState().getEnvironmentById(environmentId)
    : undefined;
  if (
    !environment ||
    !window.orkestrator?.browserPreview?.openServiceExternally ||
    !isLoopbackUrl(url) ||
    !isRemoteGatewayConnection()
  ) {
    return backend.openInBrowser(url);
  }

  ensurePreviewServiceSync();
  const capabilities = await usePreviewServiceStore
    .getState()
    .loadCapabilities()
    .catch(() => null);
  if (!capabilities) return backend.openInBrowser(url);
  const { access, surfaces } = capabilities;
  if (!access.available || !surfaces.desktopTunnel.available) {
    toast.info("Opened through the gateway proxy", {
      description: !access.available
        ? "Turn on Settings → Browser previews → Issue new preview access for this machine to open links at localhost."
        : (surfaces.desktopTunnel.reason ?? "This machine cannot forward services to localhost."),
    });
    return backend.openInBrowser(url);
  }

  let resolution: backend.PreviewTargetResolution;
  try {
    resolution = await backend.resolvePreviewTarget({
      intent: { url: url.trim(), source: linkUrlSource(environment, origin), environmentId },
    });
  } catch {
    return backend.openInBrowser(url);
  }
  if (resolution.kind !== "service") {
    requestTerminalBrowserTab({ environmentId, sourceTabId, url, origin });
    return;
  }
  try {
    await openServiceExternally({
      backendInstanceId: capabilities.backendInstanceId,
      environmentId,
      serviceId: resolution.service.definition.serviceId,
      path: resolution.path,
    });
  } catch (error) {
    toast.error("Could not open the service at localhost", {
      description: `${failureMessage(error)} Opened through the gateway proxy instead.`,
    });
    await backend.openInBrowser(url);
  }
}
