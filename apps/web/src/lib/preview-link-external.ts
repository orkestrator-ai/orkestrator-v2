import { previewErrorFromUnknown } from "@orkestrator/protocol/preview-services";
import { toast } from "sonner";

import * as backend from "@/lib/backend";
import { backendOnThisDevice, isRemoteGatewayConnection } from "@/lib/gateway-url";
import { backendForScope } from "@/lib/backend/scope-backend";
import { openServiceExternally } from "@/lib/preview-external";
import { linkUrlSource } from "@/lib/preview-service-entry";
import { isLoopbackUrl, requestTerminalBrowserTab } from "@/lib/terminal-links";
import { environmentStore } from "@/stores/environmentStore";
import type { LeafNodeClient } from "@/lib/node-scope/node-clients";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope } from "@/lib/node-scope-slots";
import { ensurePreviewServiceSync, previewServiceStore } from "@/stores/previewServiceStore";

export interface ExternalLinkRequest {
  environmentId: string;
  sourceTabId: string;
  url: string;
  /** Who printed the link. Defaults to terminal. */
  origin?: "terminal" | "agent";
  /** The environment's node; the app's command scope when omitted (no caller has one yet). */
  scope?: NodeScope;
}

function failureMessage(error: unknown): string {
  return (
    previewErrorFromUnknown(error)?.message ?? (error instanceof Error ? error.message : "error")
  );
}

/**
 * Open a link exactly as written. A loopback link from an environment whose
 * backend runs on this computer already names a port this browser can reach;
 * rewriting it through the command node's gateway would send it to another
 * machine's port, behind a sign-in the external browser does not have.
 */
function openAsWritten(url: string): Promise<void> {
  const openExternal = window.orkestrator?.shell?.openExternal;
  return openExternal ? openExternal(url) : backend.openInBrowser(url);
}

/**
 * The fallback: the loopback link through the gateway proxy of the node that
 * runs the environment. A leaf's port is reached through the leaf's own proxy,
 * never the command node's, which would answer with its own port.
 */
function openThroughGatewayProxy(url: string, scope: NodeScope): Promise<void> {
  const openExternal = window.orkestrator?.shell?.openExternal;
  const client = scope.client as Partial<LeafNodeClient>;
  if (scope.role === "leaf" && openExternal && typeof client.resolveLoopbackUrl === "function") {
    return openExternal(client.resolveLoopbackUrl(url));
  }
  return backend.openInBrowser(url);
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
 * be registered. A link from an environment on this computer opens as
 * written. Everything else, and every failure, uses the gateway proxy of the
 * environment's node.
 */
export async function openLinkExternally({
  environmentId,
  sourceTabId,
  url,
  origin = "terminal",
  scope = appCommandScope(),
}: ExternalLinkRequest): Promise<void> {
  if (isLoopbackUrl(url) && isRemoteGatewayConnection() && backendOnThisDevice(scope)) {
    return openAsWritten(url);
  }
  const environment = environmentId
    ? scope.store(environmentStore).getState().getEnvironmentById(environmentId)
    : undefined;
  if (
    !environment ||
    !window.orkestrator?.browserPreview?.openServiceExternally ||
    !isLoopbackUrl(url) ||
    !isRemoteGatewayConnection(scope)
  ) {
    return openThroughGatewayProxy(url, scope);
  }

  ensurePreviewServiceSync(scope);
  const capabilities = await scope
    .store(previewServiceStore)
    .getState()
    .loadCapabilities()
    .catch(() => null);
  if (!capabilities) {
    toast.info("Opened through the gateway proxy", {
      description: "Preview capabilities could not be loaded. This backend may need an update.",
    });
    return openThroughGatewayProxy(url, scope);
  }
  const { access, surfaces } = capabilities;
  if (
    !access.available ||
    (!surfaces.desktopTunnel.available && !surfaces.browserTopLevel.available)
  ) {
    toast.info("Opened through the gateway proxy", {
      description: !access.available
        ? "Turn on Settings → Browser previews → Issue new preview access for this machine to open links at localhost."
        : (surfaces.desktopTunnel.reason ?? "This machine cannot forward services to localhost."),
    });
    return openThroughGatewayProxy(url, scope);
  }

  let resolution: backend.PreviewTargetResolution;
  try {
    resolution = await backendForScope(scope).resolvePreviewTarget({
      intent: { url: url.trim(), source: linkUrlSource(environment, origin), environmentId },
    });
  } catch (error) {
    toast.info("Opened through the gateway proxy", {
      description: `Could not resolve the preview service: ${failureMessage(error)}`,
    });
    return openThroughGatewayProxy(url, scope);
  }
  if (resolution.kind !== "service") {
    requestTerminalBrowserTab({ environmentId, sourceTabId, url, origin });
    return;
  }
  try {
    await openServiceExternally(
      {
        backendInstanceId: capabilities.backendInstanceId,
        environmentId,
        serviceId: resolution.service.definition.serviceId,
        path: resolution.path,
      },
      { scope },
    );
  } catch (error) {
    toast.error("Could not open the service at localhost", {
      description: `${failureMessage(error)} Opened through the gateway proxy instead.`,
    });
    await openThroughGatewayProxy(url, scope);
  }
}
