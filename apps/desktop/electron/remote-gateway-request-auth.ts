import type { WebRequest } from "electron";

export function installRemoteGatewayRequestAuth(
  webRequest: Pick<WebRequest, "onBeforeSendHeaders" | "onHeadersReceived">,
  getAuthorization: (url: string) => string | null,
): void {
  const filter = { urls: ["http://*/*", "https://*/*"] };
  webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const authorization = getAuthorization(details.url);
    if (!authorization) {
      callback({ requestHeaders: details.requestHeaders });
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
    if (!authorization) {
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
