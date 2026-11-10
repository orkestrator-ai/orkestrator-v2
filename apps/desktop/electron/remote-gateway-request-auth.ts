import { createLogger } from "@orkestrator/protocol/logger";
import type {
  BeforeSendResponse,
  HeadersReceivedResponse,
  OnBeforeSendHeadersListenerDetails,
  OnHeadersReceivedListenerDetails,
  WebFrameMain,
  WebRequest,
} from "electron";
import { BROWSER_PREVIEW_ENVIRONMENT_HEADER } from "@orkestrator/protocol/browser-preview";
import { answering } from "./webrequest-listener.js";

const log = createLogger("gateway");

const BROWSER_PREVIEW_PREFIX = "/__orkestrator/browser/loopback/";

type GatewayRequestDetails = Pick<
  OnBeforeSendHeadersListenerDetails | OnHeadersReceivedListenerDetails,
  "frame" | "referrer" | "resourceType" | "url" | "webContentsId"
>;

export interface RemoteGatewayRequestAuthOptions {
  /**
   * A session holding only browser-preview views. Requests are authorized
   * only inside the gateway preview namespace of the view that sent them.
   */
  browserPreviewOnly?: boolean;
  /**
   * The URL the app last asked a preview view to load. Its preview namespace
   * is the only one that view's requests may authenticate to; without it a
   * preview-only session authorizes nothing.
   */
  previewViewUrl?: (webContentsId: number | undefined) => string | null | undefined;
  /**
   * The environment the app attached a preview view for. Requests the view
   * authenticates name it, so the gateway opens only that environment's
   * preview targets; without it the gateway refuses them.
   */
  previewViewEnvironment?: (webContentsId: number | undefined) => string | null | undefined;
  /**
   * The `Origin` an authorized request presents, instead of the hosted
   * client's. A window's own local backend answers its own origin whatever
   * origins this launch allowed.
   */
  requestOrigin?: (url: string) => string | null | undefined;
}

/** `<origin>/__orkestrator/browser/loopback/<port>` for a gateway preview URL, else null. */
export function browserPreviewScope(urlValue: string | null | undefined): string | null {
  if (!urlValue) return null;
  try {
    const url = new URL(urlValue);
    const match = /^\/__orkestrator\/browser\/loopback\/([1-9]\d{0,4})(?:\/|$)/.exec(url.pathname);
    if (!match) return null;
    return `${url.origin}${BROWSER_PREVIEW_PREFIX}${match[1]}`;
  } catch {
    return null;
  }
}

function frameBrowserPreviewScope(frame: WebFrameMain | null | undefined): string | null {
  const visited = new Set<WebFrameMain>();
  let current = frame;
  while (current && !visited.has(current)) {
    visited.add(current);
    const scope = browserPreviewScope(current.url);
    if (scope) return scope;
    current = current.parent;
  }
  return null;
}

function previewInitiatorScope(details: GatewayRequestDetails): string | null {
  return frameBrowserPreviewScope(details.frame) ?? browserPreviewScope(details.referrer);
}

function canAttachGatewayAuthorization(
  details: GatewayRequestDetails,
  options: RemoteGatewayRequestAuthOptions,
): boolean {
  const initiatorScope = previewInitiatorScope(details);
  const targetScope = browserPreviewScope(details.url);
  if (options.browserPreviewOnly === true) {
    // Only the port the app opened this view on, so a preview page cannot
    // carry the gateway credential to another port by navigating its own
    // main frame there (security report M2).
    const viewScope = browserPreviewScope(options.previewViewUrl?.(details.webContentsId));
    return (
      targetScope !== null &&
      targetScope === viewScope &&
      (details.resourceType === "mainFrame" || targetScope === initiatorScope)
    );
  }
  if (initiatorScope) return targetScope === initiatorScope;
  // A new browser preview is the only gateway navigation an untrusted subframe
  // may authenticate. All privileged APIs remain main-renderer-only even if the
  // frame has already navigated away from its preview URL.
  if (details.resourceType === "subFrame") return targetScope !== null;
  if (details.frame?.parent) return false;
  return true;
}

function withoutAmbientGatewayCredentials(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const normalized = name.toLowerCase();
      return (
        normalized !== "authorization" &&
        normalized !== "cookie" &&
        normalized !== "proxy-authorization" &&
        normalized !== BROWSER_PREVIEW_ENVIRONMENT_HEADER
      );
    }),
  );
}

/** Only main names a preview's environment; a page's own copy never reaches the gateway. */
function withoutPreviewEnvironment(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name.toLowerCase() !== BROWSER_PREVIEW_ENVIRONMENT_HEADER,
    ),
  );
}

/** The headers a gateway request is sent with: its credential, or none. */
function gatewayRequestHeaders(
  details: OnBeforeSendHeadersListenerDetails,
  getAuthorization: (url: string, webContentsId?: number) => string | null,
  options: RemoteGatewayRequestAuthOptions,
): Record<string, string> {
  const authorization = getAuthorization(details.url, details.webContentsId);
  if (!authorization) return withoutPreviewEnvironment(details.requestHeaders);
  if (!canAttachGatewayAuthorization(details, options))
    return withoutAmbientGatewayCredentials(details.requestHeaders);
  const requestHeaders = Object.fromEntries(
    Object.entries(withoutPreviewEnvironment(details.requestHeaders)).filter(([name]) => {
      const normalized = name.toLowerCase();
      return normalized !== "authorization" && normalized !== "origin";
    }),
  );
  const environmentId =
    options.browserPreviewOnly === true
      ? options.previewViewEnvironment?.(details.webContentsId)
      : null;
  return {
    ...requestHeaders,
    Authorization: authorization,
    Origin: options.requestOrigin?.(details.url) ?? "https://orkestrator.dev",
    ...(environmentId ? { [BROWSER_PREVIEW_ENVIRONMENT_HEADER]: environmentId } : {}),
  };
}

/** The response headers an authorized gateway response is read with. */
function gatewayResponseHeaders(
  details: OnHeadersReceivedListenerDetails,
  getAuthorization: (url: string, webContentsId?: number) => string | null,
  options: RemoteGatewayRequestAuthOptions,
): Record<string, string[]> | undefined {
  const authorization = getAuthorization(details.url, details.webContentsId);
  if (!authorization || !canAttachGatewayAuthorization(details, options))
    return details.responseHeaders;
  const responseHeaders = Object.fromEntries(
    Object.entries(details.responseHeaders ?? {}).filter(
      ([name]) => name.toLowerCase() !== "access-control-allow-origin",
    ),
  );
  return { ...responseHeaders, "Access-Control-Allow-Origin": ["*"] };
}

/**
 * Both listeners always call back (`answering`). A listener that throws never
 * does: its request stays unanswered and main gets an uncaught exception. A
 * session outlives its window, so a closed window's last requests reach these
 * hooks after its connection was released (flake 0622). A failed lookup sends
 * the request with no credential, and reads the response as it came.
 */
export function installRemoteGatewayRequestAuth(
  webRequest: Pick<WebRequest, "onBeforeSendHeaders" | "onHeadersReceived">,
  getAuthorization: (url: string, webContentsId?: number) => string | null,
  options: RemoteGatewayRequestAuthOptions = {},
): void {
  const filter = { urls: ["http://*/*", "https://*/*"] };
  webRequest.onBeforeSendHeaders(
    filter,
    answering<OnBeforeSendHeadersListenerDetails, BeforeSendResponse>(
      "gateway-request-auth.before-send-headers",
      (details) => ({
        requestHeaders: gatewayRequestHeaders(details, getAuthorization, options),
      }),
      (details) => {
        // Do not log the exception: option callbacks may put URLs or credentials in it.
        log.debug("request-auth.fallback", { phase: "request" });
        return { requestHeaders: withoutAmbientGatewayCredentials(details.requestHeaders) };
      },
    ),
  );
  webRequest.onHeadersReceived(
    filter,
    answering<OnHeadersReceivedListenerDetails, HeadersReceivedResponse>(
      "gateway-request-auth.headers-received",
      (details) => ({
        responseHeaders: gatewayResponseHeaders(details, getAuthorization, options),
      }),
      (details) => {
        log.debug("request-auth.fallback", { phase: "response" });
        return { responseHeaders: details.responseHeaders };
      },
    ),
  );
}
