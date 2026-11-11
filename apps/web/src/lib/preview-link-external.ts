import { previewErrorFromUnknown } from "@orkestrator/protocol/preview-services";
import { toast } from "sonner";

import * as backend from "@/lib/backend";
import { backendOnThisDevice, isRemoteGatewayConnection } from "@/lib/gateway-url";
import { backendForScope } from "@/lib/backend/scope-backend";
import { openServiceExternally } from "@/lib/preview-external";
import { linkUrlSource } from "@/lib/preview-service-entry";
import { isLoopbackUrl, requestTerminalBrowserTab } from "@/lib/terminal-links";
import { hasNativeServiceExternalOpen } from "@/lib/native/browser-preview";
import { shellOpenExternal } from "@/lib/native/shell";
import { externalLoopbackResolver } from "@/lib/node-scope/external-loopback";
import { environmentStore } from "@/stores/environmentStore";
import type { Environment } from "@/types";
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
 * Open a link exactly as written, in this computer's browser. A loopback link
 * from a worktree whose backend runs on this computer already names a port
 * this browser can reach; rewriting it through the command node's gateway
 * would send it to another machine's port, behind a sign-in the external
 * browser does not have.
 */
function openAsWritten(url: string): Promise<void> {
  const openExternal = shellOpenExternal();
  return openExternal ? openExternal(url) : backend.openInBrowser(url);
}

/**
 * The fallback: the loopback link through the gateway proxy of the node that
 * runs the environment. The command node's link goes through the plain opener
 * (which rewrites it onto the window's gateway). A leaf's port is reached only
 * through the leaf's own proxy, on its current route; when the leaf has none,
 * the link is not opened at all rather than sent to the command node, which
 * would answer with its own port.
 */
async function openThroughGatewayProxy(url: string, scope: NodeScope): Promise<void> {
  if (scope.role !== "leaf" || !isLoopbackUrl(url)) return backend.openInBrowser(url);
  const resolve = externalLoopbackResolver(scope.client);
  let proxied: string;
  try {
    if (!resolve) throw new Error("This machine cannot address its ports from here.");
    proxied = await resolve(url);
  } catch (error) {
    toast.error("Could not open the link", { description: failureMessage(error) });
    return;
  }
  const openExternal = shellOpenExternal();
  return openExternal ? openExternal(proxied) : backend.openInBrowser(proxied);
}

/**
 * Whether a loopback link opens as written: the environment's node is this
 * computer and the link names one of this computer's own ports. A container's
 * `localhost` is the container's, published (if at all) on another host port,
 * so a container link still goes through service resolution.
 */
function opensAsWritten(scope: NodeScope, environment: Environment | undefined): boolean {
  if (environment?.environmentType === "containerized") return false;
  return isRemoteGatewayConnection(scope) && backendOnThisDevice(scope);
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
 * be registered. A link from a worktree (or an environment the window does
 * not know) whose node is this computer opens as written; a container's link
 * still resolves to its service. Everything else, and every failure, uses the
 * gateway proxy of the environment's node.
 */
export async function openLinkExternally({
  environmentId,
  sourceTabId,
  url,
  origin = "terminal",
  scope = appCommandScope(),
}: ExternalLinkRequest): Promise<void> {
  const environment = environmentId
    ? scope.store(environmentStore).getState().getEnvironmentById(environmentId)
    : undefined;
  if (isLoopbackUrl(url) && opensAsWritten(scope, environment)) {
    return openAsWritten(url);
  }
  if (
    !environment ||
    !hasNativeServiceExternalOpen() ||
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
