import { createLogger } from "@orkestrator/protocol/logger";
import type {
  BeforeSendResponse,
  HeadersReceivedResponse,
  OnBeforeSendHeadersListenerDetails,
  OnHeadersReceivedListenerDetails,
  WebRequest,
} from "electron";
import { answering } from "./webrequest-listener.js";

const log = createLogger("gateway");

type GatewayRequestDetails = Pick<
  OnBeforeSendHeadersListenerDetails | OnHeadersReceivedListenerDetails,
  "frame" | "resourceType"
>;

export interface RemoteGatewayRequestAuthOptions {
  /**
   * The `Origin` an authorized request presents, instead of the hosted
   * client's. A window's own local backend answers its own origin whatever
   * origins this launch allowed.
   */
  requestOrigin?: (url: string) => string | null | undefined;
}

/**
 * Only the renderer's own main frame authenticates to the gateway. A subframe
 * (an artifact, a design frame, any embedded page) never carries the
 * credential, whatever it navigates to.
 */
function canAttachGatewayAuthorization(details: GatewayRequestDetails): boolean {
  if (details.resourceType === "subFrame") return false;
  return !details.frame?.parent;
}

function withoutAmbientGatewayCredentials(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const normalized = name.toLowerCase();
      return (
        normalized !== "authorization" &&
        normalized !== "cookie" &&
        normalized !== "proxy-authorization"
      );
    }),
  );
}

/** The headers a gateway request is sent with: its credential, or none. */
function gatewayRequestHeaders(
  details: OnBeforeSendHeadersListenerDetails,
  getAuthorization: (url: string, webContentsId?: number) => string | null,
  options: RemoteGatewayRequestAuthOptions,
): Record<string, string> {
  const authorization = getAuthorization(details.url, details.webContentsId);
  if (!authorization) return details.requestHeaders;
  if (!canAttachGatewayAuthorization(details))
    return withoutAmbientGatewayCredentials(details.requestHeaders);
  const requestHeaders = Object.fromEntries(
    Object.entries(details.requestHeaders).filter(([name]) => {
      const normalized = name.toLowerCase();
      return normalized !== "authorization" && normalized !== "origin";
    }),
  );
  return {
    ...requestHeaders,
    Authorization: authorization,
    Origin: options.requestOrigin?.(details.url) ?? "https://orkestrator.dev",
  };
}

/** The response headers an authorized gateway response is read with. */
function gatewayResponseHeaders(
  details: OnHeadersReceivedListenerDetails,
  getAuthorization: (url: string, webContentsId?: number) => string | null,
): Record<string, string[]> | undefined {
  const authorization = getAuthorization(details.url, details.webContentsId);
  if (!authorization || !canAttachGatewayAuthorization(details)) return details.responseHeaders;
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
        responseHeaders: gatewayResponseHeaders(details, getAuthorization),
      }),
      (details) => {
        log.debug("request-auth.fallback", { phase: "response" });
        return { responseHeaders: details.responseHeaders };
      },
    ),
  );
}
