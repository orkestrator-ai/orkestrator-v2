import type {
  OnBeforeSendHeadersListenerDetails,
  OnHeadersReceivedListenerDetails,
  WebFrameMain,
  WebRequest,
} from "electron";

const BROWSER_PREVIEW_PREFIX = "/__orkestrator/browser/loopback/";

type GatewayRequestDetails = Pick<
  OnBeforeSendHeadersListenerDetails | OnHeadersReceivedListenerDetails,
  "frame" | "referrer" | "resourceType" | "url"
>;

function browserPreviewScope(urlValue: string | undefined): string | null {
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

function canAttachGatewayAuthorization(details: GatewayRequestDetails, browserPreviewOnly: boolean): boolean {
  const initiatorScope = previewInitiatorScope(details);
  const targetScope = browserPreviewScope(details.url);
  if (browserPreviewOnly) {
    return targetScope !== null && (!initiatorScope || targetScope === initiatorScope);
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
      return normalized !== "authorization"
        && normalized !== "cookie"
        && normalized !== "proxy-authorization";
    }),
  );
}

export function installRemoteGatewayRequestAuth(
  webRequest: Pick<WebRequest, "onBeforeSendHeaders" | "onHeadersReceived">,
  getAuthorization: (url: string) => string | null,
  options: { browserPreviewOnly?: boolean } = {},
): void {
  const filter = { urls: ["http://*/*", "https://*/*"] };
  webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const authorization = getAuthorization(details.url);
    if (!authorization) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    if (!canAttachGatewayAuthorization(details, options.browserPreviewOnly === true)) {
      callback({ requestHeaders: withoutAmbientGatewayCredentials(details.requestHeaders) });
      return;
    }
    const requestHeaders = Object.fromEntries(
      Object.entries(details.requestHeaders).filter(([name]) => {
        const normalized = name.toLowerCase();
        return normalized !== "authorization" && normalized !== "origin";
      }),
    );
    callback({
      requestHeaders: {
        ...requestHeaders,
        Authorization: authorization,
        Origin: "https://orkestrator.dev",
      },
    });
  });
  webRequest.onHeadersReceived(filter, (details, callback) => {
    const authorization = getAuthorization(details.url);
    if (!authorization || !canAttachGatewayAuthorization(details, options.browserPreviewOnly === true)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const responseHeaders = Object.fromEntries(
      Object.entries(details.responseHeaders ?? {}).filter(([name]) => name.toLowerCase() !== "access-control-allow-origin"),
    );
    callback({
      responseHeaders: {
        ...responseHeaders,
        "Access-Control-Allow-Origin": ["*"],
      },
    });
  });
}
